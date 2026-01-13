import { Router } from "express";
import pool from "../../db/index";

const router = Router();

const NAMESPACE = "rfp_chunks";
const TARGET_COLLECTION = "rfp_chunks__bge_small_en_v1_5__384";

// Defaults assume docker-compose/local
const TEI_URL = process.env.TEI_URL ?? "http://localhost:8081";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";

/**
 * TEI embed call
 * Text Embeddings Inference typically supports POST /embed with { inputs: string[] }
 * Returns: number[][]
 */
async function embedTexts(texts: string[]): Promise<number[][]> {
  // Helper: try embed once
  async function tryEmbed(inputs: string[]): Promise<number[][]> {
    const resp = await fetch(`${TEI_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `TEI embed failed: ${resp.status} ${resp.statusText} ${detail}`
      );
    }

    const data = (await resp.json()) as number[][];
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(
        `TEI embed returned unexpected shape (expected ${inputs.length} vectors)`
      );
    }
    return data;
  }

  // First attempt for whole batch
  try {
    return await tryEmbed(texts);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const isTooLarge =
      msg.includes("413") ||
      msg.toLowerCase().includes("payload too large") ||
      msg.toLowerCase().includes("must have less than 512 tokens");

    if (!isTooLarge) throw e;
  }

  // Fallback: embed one-by-one with splitting until it fits
  const results: number[][] = [];
  for (const t of texts) {
    let s = (t ?? "").trim();

    // progressively shrink by halves if TEI rejects
    while (true) {
      try {
        const [vec] = await tryEmbed([s]);
        results.push(vec);
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const isTooLarge =
          msg.includes("413") ||
          msg.toLowerCase().includes("payload too large") ||
          msg.toLowerCase().includes("must have less than 512 tokens");

        if (!isTooLarge) throw e;

        // shrink: take first half; if already tiny, just hard-cap
        if (s.length <= 600) {
          s = s.slice(0, 600);
        } else {
          s = s.slice(0, Math.floor(s.length * 0.5));
        }
      }
    }
  }

  return results;
}

/**
 * Ensure Qdrant collection exists with correct vector size.
 * If missing, create it.
 */
async function ensureQdrantCollection(collection: string, vectorSize: number) {
  const headers: Record<string, string> = {};
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;

  // Check
  const getResp = await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "GET",
    headers,
  });

  if (getResp.ok) return;

  if (getResp.status !== 404) {
    const detail = await getResp.text().catch(() => "");
    throw new Error(
      `Qdrant collection check failed: ${getResp.status} ${getResp.statusText} ${detail}`
    );
  }

  // Create
  const createResp = await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    }),
  });

  if (!createResp.ok) {
    const detail = await createResp.text().catch(() => "");
    throw new Error(
      `Qdrant collection create failed: ${createResp.status} ${createResp.statusText} ${detail}`
    );
  }
}

/**
 * Upsert points to Qdrant
 */
async function qdrantUpsert(
  collection: string,
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, any>;
  }>
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;

  const resp = await fetch(
    `${QDRANT_URL}/collections/${collection}/points?wait=true`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ points }),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `Qdrant upsert failed: ${resp.status} ${resp.statusText} ${detail}`
    );
  }
}

router.post("/rfp-chunks/start", async (_req, res) => {
  const namespace = NAMESPACE;
  const qdrant_collection = TARGET_COLLECTION;
  const embedding_model_id = "BAAI/bge-small-en-v1.5";
  const embedding_dim = 384;
  const embedding_provider = "tei";

  // Ensure collection exists BEFORE we start ticking
  await ensureQdrantCollection(qdrant_collection, embedding_dim);

  let vectorIndexId: number;

  const existing = await pool.query(
    `
    SELECT id
    FROM vector_indexes
    WHERE namespace = $1
      AND qdrant_collection = $2
    LIMIT 1
    `,
    [namespace, qdrant_collection]
  );

  if (existing.rows.length > 0) {
    vectorIndexId = existing.rows[0].id;
  } else {
    const created = await pool.query(
      `
      INSERT INTO vector_indexes (
        namespace,
        qdrant_collection,
        embedding_model_id,
        embedding_dim,
        embedding_provider,
        status,
        is_active,
        chunks_total,
        chunks_done
      ) VALUES (
        $1, $2, $3, $4, $5,
        'building',
        false,
        0,
        0
      )
      RETURNING id
      `,
      [
        namespace,
        qdrant_collection,
        embedding_model_id,
        embedding_dim,
        embedding_provider,
      ]
    );

    vectorIndexId = created.rows[0].id;
  }

  // Reset to a fresh build state (safe to re-run)
  await pool.query(
    `
  UPDATE vector_indexes
  SET
    status = 'building',
    built_at = NULL,
    chunks_done = 0,
    last_rfp_id = NULL,
    last_chunk_index = NULL,
    last_chunk_id = NULL,
    error_message = NULL
  WHERE id = $1
  `,
    [vectorIndexId]
  );

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rfp_chunks`
  );
  const chunks_total = totalRes.rows[0].total;

  const updated = await pool.query(
    `
    UPDATE vector_indexes
    SET chunks_total = $2
    WHERE id = $1
    RETURNING
      id, namespace, qdrant_collection, status, is_active,
      chunks_total, chunks_done, last_rfp_id, last_chunk_index, last_chunk_id
    `,
    [vectorIndexId, chunks_total]
  );

  return res.json({ ok: true, vector_index: updated.rows[0] });
});

/**
 * POST /admin/reindex/rfp-chunks/tick
 * Advances the building index by ONE batch:
 * - loads next chunks
 * - embeds them via TEI
 * - upserts to Qdrant
 * - updates cursor + chunks_done
 *
 * Body: { batchSize?: number }
 */
router.post("/rfp-chunks/tick", async (req, res) => {
  const batchSize =
    typeof req.body?.batchSize === "number" ? req.body.batchSize : 100;

  // 1) Load the building index row (with composite cursor)
  const idxRes = await pool.query(
    `
    SELECT id, status, chunks_total, chunks_done, last_rfp_id, last_chunk_index, last_chunk_id
    FROM vector_indexes
    WHERE namespace = $1
      AND qdrant_collection = $2
    LIMIT 1
    `,
    [NAMESPACE, TARGET_COLLECTION]
  );

  if (idxRes.rows.length === 0) {
    return res
      .status(404)
      .json({ error: "No vector index row found. Run start first." });
  }

  const idx = idxRes.rows[0] as {
    id: number;
    status: string;
    chunks_total: number | null;
    chunks_done: number;
    last_rfp_id: string | null; // uuid
    last_chunk_index: number | null; // int
    last_chunk_id: string | null; // uuid
  };

  if (idx.status !== "building") {
    return res
      .status(400)
      .json({ error: `Index status is '${idx.status}', not 'building'.` });
  }

  // 2) Fetch next batch (INCLUDING text) using composite cursor
  const chunksRes = await pool.query(
    `
    SELECT rfp_id, chunk_index, id, text
    FROM rfp_chunks
    WHERE
      ($1::uuid IS NULL)
      OR (rfp_id, chunk_index, id) > ($1::uuid, $2::int, $3::uuid)
    ORDER BY rfp_id ASC, chunk_index ASC, id ASC
    LIMIT $4
    `,
    [
      idx.last_rfp_id,
      idx.last_chunk_index ?? 0,
      idx.last_chunk_id ?? "00000000-0000-0000-0000-000000000000",
      batchSize,
    ]
  );

  const batch = chunksRes.rows as {
    rfp_id: string;
    chunk_index: number;
    id: string;
    text: string;
  }[];

  // 3) If no more chunks, mark ready
  if (batch.length === 0) {
    const doneRes = await pool.query(
      `
      UPDATE vector_indexes
      SET status = 'ready', built_at = now()
      WHERE id = $1
      RETURNING id, status, chunks_total, chunks_done, last_rfp_id, last_chunk_index, last_chunk_id
      `,
      [idx.id]
    );

    return res.json({
      ok: true,
      finished: true,
      vector_index: doneRes.rows[0],
    });
  }

  // 4) Embed
  // TEI input limit protection: keep inputs short enough to avoid 413/token-limit errors.
  // This is a quick safety valve; later we'll enforce chunk sizing at chunking time.
  const MAX_CHARS = 1800; // conservative for 512-token limit (varies by content)
  const texts = batch.map((b) => (b.text ?? "").slice(0, MAX_CHARS));
  const vectors = await embedTexts(texts);

  // 5) Upsert into Qdrant
  const points = batch.map((b, i) => ({
    id: b.id, // UUID string is valid point id in Qdrant
    vector: vectors[i],
    payload: {
      namespace: NAMESPACE,
      rfp_id: b.rfp_id,
      chunk_index: b.chunk_index,
      chunk_id: b.id,
      // Optional: keep text out of payload if you prefer; but it can be handy for debugging.
      // text: b.text,
    },
  }));

  await qdrantUpsert(TARGET_COLLECTION, points);

  // 6) Advance cursor + progress
  const last = batch[batch.length - 1];
  const newDone = idx.chunks_done + batch.length;

  const updatedRes = await pool.query(
    `
    UPDATE vector_indexes
    SET
      last_rfp_id = $2::uuid,
      last_chunk_index = $3::int,
      last_chunk_id = $4::uuid,
      chunks_done = $5
    WHERE id = $1
    RETURNING id, status, chunks_total, chunks_done, last_rfp_id, last_chunk_index, last_chunk_id
    `,
    [idx.id, last.rfp_id, last.chunk_index, last.id, newDone]
  );

  return res.json({
    ok: true,
    finished: false,
    processed: batch.length,
    batchSize,
    vector_index: updatedRes.rows[0],
  });
});

/**
 * POST /admin/reindex/rfp-chunks/activate
 * Makes the TARGET_COLLECTION the active index (only if status='ready').
 */
router.post("/rfp-chunks/activate", async (_req, res) => {
  // 1) confirm target is ready
  const targetRes = await pool.query(
    `
    SELECT id, status
    FROM vector_indexes
    WHERE namespace = $1 AND qdrant_collection = $2
    LIMIT 1
    `,
    [NAMESPACE, TARGET_COLLECTION]
  );

  if (targetRes.rows.length === 0) {
    return res.status(404).json({ error: "Target index row not found." });
  }

  const target = targetRes.rows[0] as { id: number; status: string };

  if (target.status !== "ready") {
    return res.status(400).json({
      error: `Target index must be 'ready' to activate (currently '${target.status}').`,
    });
  }

  // 2) transaction: deactivate current + activate target
  await pool.query("BEGIN");
  try {
    await pool.query(
      `
      UPDATE vector_indexes
      SET is_active = false
      WHERE namespace = $1 AND is_active = true
      `,
      [NAMESPACE]
    );

    const activatedRes = await pool.query(
      `
      UPDATE vector_indexes
      SET is_active = true
      WHERE id = $1
      RETURNING id, namespace, qdrant_collection, status, is_active
      `,
      [target.id]
    );

    await pool.query("COMMIT");

    return res.json({ ok: true, active: activatedRes.rows[0] });
  } catch (e: any) {
    await pool.query("ROLLBACK");
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;

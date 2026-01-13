import { Router } from "express";
import pool from "../../../db/index";

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

  const results: number[][] = [];
  for (const t of texts) {
    let s = (t ?? "").trim();

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

        if (s.length <= 600) s = s.slice(0, 600);
        else s = s.slice(0, Math.floor(s.length * 0.5));
      }
    }
  }

  return results;
}

/**
 * Ensure Qdrant collection exists with correct vector size.
 */
async function ensureQdrantCollection(collection: string, vectorSize: number) {
  const headers: Record<string, string> = {};
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;

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

  const createResp = await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      vectors: { size: vectorSize, distance: "Cosine" },
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

/**
 * POST /rfps/:id/index
 * Index ONLY this RFP's chunks into Qdrant.
 *
 * Body: { batchSize?: number }
 * - Runs in batches to avoid huge TEI payloads.
 * - Returns progress + done flag.
 */
router.post("/:id/index", async (req, res) => {
  const { id: rfpId } = req.params;

  const batchSize =
    typeof req.body?.batchSize === "number" ? req.body.batchSize : 100;

  // Ensure RFP exists
  const rfpRes = await pool.query(`SELECT id FROM rfps WHERE id = $1 LIMIT 1`, [
    rfpId,
  ]);
  if (rfpRes.rowCount === 0) {
    return res.status(404).json({ ok: false, error: "RFP not found" });
  }

  // Ensure collection exists (384 dims for bge-small-en-v1.5)
  await ensureQdrantCollection(TARGET_COLLECTION, 384);

  // Pull next batch of chunks for this RFP that are NOT yet in Qdrant (best-effort)
  // We'll determine "already indexed" by presence of a row in qdrant payload? We don't store that in PG,
  // so simplest is: just upsert all chunks. Qdrant upsert is idempotent.
  const chunksRes = await pool.query(
    `
    SELECT id, rfp_id, chunk_index, text
    FROM rfp_chunks
    WHERE rfp_id = $1
    ORDER BY chunk_index ASC, id ASC
    LIMIT $2
    `,
    [rfpId, batchSize]
  );

  const batch = chunksRes.rows as {
    id: string;
    rfp_id: string;
    chunk_index: number;
    text: string;
  }[];

  if (batch.length === 0) {
    return res.json({
      ok: true,
      done: true,
      processed: 0,
      message: "No chunks found for this RFP",
    });
  }

  // Embed (protect TEI input size)
  const MAX_CHARS = 1800;
  const texts = batch.map((b) => (b.text ?? "").slice(0, MAX_CHARS));
  const vectors = await embedTexts(texts);

  // Upsert
  const points = batch.map((b, i) => ({
    id: b.id,
    vector: vectors[i],
    payload: {
      namespace: NAMESPACE,
      rfp_id: b.rfp_id,
      chunk_index: b.chunk_index,
      chunk_id: b.id,
    },
  }));

  await qdrantUpsert(TARGET_COLLECTION, points);

  // Update RFP as indexed (this is your critical flag for extract-metadata guards)
  await pool.query(
    `
    UPDATE rfps
    SET qdrant_indexed_at = now(), updated_at = now()
    WHERE id = $1
    `,
    [rfpId]
  );

  // Optional: also update chunk_count if your /process didn't
  await pool.query(
    `
    UPDATE rfps
    SET chunk_count = (SELECT COUNT(*) FROM rfp_chunks WHERE rfp_id = $1)
    WHERE id = $1
    `,
    [rfpId]
  );

  return res.json({
    ok: true,
    done: batch.length < batchSize, // crude: if we got less than requested, likely finished
    processed: batch.length,
    batchSize,
    rfp_id: rfpId,
    collection: TARGET_COLLECTION,
  });
});

export default router;

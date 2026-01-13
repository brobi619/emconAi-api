// NOTE: This route is RFP-specific and may move to src/modules/rfps/routes
// once search is fully modularized.

import { Router } from "express";
import pool from "../../db/index";

const router = Router();

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";
const TEI_URL = process.env.TEI_URL ?? "http://localhost:8081";

async function embedOne(text: string): Promise<number[]> {
  const resp = await fetch(`${TEI_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [text] }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `TEI embed failed: ${resp.status} ${resp.statusText} ${detail}`
    );
  }

  const data = (await resp.json()) as number[][];
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0])) {
    throw new Error("TEI embed returned unexpected response shape");
  }

  return data[0];
}

async function qdrantSearch(
  collection: string,
  vector: number[],
  limit: number,
  rfpId?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;

  const body: any = {
    vector,
    limit,
    with_payload: true,
  };

  if (rfpId) {
    body.filter = {
      must: [
        {
          key: "rfp_id",
          match: { value: rfpId },
        },
      ],
    };
  }

  const resp = await fetch(
    `${QDRANT_URL}/collections/${collection}/points/search`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `Qdrant search failed: ${resp.status} ${resp.statusText} ${detail}`
    );
  }

  return resp.json();
}

/**
 * POST /search/rfp-chunks
 * Body: { query: string, limit?: number, rfp_id?: string }
 */
router.post("/rfp-chunks", async (req, res) => {
  try {
    const query = String(req.body?.query ?? "").trim();
    const limit = typeof req.body?.limit === "number" ? req.body.limit : 5;
    const rfp_id = req.body?.rfp_id
      ? String(req.body.rfp_id).trim()
      : undefined;

    if (!query) return res.status(400).json({ error: "query is required" });

    // 1) Load active index metadata
    const idxRes = await pool.query(
      `
      SELECT qdrant_collection, embedding_dim, embedding_model_id
      FROM vector_indexes
      WHERE namespace = 'rfp_chunks' AND is_active = true AND status = 'ready'
      LIMIT 1
      `
    );

    if (idxRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No active rfp_chunks vector index." });
    }

    const active = idxRes.rows[0] as {
      qdrant_collection: string;
      embedding_dim: number;
      embedding_model_id: string;
    };

    // 2) Embed query text
    const vector = await embedOne(query);

    // 3) Sanity check embedding dim
    if (vector.length !== active.embedding_dim) {
      return res.status(500).json({
        error: "Embedding dimension mismatch",
        expected: active.embedding_dim,
        got: vector.length,
        embedding_model_id: active.embedding_model_id,
      });
    }

    // 4) Search Qdrant (optionally scoped to a single rfp_id)
    const results = await qdrantSearch(
      active.qdrant_collection,
      vector,
      limit,
      rfp_id
    );

    // 5) Extract chunk_ids in result order
    const hits = Array.isArray(results?.result) ? results.result : [];
    const chunkIds: string[] = hits
      .map((h: any) => h?.payload?.chunk_id)
      .filter((v: any) => typeof v === "string");

    if (chunkIds.length === 0) {
      return res.json({
        ok: true,
        active_collection: active.qdrant_collection,
        embedding_model_id: active.embedding_model_id,
        rfp_id: rfp_id ?? null,
        matches: [],
      });
    }

    // 6) Join back to Postgres for full chunk text (preserve hit order)
    const chunksRes = await pool.query(
      `
      SELECT id, rfp_id, chunk_index, section_title, text
      FROM rfp_chunks
      WHERE id = ANY($1::uuid[])
      ORDER BY array_position($1::uuid[], id)
      `,
      [chunkIds]
    );

    const chunkById = new Map<string, any>();
    for (const row of chunksRes.rows) chunkById.set(row.id, row);

    const matches = hits.map((h: any) => {
      const chunk_id = h?.payload?.chunk_id;
      const row = chunkById.get(chunk_id);

      return {
        score: h?.score ?? null,
        chunk_id,
        rfp_id: row?.rfp_id ?? h?.payload?.rfp_id ?? null,
        chunk_index: row?.chunk_index ?? h?.payload?.chunk_index ?? null,
        section_title: row?.section_title ?? null,
        text: row?.text ?? null,
      };
    });

    return res.json({
      ok: true,
      active_collection: active.qdrant_collection,
      embedding_model_id: active.embedding_model_id,
      rfp_id: rfp_id ?? null,
      matches,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

export default router;

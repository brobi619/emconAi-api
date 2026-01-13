import { Router } from "express";
import pool from "../../../db";
import { getOpenAIClient } from "../../../lib/openaiClient";
import { RFP_UNDERSTANDING_PROMPT_V1 } from "../prompts/rfp_understanding_v1";

type UnderstandingResponse =
  | { schema_version: "1.0"; [k: string]: any }
  | { error: string };

function safeParseJson(text: string): any {
  return JSON.parse((text ?? "").trim());
}

type ChunkRow = {
  id: string;
  chunk_index: number;
  section_title: string | null;
  text: string;
};

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function buildUnderstandingContextForRfp(rfpId: string): Promise<string> {
  // Grab early chunks (cover pages + summary) + some keyword-heavy chunks
  const firstRes = await pool.query(
    `
    SELECT id, chunk_index, section_title, left(text, 2000) as text
    FROM rfp_chunks
    WHERE rfp_id = $1
    ORDER BY chunk_index ASC
    LIMIT 16
    `,
    [rfpId]
  );

  const kwRes = await pool.query(
    `
    SELECT id, chunk_index, section_title, left(text, 2000) as text
    FROM rfp_chunks
    WHERE rfp_id = $1
      AND (
        text ILIKE '%scope%'
        OR text ILIKE '%statement of work%'
        OR text ILIKE '%section c%'
        OR text ILIKE '%section l%'
        OR text ILIKE '%section m%'
        OR text ILIKE '%evaluation%'
        OR text ILIKE '%instructions%'
        OR text ILIKE '%submission%'
        OR text ILIKE '%naics%'
        OR text ILIKE '%set-aside%'
        OR text ILIKE '%set aside%'
        OR text ILIKE '%due%'
        OR text ILIKE '%deadline%'
        OR text ILIKE '%page limit%'
        OR text ILIKE '%font%'
        OR text ILIKE '%spacing%'
        OR text ILIKE '%security%'
        OR text ILIKE '%clearance%'
        OR text ILIKE '%cmmc%'
        OR text ILIKE '%rmf%'
      )
    ORDER BY chunk_index ASC
    LIMIT 20
    `,
    [rfpId]
  );

  const chunks = dedupeById<ChunkRow>([
    ...(firstRes.rows as ChunkRow[]),
    ...(kwRes.rows as ChunkRow[]),
  ]);

  if (chunks.length === 0) {
    return `RFP_ID: ${rfpId}\n\nNo chunks found for this RFP.`;
  }

  const parts = chunks.map((c) => {
    const header = `CHUNK ${c.chunk_index} (${c.section_title ?? "UNKNOWN"}) [${
      c.id
    }]`;
    return `${header}\n${c.text}`;
  });

  return [
    `RFP_ID: ${rfpId}`,
    `INSTRUCTIONS: Use ONLY the RFP chunks below. If not present, return "" or [].`,
    ``,
    ...parts,
  ].join("\n\n---\n\n");
}

export const understandRfpRouter = Router();

/**
 * POST /rfps/:rfpId/understand
 * Body: { force?: boolean, prompt_version?: "rfp_understanding_v1", user_id?: uuid }
 */
understandRfpRouter.post("/:rfpId/understand", async (req, res) => {
  const { rfpId } = req.params;
  const force = Boolean(req.body?.force);
  const promptVersion = (req.body?.prompt_version ??
    "rfp_understanding_v1") as string;

  if (promptVersion !== "rfp_understanding_v1") {
    return res
      .status(400)
      .json({ ok: false, error: "Unsupported prompt_version" });
  }

  // TEMP until auth exists
  const userId =
    req.body?.user_id ??
    process.env.SYSTEM_USER_ID ??
    "00000000-0000-0000-0000-000000000001";

  try {
    // Guard: must be chunked + indexed (consistent with your pipeline)
    const rfpRes = await pool.query(
      `
      SELECT id, chunk_count, qdrant_indexed_at
      FROM rfps
      WHERE id = $1
      LIMIT 1
      `,
      [rfpId]
    );

    if (rfpRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "RFP not found" });
    }

    const rfp = rfpRes.rows[0] as {
      id: string;
      chunk_count: number | null;
      qdrant_indexed_at: string | null;
    };

    const chunkCount = rfp.chunk_count ?? 0;
    if (!rfp.qdrant_indexed_at || chunkCount <= 0) {
      return res.status(409).json({
        ok: false,
        error: "RFP not indexed yet (need chunking + qdrant indexing complete)",
        details: {
          chunk_count: chunkCount,
          qdrant_indexed_at: rfp.qdrant_indexed_at,
        },
      });
    }

    // Skip if already exists (unless force)
    if (!force) {
      const existing = await pool.query(
        `
        SELECT id
        FROM rfp_analyses
        WHERE rfp_id = $1 AND prompt_version = 'rfp_understanding_v1'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [rfpId]
      );
      if (existing.rowCount > 0) {
        return res.json({
          ok: true,
          rfp_id: rfpId,
          skipped: true,
          reason: "already_understood",
        });
      }
    }

    // Build context
    const ragContext = await buildUnderstandingContextForRfp(rfpId);

    // Call OpenAI
    const openai = getOpenAIClient();
    const model = process.env.PROJECT_DESCRIPTION_OPEN_AI_MODEL || "gpt-5-mini";

    const completion = await openai.chat.completions.create({
      model,
      temperature: 1, // extraction-style; keep stable
      messages: [
        { role: "system", content: RFP_UNDERSTANDING_PROMPT_V1 },
        { role: "user", content: ragContext },
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    let parsed: UnderstandingResponse;

    try {
      parsed = safeParseJson(text);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Model returned non-JSON",
        raw: text.slice(0, 2000),
      });
    }

    if ((parsed as any)?.error) {
      return res.status(502).json({ ok: false, error: (parsed as any).error });
    }

    // Store as an analysis row (prompt_version distinguishes it)
    const inserted = await pool.query(
      `
      INSERT INTO rfp_analyses (rfp_id, prompt_version, model, analysis_json, created_by_user_id)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING id
      `,
      [rfpId, "rfp_understanding_v1", model, parsed, userId]
    );

    return res.json({
      ok: true,
      rfp_id: rfpId,
      understanding_id: inserted.rows[0].id,
      prompt_version: "rfp_understanding_v1",
      model,
    });
  } catch (err: any) {
    console.error("understand error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message ?? "Unknown error" });
  }
});

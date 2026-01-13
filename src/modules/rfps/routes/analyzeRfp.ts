import { Router } from "express";
import pool from "../../../db";
import { getOpenAIClient } from "../../../lib/openaiClient";
import { ANALYSIS_PROMPT_V1 } from "../prompts/analysis_v1";

type AnalysisResponse =
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

/**
 * Build context for analysis:
 * - first N chunks (covers cover pages + summary)
 * - plus targeted keyword pulls likely to include L/M, submission, evaluation, dates
 */
async function buildAnalysisContextForRfp(rfpId: string): Promise<string> {
  const firstRes = await pool.query(
    `
    SELECT id, chunk_index, section_title, left(text, 2000) as text
    FROM rfp_chunks
    WHERE rfp_id = $1
    ORDER BY chunk_index ASC
    LIMIT 14
    `,
    [rfpId]
  );

  const kwRes = await pool.query(
    `
    SELECT id, chunk_index, section_title, left(text, 2000) as text
    FROM rfp_chunks
    WHERE rfp_id = $1
      AND (
        text ILIKE '%evaluation%'
        OR text ILIKE '%section m%'
        OR text ILIKE '%section l%'
        OR text ILIKE '%instructions to offerors%'
        OR text ILIKE '%proposal%'
        OR text ILIKE '%submission%'
        OR text ILIKE '%due%'
        OR text ILIKE '%deadline%'
        OR text ILIKE '%naics%'
        OR text ILIKE '%set-aside%'
        OR text ILIKE '%set aside%'
        OR text ILIKE '%page limit%'
        OR text ILIKE '%font%'
        OR text ILIKE '%spacing%'
        OR text ILIKE '%security%'
        OR text ILIKE '%cmmc%'
        OR text ILIKE '%rmf%'
        OR text ILIKE '%clearance%'
      )
    ORDER BY chunk_index ASC
    LIMIT 22
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
    `INSTRUCTIONS: Use ONLY the RFP chunks below as authoritative. If something is not present, use "" or [].`,
    ``,
    ...parts,
  ].join("\n\n---\n\n");
}

async function tableExists(tableName: string): Promise<boolean> {
  const r = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists
    `,
    [tableName]
  );
  return Boolean(r.rows?.[0]?.exists);
}

export const analyzeRfpRouter = Router();

/**
 * POST /rfps/:rfpId/analyze
 * Body: { force?: boolean, prompt_version?: "analysis_v1" }
 */
analyzeRfpRouter.post("/:rfpId/analyze", async (req, res) => {
  const { rfpId } = req.params;
  const force = Boolean(req.body?.force);
  const promptVersion = (req.body?.prompt_version ?? "analysis_v1") as string;

  if (promptVersion !== "analysis_v1") {
    return res
      .status(400)
      .json({ ok: false, error: "Unsupported prompt_version" });
  }

  // TEMP until auth exists
  const userId = req.body?.user_id ?? null;

  try {
    // 1) Guard: must be chunked + indexed
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

    // 2) Skip if already analyzed (unless force)
    const hasAnalysesTable = await tableExists("rfp_analyses");
    if (!force && hasAnalysesTable) {
      const existing = await pool.query(
        `
        SELECT id
        FROM rfp_analyses
        WHERE rfp_id = $1
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
          reason: "already_analyzed",
        });
      }
    }

    // 3) Build context
    const ragContext = await buildAnalysisContextForRfp(rfpId);

    // 4) Call OpenAI
    const openai = getOpenAIClient();
    const model = process.env.PROJECT_DESCRIPTION_OPEN_AI_MODEL || "gpt-5-mini";

    const completion = await openai.chat.completions.create({
      model,
      temperature: 1, // default for gpt 5 mini
      messages: [
        { role: "system", content: ANALYSIS_PROMPT_V1 },
        { role: "user", content: ragContext },
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    let parsed: AnalysisResponse;

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

    // 5) Store result
    if (hasAnalysesTable) {
      const inserted = await pool.query(
        `
        INSERT INTO rfp_analyses (rfp_id, prompt_version, model, analysis_json, created_by_user_id)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING id
        `,
        [rfpId, "analysis_v1", model, parsed, userId]
      );

      return res.json({
        ok: true,
        rfp_id: rfpId,
        analysis_id: inserted.rows[0].id,
        prompt_version: "analysis_v1",
        model,
      });
    }

    // Fallback if rfp_analyses table doesn't exist: store on rfps.extracted_fields_json.analysis_json
    await pool.query(
      `
      UPDATE rfps
      SET extracted_fields_json =
            COALESCE(extracted_fields_json, '{}'::jsonb) ||
            jsonb_build_object('analysis_json', $2::jsonb, 'analysis_prompt_version', $3, 'analysis_model', $4),
          updated_at = now(),
          updated_by_user_id = COALESCE($5, updated_by_user_id)
      WHERE id = $1
      `,
      [rfpId, parsed, "analysis_v1", model, userId]
    );

    return res.json({
      ok: true,
      rfp_id: rfpId,
      stored: "rfps.extracted_fields_json.analysis_json",
      prompt_version: "analysis_v1",
      model,
    });
  } catch (err: any) {
    console.error("analyze error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message ?? "Unknown error" });
  }
});

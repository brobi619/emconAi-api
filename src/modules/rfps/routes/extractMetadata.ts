import { Router } from "express";
import pool from "../../../db";
import { META_PROMPT_V1 } from "../prompts/meta_v1";
import { getOpenAIClient } from "../../../lib/openaiClient";

type ExtractedFieldsForDb = {
  rfp_number: string;
  title: string;
  agency: string;
  sub_agency: string;
  naics_code: string;
  set_aside: string;
  solicitation_status:
    | "draft"
    | "released"
    | "amendment"
    | "closed"
    | "awarded"
    | "cancelled"
    | "archived"
    | "unknown"
    | ""; // model might return empty; we'll sanitize
  due_at: string; // ISO string or ""
  posted_at: string; // ISO string or ""
  solicitation_url: string;
};

type MetaResponse =
  | {
      schema_version: "1.0";
      extracted_fields_for_db: ExtractedFieldsForDb;
    }
  | { error: string };

const ALLOWED_SOLICITATION_STATUSES = new Set([
  "draft",
  "released",
  "amendment",
  "closed",
  "awarded",
  "cancelled",
  "archived",
  "unknown",
]);

function sanitizeSolicitationStatus(value: string): string {
  const v = (value ?? "").trim().toLowerCase();

  // direct allowlist
  if (ALLOWED_SOLICITATION_STATUSES.has(v)) return v;

  // light normalization for common model outputs
  if (v.includes("amend")) return "amendment";
  if (v.includes("release") || v.includes("open") || v.includes("active"))
    return "released";
  if (v.includes("award")) return "awarded";
  if (v.includes("cancel")) return "cancelled";
  if (v.includes("close")) return "closed";
  if (v.includes("archive")) return "archived";
  if (v.includes("draft")) return "draft";

  // safest default for enum column
  return "unknown";
}

// Pull a handful of early chunks as context (fast and usually contains metadata)
async function buildRagContextForRfp(rfpId: string): Promise<string> {
  const res = await pool.query(
    `
    SELECT id, chunk_index, section_title, left(text, 1800) as text
    FROM rfp_chunks
    WHERE rfp_id = $1
    ORDER BY chunk_index ASC
    LIMIT 12
    `,
    [rfpId]
  );

  const chunks = res.rows as {
    id: string;
    chunk_index: number;
    section_title: string | null;
    text: string;
  }[];

  if (chunks.length === 0) {
    return `RFP_ID: ${rfpId}\n\nNo chunks found in Postgres for this RFP.`;
  }

  const contextParts = chunks.map((c) => {
    const header = `CHUNK ${c.chunk_index} (${c.section_title ?? "UNKNOWN"}) [${
      c.id
    }]`;
    return `${header}\n${c.text}`;
  });

  return [
    `RFP_ID: ${rfpId}`,
    `INSTRUCTIONS: Use ONLY the text below to extract fields. If not present, return empty strings.`,
    ``,
    ...contextParts,
  ].join("\n\n---\n\n");
}

function safeParseJson(text: string): any {
  return JSON.parse((text ?? "").trim());
}

function parseIsoOrNull(value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;

  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

export const extractMetadataRouter = Router();

extractMetadataRouter.post("/:rfpId/extract-metadata", async (req, res) => {
  const { rfpId } = req.params;
  const force = Boolean(req.body?.force);
  const promptVersion = (req.body?.prompt_version ?? "meta_v1") as string;

  if (promptVersion !== "meta_v1") {
    return res
      .status(400)
      .json({ ok: false, error: "Unsupported prompt_version" });
  }

  // TEMP until auth exists
  const userId = req.body?.user_id ?? null;

  try {
    // 1) Load RFP record + guard checks
    const rfpResult = await pool.query(
      `
      SELECT id, chunk_count, qdrant_indexed_at, extracted_fields_json
      FROM rfps
      WHERE id = $1
      `,
      [rfpId]
    );

    if (rfpResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "RFP not found" });
    }

    const rfp = rfpResult.rows[0] as {
      id: string;
      chunk_count: number | null;
      qdrant_indexed_at: string | null;
      extracted_fields_json: any | null;
    };

    if (!force) {
      if (
        rfp.extracted_fields_json &&
        rfp.extracted_fields_json.extracted_fields_for_db
      ) {
        return res.json({
          ok: true,
          rfp_id: rfpId,
          skipped: true,
          reason: "already_extracted",
        });
      }
    }

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

    // 2) Build RAG context
    const ragContext = await buildRagContextForRfp(rfpId);

    // 3) Call OpenAI (Prompt 1)
    const openai = getOpenAIClient();
    const model = process.env.PROJECT_DESCRIPTION_OPEN_AI_MODEL || "gpt-5-mini";

    const completion = await openai.chat.completions.create({
      model,
      temperature: 1, // metadata extraction should be deterministic
      messages: [
        { role: "system", content: META_PROMPT_V1 },
        { role: "user", content: ragContext },
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "";
    let parsed: MetaResponse;

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

    const extracted = (parsed as any).extracted_fields_for_db as
      | ExtractedFieldsForDb
      | undefined;

    if (!extracted) {
      return res
        .status(502)
        .json({ ok: false, error: "Missing extracted_fields_for_db" });
    }

    // 4) Sanitize + map fields → DB columns
    const dueAtIso = parseIsoOrNull(extracted.due_at);
    const postedAtIso = parseIsoOrNull(extracted.posted_at);
    const solicitationStatus = sanitizeSolicitationStatus(
      extracted.solicitation_status ?? ""
    );

    const updated = await pool.query(
      `
      UPDATE rfps
      SET
        rfp_number = COALESCE(NULLIF($1, ''), rfp_number),
        title = COALESCE(NULLIF($2, ''), title),
        agency = COALESCE(NULLIF($3, ''), agency),
        sub_agency = NULLIF($4, ''),
        naics_code = NULLIF($5, ''),
        set_aside = NULLIF($6, ''),
        solicitation_status = COALESCE($7::rfp_solicitation_status, solicitation_status),
        due_at = $8::timestamptz,
        posted_at = $9::timestamptz,
        solicitation_url = NULLIF($10, ''),
        extracted_fields_json = $11::jsonb,
        updated_at = now(),
        updated_by_user_id = COALESCE($12, updated_by_user_id)
      WHERE id = $13
      RETURNING id
      `,
      [
        extracted.rfp_number ?? "",
        extracted.title ?? "",
        extracted.agency ?? "",
        extracted.sub_agency ?? "",
        extracted.naics_code ?? "",
        extracted.set_aside ?? "",
        solicitationStatus,
        dueAtIso,
        postedAtIso,
        extracted.solicitation_url ?? "",
        parsed, // store entire meta JSON
        userId,
        rfpId,
      ]
    );

    if (updated.rowCount === 0) {
      return res
        .status(500)
        .json({ ok: false, error: "Failed to update RFP metadata" });
    }

    // 5) Respond (report non-empty extracted fields)
    const updatedFields: string[] = [];
    for (const [k, v] of Object.entries(extracted)) {
      if (typeof v === "string" && v.trim()) updatedFields.push(k);
    }

    // Also include status after sanitization (useful for debugging)
    if (!updatedFields.includes("solicitation_status")) {
      // If model returned empty but we stored 'unknown', this may not be "updated_fields" by original logic.
      // Keep original behavior; optionally add a separate key if you want.
    }

    return res.json({
      ok: true,
      rfp_id: rfpId,
      prompt_version: "meta_v1",
      model,
      updated_fields: updatedFields,
      solicitation_status_stored: solicitationStatus,
    });
  } catch (err: any) {
    console.error("extract-metadata error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message ?? "Unknown error" });
  }
});

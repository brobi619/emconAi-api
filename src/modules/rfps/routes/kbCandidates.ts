import { Router } from "express";
import {
  ALL_KB_SEARCH_COLLECTIONS,
  DEFAULT_KB_SEARCH_COLLECTIONS,
} from "../../../config/qdrantCollections";
import { retrieveKBCandidates } from "../services/kbRetrieval";
import { selectKBCandidates } from "../services/kbCandidateSelection";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;

const router = Router();

/**
 * POST /rfps/:rfpId/kb-candidates
 * Step 2.3b: KB retrieval + LLM-based candidate selection wired.
 * Loads RFP understanding JSON from rfp_analyses.analysis_json.
 */
router.post("/:rfpId/kb-candidates", async (req, res) => {
  try {
    const { rfpId } = req.params;

    const force = Boolean(req.body?.force ?? false);
    const top_k_raw = req.body?.top_k ?? 12;
    const mode = (req.body?.mode ?? "default") as "default" | "all";

    const top_k =
      typeof top_k_raw === "number" ? Math.min(Math.max(top_k_raw, 1), 50) : 12;

    const collections_queried =
      mode === "all"
        ? ALL_KB_SEARCH_COLLECTIONS
        : DEFAULT_KB_SEARCH_COLLECTIONS;

    // Minimal query set (we can later derive these from understanding_json)
    const queries = [
      "scope of work and services",
      "required certifications and compliance (ISO, QA plan, security)",
      "key personnel and staffing requirements",
      "similar past performance",
    ];

    const candidates = await retrieveKBCandidates({
      queries,
      top_k,
      collections: collections_queried,
    });

    // Load latest RFP understanding JSON from rfp_analyses
    const aRes = await pool.query(
      `
      SELECT analysis_json
      FROM rfp_analyses
      WHERE rfp_id = $1
        AND prompt_version ILIKE 'rfp_understanding%'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [rfpId]
    );

    const rfp_understanding_json =
      aRes.rowCount > 0
        ? aRes.rows[0].analysis_json
        : {
            rfp_id: rfpId,
            note: "No rfp_understanding analysis found in rfp_analyses (prompt_version like rfp_understanding%).",
          };

    const selection = await selectKBCandidates({
      rfp_understanding_json,
      kb_candidates: candidates,
    });

    return res.json({
      ok: true,
      rfp_id: rfpId,
      forced: force,
      top_k,
      mode,
      collections_queried,
      candidates,
      selection,
    });
  } catch (err) {
    console.error("kb-candidates error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
});

export default router;

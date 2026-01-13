import { Router } from "express";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;
import uploadRouter from "./upload";
import fs from "fs/promises";
import path from "path";

// pdf-parse is CommonJS; require avoids TS/ESM default import issues.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require("pdf-parse");

const router = Router();

// Upload routes: POST /rfps/upload
router.use("/upload", uploadRouter);

// GET /rfps  -> list recent RFPs
router.get("/", async (req, res) => {
  // Query params
  const q = String(req.query.q || "").trim();
  const limit = Math.min(
    parseInt(String(req.query.limit || "50"), 10) || 50,
    1000
  );
  const offset = parseInt(String(req.query.offset || "0"), 10) || 0;
  const status = req.query.status ? String(req.query.status) : null;
  const sort = String(req.query.sort || "created_at:desc");

  // Basic sort parsing: field:dir
  const [sortField, sortDirRaw] = sort.split(":");
  const sortDir =
    (sortDirRaw || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const allowedSortFields = new Set(["created_at", "title", "rfp_number"]);
  const orderBy = allowedSortFields.has(sortField)
    ? `${sortField} ${sortDir}`
    : `created_at ${sortDir}`;

  // Build where clauses
  const where: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (q) {
    where.push(
      `(id::text ILIKE $${idx} OR title ILIKE $${idx} OR original_filename ILIKE $${idx})`
    );
    params.push(`%${q}%`);
    idx++;
  }

  if (status) {
    where.push(`extraction_status = $${idx}`);
    params.push(status);
    idx++;
  }

  const whereClause = where.length ? `WHERE ` + where.join(" AND ") : "";

  const itemsQ = `
    SELECT
      id,
      rfp_number,
      title,
      agency,
      solicitation_status,
      due_at,
      extraction_status,
      original_filename as filename,
      storage_path,
      file_sha256,
      created_at,
      created_by_user_id
    FROM rfps
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${idx}
    OFFSET $${idx + 1}
  `;

  params.push(limit);
  params.push(offset);

  const totalQ = `SELECT COUNT(*)::int as total FROM rfps ${whereClause}`;

  try {
    const itemsRes = await pool.query(itemsQ, params);
    const totalRes = await pool.query(totalQ, params.slice(0, idx - 1));

    res.json({
      ok: true,
      items: itemsRes.rows,
      total: totalRes.rows[0]?.total ?? itemsRes.rowCount,
      limit,
      offset,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// IMPORTANT: define specific sub-routes BEFORE the greedy "/:id" route.

// GET /rfps/:id/chunks -> list chunks for an RFP
router.get("/:id/chunks", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    `
    SELECT
      id,
      rfp_id,
      chunk_index,
      page_start,
      page_end,
      section_title,
      length(text) as text_len
    FROM rfp_chunks
    WHERE rfp_id = $1
    ORDER BY chunk_index ASC
    `,
    [id]
  );

  res.json({ ok: true, items: result.rows });
});

// POST /rfps/:id/chunks/seed -> (stub) insert a couple fake chunks for testing
router.post("/:id/chunks/seed", async (req, res) => {
  const { id } = req.params;

  // confirm RFP exists
  const rfpRes = await pool.query(`SELECT id FROM rfps WHERE id = $1 LIMIT 1`, [
    id,
  ]);
  // debug: show whether pool is loaded correctly
  // eslint-disable-next-line no-console
  console.log("[rfps routes] pool loaded:", pool ? Object.keys(pool) : pool);
  if (rfpRes.rowCount === 0) {
    return res.status(404).json({ error: "RFP not found" });
  }

  // clear existing chunks (for repeatable testing)
  await pool.query(`DELETE FROM rfp_chunks WHERE rfp_id = $1`, [id]);

  // insert a few stub chunks
  const chunks = [
    {
      idx: 0,
      text: "SECTION A: This is a stub chunk for testing.",
      page_start: 1,
      page_end: 1,
      section_title: "SECTION A",
    },
    {
      idx: 1,
      text: "SECTION L: Instructions to Offerors (stub).",
      page_start: 12,
      page_end: 13,
      section_title: "SECTION L",
    },
    {
      idx: 2,
      text: "SECTION M: Evaluation Criteria (stub).",
      page_start: 20,
      page_end: 21,
      section_title: "SECTION M",
    },
  ];

  const inserted: any[] = [];
  for (const c of chunks) {
    const r = await pool.query(
      `
      INSERT INTO rfp_chunks (rfp_id, chunk_index, text, page_start, page_end, section_title)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, rfp_id, chunk_index, page_start, page_end, section_title
      `,
      [id, c.idx, c.text, c.page_start, c.page_end, c.section_title]
    );
    inserted.push(r.rows[0]);
  }

  res.json({ ok: true, inserted_count: inserted.length, inserted });
});

// POST /rfps/:id/process -> extract PDF text and store as a single chunk (for now)
router.post("/:id/process", async (req, res) => {
  const { id } = req.params;

  // Load RFP row
  const rfpRes = await pool.query(
    `
    SELECT id, storage_path, original_filename, mime_type
    FROM rfps
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  if (rfpRes.rowCount === 0) {
    return res.status(404).json({ error: "RFP not found" });
  }

  const rfp = rfpRes.rows[0];

  if (!rfp.storage_path) {
    return res.status(400).json({ error: "RFP has no storage_path yet" });
  }

  // Resolve absolute path
  const absPath = path.resolve(process.cwd(), rfp.storage_path);

  // Read file bytes
  let fileBuf: Buffer;
  try {
    fileBuf = await fs.readFile(absPath);
  } catch {
    return res
      .status(404)
      .json({ error: "File not found on disk", absolute_path: absPath });
  }

  // Extract PDF text
  let extractedText = "";
  try {
    const parsed = await pdfParse(fileBuf);
    extractedText = (parsed?.text ?? "").trim();
  } catch (e: any) {
    return res.status(500).json({
      error: "PDF parse failed",
      detail: e?.message ?? String(e),
    });
  }

  if (!extractedText) {
    return res.status(422).json({
      error: "No text extracted from PDF (possibly scanned/image-based)",
      rfp_id: id,
      absolute_path: absPath,
    });
  }

  // Overwrite any existing chunks for this RFP
  await pool.query(`DELETE FROM rfp_chunks WHERE rfp_id = $1`, [id]);

  // Simple chunking strategy (by characters) for now
  // Later we'll switch to token-based + better structure.
  const CHUNK_SIZE = 1800; // chars
  const OVERLAP = 200; // chars

  function chunkText(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);

      if (end >= text.length) break;
      start = end - OVERLAP; // overlap for continuity
      if (start < 0) start = 0;
    }

    return chunks;
  }

  const chunks = chunkText(extractedText);

  // Insert chunks
  const insertedIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await pool.query(
      `
    INSERT INTO rfp_chunks (rfp_id, chunk_index, text, section_title)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
      [id, i, chunks[i], "CHAR_CHUNK"]
    );
    insertedIds.push(r.rows[0].id);
  }

  return res.json({
    ok: true,
    rfp_id: id,
    extracted_characters: extractedText.length,
    chunk_count: chunks.length,
    first_chunk_id: insertedIds[0],
    first_chunk_preview: chunks[0].slice(0, 400),
  });
});

// POST /rfps/:id/extract -> (stub) extract fields and save to DB
router.post("/:id/extract", async (req, res) => {
  const { id } = req.params;

  // 1) Load the RFP row
  const rfpRes = await pool.query(
    `SELECT id, rfp_number, agency, storage_path, original_filename
     FROM rfps
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  if (rfpRes.rowCount === 0) {
    return res.status(404).json({ error: "RFP not found" });
  }

  const rfp = rfpRes.rows[0];

  const extracted = {
    rfp_number: rfp.rfp_number ?? null,
    agency: rfp.agency,
    title: null,
    due_at: null,
    naics_code: null,
    source: "stub",
    original_filename: rfp.original_filename,
    storage_path: rfp.storage_path,
  };

  // 3) Save extracted_fields_json + status
  const updateRes = await pool.query(
    `
    UPDATE rfps
    SET
      rfp_number = COALESCE($2->>'rfp_number', rfp_number),
      extracted_fields_json = $2,
      extraction_status = 'extracted',
      updated_at = now()
    WHERE id = $1
    RETURNING id, rfp_number, extraction_status, extracted_fields_json
    `,
    [id, extracted]
  );

  res.json(updateRes.rows[0]);
});

// GET /rfps/:id -> single RFP
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    `
    SELECT
      id,
      rfp_number,
      title,
      agency,
      sub_agency,
      naics_code,
      set_aside,
      solicitation_status,
      due_at,
      posted_at,
      extraction_status,
      extracted_fields_json,
      solicitation_url,
      notes,
      original_filename,
      storage_provider,
      storage_path,
      file_sha256,
      mime_type,
      file_size_bytes,
      created_at,
      created_by_user_id,
      updated_at,
      updated_by_user_id
    FROM rfps
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "RFP not found" });
  }

  res.json(result.rows[0]);
});

// PUT /rfps/:id -> update RFP fields (confirmation/edit)
router.put("/:id", async (req, res) => {
  const { id } = req.params;

  const {
    rfp_number,
    title,
    agency,
    sub_agency,
    naics_code,
    set_aside,
    solicitation_status,
    due_at,
    posted_at,
    solicitation_url,
    notes,
    extraction_status,
    extracted_fields_json,
    updated_by_user_id,
  } = req.body ?? {};

  const result = await pool.query(
    `
    UPDATE rfps
    SET
      rfp_number = COALESCE($2, rfp_number),
      title = COALESCE($3, title),
      agency = COALESCE($4, agency),
      sub_agency = COALESCE($5, sub_agency),
      naics_code = COALESCE($6, naics_code),
      set_aside = COALESCE($7, set_aside),
      solicitation_status = COALESCE($8, solicitation_status),
      due_at = COALESCE($9, due_at),
      posted_at = COALESCE($10, posted_at),
      solicitation_url = COALESCE($11, solicitation_url),
      notes = COALESCE($12, notes),
      extraction_status = COALESCE($13, extraction_status),
      extracted_fields_json = COALESCE($14, extracted_fields_json),
      updated_at = now(),
      updated_by_user_id = COALESCE($15, updated_by_user_id)
    WHERE id = $1
    RETURNING *
    `,
    [
      id,
      rfp_number,
      title,
      agency,
      sub_agency,
      naics_code,
      set_aside,
      solicitation_status,
      due_at,
      posted_at,
      solicitation_url,
      notes,
      extraction_status,
      extracted_fields_json,
      updated_by_user_id,
    ]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "RFP not found" });
  }

  res.json(result.rows[0]);
});

export default router;

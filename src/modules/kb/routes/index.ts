import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { randomUUID } from "crypto";
import pdfParse from "pdf-parse";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;

import { extractKbMetadata } from "../lib/kbExtract";
import { buildPayloadForDoc } from "../lib/payload";

const router = Router();

const TMP_DIR = path.resolve(process.cwd(), "data", "_tmp_uploads");

const upload = multer({ dest: TMP_DIR });

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

// POST /kb/upload
router.post("/upload", upload.single("file"), async (req, res) => {
  const client = await pool.connect();
  let fileSha256: string | null = null;

  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing file (field name must be 'file')" });
    }

    await ensureDir(TMP_DIR);

    const originalFilename = req.file.originalname;
    const mimeType = req.file.mimetype || "application/octet-stream";
    const fileSizeBytes = req.file.size || 0;

    const tmpPath = req.file.path;
    fileSha256 = await sha256File(tmpPath);

    const docId = randomUUID();
    const safeName = originalFilename.replace(/[^\w.\-() ]+/g, "_");
    const destDir = path.resolve(process.cwd(), "data", "kb", docId);
    await ensureDir(destDir);
    const destPath = path.join(destDir, safeName);
    await fs.rename(tmpPath, destPath);

    const storagePath = path.relative(process.cwd(), destPath);

    const tenantId = (req.header("x-tenant-id") || "default") as string;
    const createdByUserId = req.header("x-user-id") || null;
    const title =
      (req.body?.title && String(req.body.title).trim()) || originalFilename;
    const kbTypeRaw = req.body?.kbType ?? req.body?.kb_type;
    const kbType = (kbTypeRaw && String(kbTypeRaw).trim()) || "other";

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      INSERT INTO kb_documents (
        id, tenant_id, title, kb_type, source_filename, storage_path, sha256, mime_type, file_size_bytes, created_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        docId,
        tenantId,
        title,
        kbType,
        originalFilename,
        storagePath,
        fileSha256,
        mimeType,
        fileSizeBytes,
        createdByUserId,
      ]
    );

    await client.query("COMMIT");

    // After successful upload, chunk the file, run LLM extraction, and store results
    try {
      const absPath = path.resolve(process.cwd(), storagePath);
      const fileBuf = await fs.readFile(absPath);
      const parsed = await pdfParse(fileBuf as any);
      const extractedText = (parsed?.text ?? "").trim();

      if (extractedText) {
        // Chunk text
        const CHUNK_SIZE = 1800;
        const OVERLAP = 200;
        function chunkText(text: string): string[] {
          const chunks: string[] = [];
          let start = 0;
          while (start < text.length) {
            const end = Math.min(start + CHUNK_SIZE, text.length);
            const chunk = text.slice(start, end).trim();
            if (chunk) chunks.push(chunk);
            if (end >= text.length) break;
            start = end - OVERLAP;
            if (start < 0) start = 0;
          }
          return chunks;
        }

        const chunks = chunkText(extractedText);

        await client.query("BEGIN");
        // remove any existing chunks just in case
        await client.query(`DELETE FROM kb_chunks WHERE kb_document_id = $1`, [
          docId,
        ]);
        for (let i = 0; i < chunks.length; i++) {
          await client.query(
            `INSERT INTO kb_chunks (tenant_id, kb_document_id, chunk_index, content) VALUES ($1,$2,$3,$4)`,
            [tenantId, docId, i, chunks[i]]
          );
        }

        // Run LLM extractor over the full text (RAG context is available via saved chunks)
        const extractedJson = await extractKbMetadata({
          kbType,
          fullText: extractedText,
          filename: originalFilename,
          title,
        });

        await client.query(
          `INSERT INTO kb_extractions (tenant_id, kb_document_id, extracted_json, extracted_text_preview) VALUES ($1,$2,$3,$4)`,
          [tenantId, docId, extractedJson, extractedText.slice(0, 4000)]
        );

        await client.query(
          `UPDATE kb_documents SET extraction_status = 'extracted', updated_at = now() WHERE id = $1`,
          [docId]
        );
        await client.query("COMMIT");

        return res.status(201).json({
          ok: true,
          kb_document: rows[0],
          extraction: extractedJson,
          chunk_count: chunks.length,
        });
      } else {
        // no text extracted
        await pool
          .query(
            `UPDATE kb_documents SET extraction_status = 'failed', error_message = $2 WHERE id = $1`,
            [docId, "no text extracted"]
          )
          .catch(() => {});
        return res.status(201).json({
          ok: true,
          kb_document: rows[0],
          extraction: null,
          chunk_count: 0,
        });
      }
    } catch (err: any) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("KB post-upload extraction failed", err);
      await pool
        .query(
          `UPDATE kb_documents SET extraction_status = 'failed', error_message = $2 WHERE id = $1`,
          [docId, String(err?.message ?? err)]
        )
        .catch(() => {});
      return res
        .status(201)
        .json({ ok: true, kb_document: rows[0], extraction: null });
    }
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, error: "Duplicate file" });
    }

    console.error("KB upload failed:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  } finally {
    client.release();
  }
});

// GET /kb -> list
router.get("/", async (req, res) => {
  const tenantId = String(req.header("x-tenant-id") || "default");
  const q = String(req.query.q || "").trim();
  const limit = Math.min(
    parseInt(String(req.query.limit || "50"), 10) || 50,
    1000
  );
  const offset = parseInt(String(req.query.offset || "0"), 10) || 0;

  const where: string[] = ["tenant_id = $1"];
  const params: any[] = [tenantId];
  let idx = 2;

  if (q) {
    where.push(
      `(id::text ILIKE $${idx} OR title ILIKE $${idx} OR source_filename ILIKE $${idx})`
    );
    params.push(`%${q}%`);
    idx++;
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const itemsQ = `SELECT * FROM kb_documents ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${
    idx + 1
  }`;
  params.push(limit);
  params.push(offset);

  const totalQ = `SELECT COUNT(*)::int as total FROM kb_documents ${whereClause}`;

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

// GET /kb/:id -> get document + extraction
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const docRes = await pool.query(
      `SELECT * FROM kb_documents WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (docRes.rowCount === 0)
      return res
        .status(404)
        .json({ ok: false, error: "KB document not found" });
    const doc = docRes.rows[0];
    const extRes = await pool.query(
      `SELECT * FROM kb_extractions WHERE kb_document_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    const extraction = extRes.rowCount ? extRes.rows[0] : null;
    const chunkCountRes = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM kb_chunks WHERE kb_document_id = $1`,
      [id]
    );
    const chunkCount = chunkCountRes.rows[0]?.cnt ?? 0;
    res.json({
      ok: true,
      kb_document: doc,
      extraction,
      chunk_count: chunkCount,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// GET /kb/:id/chunks
router.get("/:id/chunks", async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await pool.query(
      `SELECT id, chunk_index, content, page_number, section FROM kb_chunks WHERE kb_document_id = $1 ORDER BY chunk_index ASC LIMIT 200`,
      [id]
    );
    res.json({ ok: true, items: rows.rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// POST /kb/:id/extract
router.post("/:id/extract", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const docRes = await client.query(
      `SELECT * FROM kb_documents WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (docRes.rowCount === 0)
      return res
        .status(404)
        .json({ ok: false, error: "KB document not found" });
    const doc = docRes.rows[0];
    if (!doc.storage_path)
      return res.status(400).json({ ok: false, error: "No storage_path" });
    // Use the LLM extractor to produce structured metadata and store it.
    const absPath = path.resolve(process.cwd(), doc.storage_path);
    const fileBuf = await fs.readFile(absPath);
    const parsed = await pdfParse(fileBuf as any);
    const extractedText = (parsed?.text ?? "").trim();
    if (!extractedText)
      return res.status(422).json({ ok: false, error: "No text extracted" });

    const extractedJson = await extractKbMetadata({
      kbType: doc.kb_type,
      fullText: extractedText,
      filename: doc.source_filename,
      title: doc.title,
    });

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO kb_extractions (tenant_id, kb_document_id, extracted_json, extracted_text_preview) VALUES ($1,$2,$3,$4)`,
      [doc.tenant_id, id, extractedJson, extractedText.slice(0, 4000)]
    );
    await client.query(
      `UPDATE kb_documents SET extraction_status = 'extracted', updated_at = now() WHERE id = $1`,
      [id]
    );
    await client.query("COMMIT");

    return res.json({ ok: true, extraction: extractedJson });
  } catch (e: any) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    await client
      .query(
        `UPDATE kb_documents SET extraction_status = 'failed', error_message = $2 WHERE id = $1`,
        [id, String(e?.message ?? e)]
      )
      .catch(() => {});
    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  } finally {
    client.release();
  }
});

// POST /kb/:id/approve
router.post("/:id/approve", async (req, res) => {
  const { id } = req.params;
  try {
    // Allow the client to submit edited extraction JSON as part of approval.
    const editedExtraction =
      req.body?.extracted_json ?? req.body?.extraction ?? null;

    await pool.query("BEGIN");
    if (editedExtraction) {
      await pool.query(
        `INSERT INTO kb_extractions (tenant_id, kb_document_id, extracted_json, extracted_text_preview) SELECT tenant_id, $1, $2, $3 FROM kb_documents WHERE id = $1`,
        [
          id,
          editedExtraction,
          editedExtraction && editedExtraction.summary
            ? String(editedExtraction.summary).slice(0, 4000)
            : null,
        ]
      );
    }
    await pool.query(
      `UPDATE kb_documents SET review_status = 'approved', updated_at = now() WHERE id = $1`,
      [id]
    );
    await pool.query("COMMIT");

    // Start background job: chunk + embed + qdrant upsert
    (async () => {
      try {
        const docRes = await pool.query(
          `SELECT * FROM kb_documents WHERE id = $1 LIMIT 1`,
          [id]
        );
        if (docRes.rowCount === 0) return;
        const doc = docRes.rows[0];
        if (!doc.storage_path) {
          await pool
            .query(
              `UPDATE kb_documents SET index_status = 'failed', error_message = $2 WHERE id = $1`,
              [id, "missing storage_path"]
            )
            .catch(() => {});
          return;
        }

        const absPath = path.resolve(process.cwd(), doc.storage_path);
        const fileBuf = await fs.readFile(absPath);
        const parsed = await pdfParse(fileBuf as any);
        const extractedText = (parsed?.text ?? "").trim();

        // Chunk text
        const CHUNK_SIZE = 1800;
        const OVERLAP = 200;
        function chunkText(text: string): string[] {
          const chunks: string[] = [];
          let start = 0;
          while (start < text.length) {
            const end = Math.min(start + CHUNK_SIZE, text.length);
            const chunk = text.slice(start, end).trim();
            if (chunk) chunks.push(chunk);
            if (end >= text.length) break;
            start = end - OVERLAP;
            if (start < 0) start = 0;
          }
          return chunks;
        }

        const chunks = chunkText(extractedText);

        // Insert chunks (non-transactional; keep processing even if some inserts fail)
        try {
          await pool.query(`DELETE FROM kb_chunks WHERE kb_document_id = $1`, [
            id,
          ]);
          for (let i = 0; i < chunks.length; i++) {
            await pool.query(
              `INSERT INTO kb_chunks (tenant_id, kb_document_id, chunk_index, content) VALUES ($1,$2,$3,$4)`,
              [doc.tenant_id, id, i, chunks[i]]
            );
          }
        } catch (e) {
          console.error("Failed writing kb_chunks", e);
        }

        // Now perform embedding + qdrant upsert (reuse logic from /index)
        const COLLECTION_MAP: Record<string, string> = {
          past_performance: "kb_past_performance",
          resumes: "kb_resumes",
          capabilities: "kb_capabilities",
          compliance: "kb_compliance_quality",
          compliance_quality: "kb_compliance_quality",
          templates: "kb_templates_boilerplate",
          templates_boilerplate: "kb_templates_boilerplate",
          other: "kb_other",
        };
        const TARGET_COLLECTION = COLLECTION_MAP[doc.kb_type] || "kb_other";
        const TEI_URL = process.env.TEI_URL ?? "http://localhost:8081";
        const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
        const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";

        async function embedTexts(texts: string[]): Promise<number[][]> {
          const resp = await fetch(`${TEI_URL}/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputs: texts }),
          });
          if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            throw new Error(
              `TEI embed failed: ${resp.status} ${resp.statusText} ${detail}`
            );
          }
          return (await resp.json()) as number[][];
        }

        async function ensureQdrantCollection(collection: string) {
          const headers: Record<string, string> = {};
          if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
          const getResp = await fetch(
            `${QDRANT_URL}/collections/${collection}`,
            { method: "GET", headers }
          );
          if (getResp.ok) return;
          if (getResp.status !== 404) {
            const detail = await getResp.text().catch(() => "");
            throw new Error(
              `Qdrant collection check failed: ${getResp.status} ${getResp.statusText} ${detail}`
            );
          }
          const createResp = await fetch(
            `${QDRANT_URL}/collections/${collection}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...headers },
              body: JSON.stringify({
                vectors: { size: 384, distance: "Cosine" },
              }),
            }
          );
          if (!createResp.ok) {
            const detail = await createResp.text().catch(() => "");
            throw new Error(
              `Qdrant collection create failed: ${createResp.status} ${createResp.statusText} ${detail}`
            );
          }
        }

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
            { method: "PUT", headers, body: JSON.stringify({ points }) }
          );
          if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            throw new Error(
              `Qdrant upsert failed: ${resp.status} ${resp.statusText} ${detail}`
            );
          }
        }

        try {
          await ensureQdrantCollection(TARGET_COLLECTION);
          // fetch freshly written chunks
          const chunksRes = await pool.query(
            `SELECT id, kb_document_id, chunk_index, content FROM kb_chunks WHERE kb_document_id = $1 ORDER BY chunk_index ASC`,
            [id]
          );
          const batch = chunksRes.rows as {
            id: string;
            kb_document_id: string;
            chunk_index: number;
            content: string;
          }[];
          if (batch.length === 0) {
            await pool.query(
              `UPDATE kb_documents SET index_status = 'indexed', updated_at = now() WHERE id = $1`,
              [id]
            );
            return;
          }

          const MAX_CHARS = 1800;
          const texts = batch.map((b) => (b.content ?? "").slice(0, MAX_CHARS));
          const vectors = await embedTexts(texts);

          // load latest extraction if needed
          const extRes = await pool.query(
            `SELECT extracted_json FROM kb_extractions WHERE kb_document_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [id]
          );
          const extraction = extRes.rowCount
            ? extRes.rows[0].extracted_json
            : null;

          const points = batch.map((b, i) => ({
            id: b.id,
            vector: vectors[i],
            payload: {
              tenant_id: doc.tenant_id,
              doc_id: b.kb_document_id,
              chunk_id: b.id,
              chunk_index: b.chunk_index,
              title: doc.title,
              source_type: "kb",
              collection: TARGET_COLLECTION,
              created_at: new Date().toISOString(),
              source_uri: doc.storage_path,
              kb_type: doc.kb_type,
              ...buildPayloadForDoc(doc, extraction),
            },
          }));

          await qdrantUpsert(TARGET_COLLECTION, points);

          await pool.query(
            `UPDATE kb_documents SET index_status = 'indexed', updated_at = now() WHERE id = $1`,
            [id]
          );
        } catch (e: any) {
          console.error("KB indexing failed", e);
          await pool
            .query(
              `UPDATE kb_documents SET index_status = 'failed', error_message = $2 WHERE id = $1`,
              [id, String(e?.message ?? e)]
            )
            .catch(() => {});
        }
      } catch (err: any) {
        console.error("Background KB approve job failed", err);
        await pool
          .query(
            `UPDATE kb_documents SET index_status = 'failed', error_message = $2 WHERE id = $1`,
            [id, String(err?.message ?? err)]
          )
          .catch(() => {});
      }
    })();

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// POST /kb/:id/review
router.post("/:id/review", async (req, res) => {
  const { id } = req.params;
  try {
    const reviewed =
      req.body?.reviewed_fields ?? req.body?.reviewedFields ?? null;
    if (!reviewed || typeof reviewed !== "object") {
      return res
        .status(400)
        .json({ ok: false, error: "Missing reviewed_fields JSON" });
    }

    await pool.query("BEGIN");
    await pool.query(
      `UPDATE kb_documents SET reviewed_fields = $2, reviewed_at = now(), review_status = 'approved', updated_at = now() WHERE id = $1`,
      [id, reviewed]
    );
    await pool.query("COMMIT");

    res.json({ ok: true });
  } catch (e: any) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// POST /kb/:id/index
router.post("/:id/index", async (req, res) => {
  const { id } = req.params;
  const batchSize =
    typeof req.body?.batchSize === "number" ? req.body.batchSize : 100;

  // Ensure doc exists and is approved+extracted
  const docRes = await pool.query(
    `SELECT * FROM kb_documents WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (docRes.rowCount === 0)
    return res.status(404).json({ ok: false, error: "KB document not found" });
  const doc = docRes.rows[0];
  if (doc.review_status !== "approved")
    return res.status(400).json({ ok: false, error: "Document not approved" });
  if (doc.extraction_status !== "extracted")
    return res.status(400).json({ ok: false, error: "Document not extracted" });

  // Map kb_type to collection
  const COLLECTION_MAP: Record<string, string> = {
    past_performance: "kb_past_performance",
    resumes: "kb_resumes",
    capabilities: "kb_capabilities",
    compliance: "kb_compliance_quality",
    compliance_quality: "kb_compliance_quality",
    templates: "kb_templates_boilerplate",
    templates_boilerplate: "kb_templates_boilerplate",
    other: "kb_other",
  };

  const TARGET_COLLECTION = COLLECTION_MAP[doc.kb_type] || "kb_other";

  // reuse embed / qdrant helpers similar to rfp index
  const TEI_URL = process.env.TEI_URL ?? "http://localhost:8081";
  const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
  const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";

  async function embedTexts(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${TEI_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: texts }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `TEI embed failed: ${resp.status} ${resp.statusText} ${detail}`
      );
    }
    const data = (await resp.json()) as number[][];
    return data;
  }

  async function ensureQdrantCollection(
    collection: string,
    vectorSize: number
  ) {
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
      body: JSON.stringify({ vectors: { size: 384, distance: "Cosine" } }),
    });
    if (!createResp.ok) {
      const detail = await createResp.text().catch(() => "");
      throw new Error(
        `Qdrant collection create failed: ${createResp.status} ${createResp.statusText} ${detail}`
      );
    }
  }

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
      { method: "PUT", headers, body: JSON.stringify({ points }) }
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `Qdrant upsert failed: ${resp.status} ${resp.statusText} ${detail}`
      );
    }
  }

  try {
    await ensureQdrantCollection(TARGET_COLLECTION, 384);

    const chunksRes = await pool.query(
      `SELECT id, kb_document_id, chunk_index, content FROM kb_chunks WHERE kb_document_id = $1 ORDER BY chunk_index ASC LIMIT $2`,
      [id, batchSize]
    );
    const batch = chunksRes.rows as {
      id: string;
      kb_document_id: string;
      chunk_index: number;
      content: string;
    }[];
    if (batch.length === 0)
      return res.json({
        ok: true,
        done: true,
        processed: 0,
        message: "No chunks",
      });

    const MAX_CHARS = 1800;
    const texts = batch.map((b) => (b.content ?? "").slice(0, MAX_CHARS));
    const vectors = await embedTexts(texts);

    // load latest extraction if needed
    const extRes = await pool.query(
      `SELECT extracted_json FROM kb_extractions WHERE kb_document_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    const extraction = extRes.rowCount ? extRes.rows[0].extracted_json : null;

    const points = batch.map((b, i) => ({
      id: b.id,
      vector: vectors[i],
      payload: {
        tenant_id: doc.tenant_id,
        doc_id: b.kb_document_id,
        chunk_id: b.id,
        chunk_index: b.chunk_index,
        title: doc.title,
        source_type: "kb",
        collection: TARGET_COLLECTION,
        created_at: new Date().toISOString(),
        source_uri: doc.storage_path,
        kb_type: doc.kb_type,
        ...buildPayloadForDoc(doc, extraction),
      },
    }));

    await qdrantUpsert(TARGET_COLLECTION, points);

    await pool.query(
      `UPDATE kb_documents SET index_status = 'indexed', updated_at = now() WHERE id = $1`,
      [id]
    );

    return res.json({
      ok: true,
      done: batch.length < batchSize,
      processed: batch.length,
      collection: TARGET_COLLECTION,
    });
  } catch (e: any) {
    await pool
      .query(
        `UPDATE kb_documents SET index_status = 'failed', error_message = $2 WHERE id = $1`,
        [id, String(e?.message ?? e)]
      )
      .catch(() => {});
    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

export default router;

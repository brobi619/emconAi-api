import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { orchestrateRfpRun } from "../lib/orchestrateRfpRun";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;

const router = Router();

const TMP_DIR = path.resolve(process.cwd(), "data", "_tmp_uploads");

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

router.post("/", upload.single("file"), async (req, res) => {
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
    const mimeType = req.file.mimetype;
    const fileSizeBytes = req.file.size;

    const tmpPath = req.file.path;
    fileSha256 = await sha256File(tmpPath);

    // Generate RFP id up front so we can build the final storage path BEFORE inserting
    const rfpId = randomUUID();
    const rfpNumber = `PENDING-${rfpId.slice(0, 8)}`;

    // Move file into data/rfps/<rfpId>/<originalFilename> (sanitized)
    const safeName = originalFilename.replace(/[^\w.\-() ]+/g, "_");
    const destDir = path.resolve(process.cwd(), "data", "rfps", rfpId);
    await ensureDir(destDir);

    const destPath = path.join(destDir, safeName);
    await fs.rename(tmpPath, destPath);

    const storagePath = path.relative(process.cwd(), destPath);

    const createdByUserIdHeader = req.header("x-user-id");
    const createdByUserId = createdByUserIdHeader
      ? String(createdByUserIdHeader).trim()
      : null;

    if (!createdByUserId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing x-user-id header" });
    }

    // Create the run id now (we'll write it into both tables)
    const runId = randomUUID();

    await client.query("BEGIN");

    // 1) Insert RFP
    const { rows: rfpRows } = await client.query(
      `
      INSERT INTO rfps (
        id,
        rfp_number,
        title,
        agency,
        solicitation_status,
        due_at,
        extraction_status,
        extracted_fields_json,
        original_filename,
        storage_provider,
        storage_path,
        file_sha256,
        mime_type,
        file_size_bytes,
        created_by_user_id,

        current_run_id,
        pipeline_stage,
        pipeline_progress,
        pipeline_message,
        pipeline_error
      )
      VALUES (
        $1,
        $2,
        NULL,
        'unknown',
        'unknown',
        NULL,
        'pending',
        NULL,
        $3,
        'local',
        $4,
        $5,
        $6,
        $7,
        $8,

        $9,
        'queued',
        0,
        'Queued',
        NULL
      )
      RETURNING
        id,
        rfp_number,
        title,
        agency,
        solicitation_status,
        due_at,
        extraction_status,
        original_filename,
        storage_provider,
        storage_path,
        file_sha256,
        mime_type,
        file_size_bytes,
        created_by_user_id,
        current_run_id,
        pipeline_stage,
        pipeline_progress,
        pipeline_message,
        pipeline_error,
        created_at
      `,
      [
        rfpId,
        rfpNumber,
        originalFilename,
        storagePath,
        fileSha256,
        mimeType,
        fileSizeBytes,
        createdByUserId,
        runId,
      ]
    );

    // 2) Insert run tracker row
    await client.query(
      `
      INSERT INTO rfp_runs (
        id,
        rfp_id,
        status,
        stage,
        progress,
        message,
        error,
        created_by_user_id
      )
      VALUES (
        $1,
        $2,
        'running',
        'queued',
        0,
        'Queued',
        NULL,
        $3
      )
      `,
      [runId, rfpId, createdByUserId]
    );

    await client.query("COMMIT");

    // Fire-and-forget the pipeline orchestrator
    void orchestrateRfpRun({ rfpId, runId, userId: createdByUserId });

    return res.status(201).json({
      ok: true,
      rfp: rfpRows[0],
      run_id: runId,
    });
  } catch (err: any) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    // Handle duplicate file hash (unique constraint)
    if (err?.code === "23505" && err?.constraint === "idx_rfps_file_hash") {
      try {
        const sha = fileSha256;

        if (!sha) {
          return res.status(409).json({
            ok: false,
            error: "Duplicate file (same SHA256 already uploaded).",
          });
        }

        const existing = await pool.query(
          `
        SELECT id, rfp_number, original_filename, created_at
        FROM rfps
        WHERE file_sha256 = $1
        LIMIT 1
        `,
          [sha]
        );

        return res.status(409).json({
          ok: false,
          error: "Duplicate file (same SHA256 already uploaded).",
          existing_rfp: existing.rows[0] ?? null,
        });
      } catch {
        return res.status(409).json({
          ok: false,
          error: "Duplicate file (same SHA256 already uploaded).",
        });
      }
    }

    console.error("Upload failed:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  } finally {
    client.release();
  }
});

export default router;


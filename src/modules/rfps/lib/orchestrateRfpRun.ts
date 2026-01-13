// src/modules/rfps/lib/orchestrateRfpRun.ts
// Orchestrates the existing endpoints in-order and writes progress updates to:
// - rfp_runs (history/system-of-record)
// - rfps.pipeline_* (current UI snapshot)

type OrchestrateArgs = {
  rfpId: string;
  runId: string;
  userId: string;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;

async function setProgress(
  runId: string,
  rfpId: string,
  patch: {
    status?: "running" | "succeeded" | "failed";
    stage?: string;
    progress?: number;
    message?: string | null;
    error?: string | null;
  }
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Update rfp_runs
    await client.query(
      `
      UPDATE rfp_runs
      SET
        status = COALESCE($2, status),
        stage = COALESCE($3, stage),
        progress = COALESCE($4, progress),
        message = COALESCE($5, message),
        error = COALESCE($6, error),
        updated_at = now()
      WHERE id = $1
      `,
      [
        runId,
        patch.status ?? null,
        patch.stage ?? null,
        patch.progress ?? null,
        patch.message ?? null,
        patch.error ?? null,
      ]
    );

    // Mirror into rfps (current snapshot for the library grid)
    await client.query(
      `
      UPDATE rfps
      SET
        current_run_id = $2,
        pipeline_stage = COALESCE($3, pipeline_stage),
        pipeline_progress = COALESCE($4, pipeline_progress),
        pipeline_message = COALESCE($5, pipeline_message),
        pipeline_error = COALESCE($6, pipeline_error)
      WHERE id = $1
      `,
      [
        rfpId,
        runId,
        patch.stage ?? null,
        patch.progress ?? null,
        patch.message ?? null,
        patch.error ?? null,
      ]
    );

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function orchestrateRfpRun({
  rfpId,
  runId,
  userId,
}: OrchestrateArgs) {
  const API_BASE = process.env.API_BASE_URL || "http://localhost:3001";

  try {
    // Starting
    await setProgress(runId, rfpId, {
      status: "running",
      stage: "queued",
      progress: 1,
      message: "Starting…",
      error: null,
    });

    // Step 2: process (extract + chunk + store chunks in PG)
    await setProgress(runId, rfpId, {
      stage: "process",
      progress: 10,
      message: "Extracting and chunking…",
      error: null,
    });

    {
      const resp = await fetch(`${API_BASE}/rfps/${rfpId}/process`, {
        method: "POST",
        headers: { "x-user-id": userId },
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`process failed (${resp.status}): ${txt}`);
      }
    }

    await setProgress(runId, rfpId, {
      stage: "process",
      progress: 55,
      message: "Chunking complete.",
      error: null,
    });

    // Step 3/4: index (embed + upsert to Qdrant)
    await setProgress(runId, rfpId, {
      stage: "index",
      progress: 60,
      message: "Embedding and indexing…",
      error: null,
    });

    {
      const resp = await fetch(`${API_BASE}/rfps/${rfpId}/index`, {
        method: "POST",
        headers: { "x-user-id": userId },
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`index failed (${resp.status}): ${txt}`);
      }
    }

    await setProgress(runId, rfpId, {
      status: "succeeded",
      stage: "done",
      progress: 100,
      message: "Complete.",
      error: null,
    });
  } catch (e: any) {
    await setProgress(runId, rfpId, {
      status: "failed",
      stage: "error",
      progress: 100,
      message: "Failed.",
      error: String(e?.message ?? e),
    });
  }
}

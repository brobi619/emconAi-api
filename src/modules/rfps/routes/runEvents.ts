import { Router } from "express";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _db = require("../../../db/index");
const pool = _db?.default ?? _db;

const router = Router();

/**
 * SSE: Frontend calls GET /rfps/:runId/events
 * Streams progress updates until status is succeeded/failed.
 */
router.get("/:runId/events", async (req, res) => {
  const runId = String(req.params.runId || "").trim();

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // Flush headers immediately and send an initial keepalive ping
  (res as any).flushHeaders?.();
  res.write(":\n\n");

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  send("connected", { ok: true, run_id: runId });

  let lastPayload = "";
  let lastPing = Date.now();

  while (!closed) {
    try {
      const { rows } = await pool.query(
        `
        SELECT id, rfp_id, status, stage, progress, message, error, updated_at
        FROM rfp_runs
        WHERE id = $1
        `,
        [runId]
      );

      if (rows.length === 0) {
        send("error", { ok: false, error: "Run not found" });
        break;
      }

      const run = rows[0];
      const payload = JSON.stringify(run);

      if (payload !== lastPayload) {
        lastPayload = payload;
        send("progress", run);
      }

      if (run.status === "succeeded" || run.status === "failed") {
        send("done", run);
        break;
      }
    } catch (e: any) {
      send("error", {
        ok: false,
        error: "SSE polling error",
        detail: String(e?.message ?? e),
      });
      break;
    }

    // Periodic keepalive ping to keep the connection open
    const now = Date.now();
    if (now - lastPing >= 15000) {
      res.write(":\n\n");
      lastPing = now;
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  res.end();
});

export default router;

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rfpsRoutes from "./modules/rfps/routes";
import vectorIndexDebugRoutes from "./routes/debug/vector-index";
import reindexAdminRoutes from "./routes/admin/reindex";
import searchRfpChunksRoutes from "./routes/search/rfpChunks";
import { extractMetadataRouter } from "./modules/rfps/routes/extractMetadata";
import rfpIndexOneRoutes from "./modules/rfps/routes/indexOne";
import { analyzeRfpRouter } from "./modules/rfps/routes/analyzeRfp";
import { understandRfpRouter } from "./modules/rfps/routes/understandRfp";
import kbCandidatesRoutes from "./modules/rfps/routes/kbCandidates";
import rfpRunEventsRoutes from "./modules/rfps/routes/runEvents";
import kbRoutes from "./modules/kb/routes";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Mount module routers
// Mount module routers (ORDER MATTERS)
app.use("/rfps", rfpRunEventsRoutes);
app.use("/rfps", rfpIndexOneRoutes); // /rfps/:id/index
app.use("/rfps", extractMetadataRouter); // /rfps/:id/extract-metadata
app.use("/rfps", kbCandidatesRoutes);
app.use("/rfps", understandRfpRouter);
app.use("/rfps", analyzeRfpRouter);
app.use("/rfps", rfpsRoutes); // /rfps/:id (greedy)
app.use("/kb", kbRoutes);
app.use("/debug", vectorIndexDebugRoutes);
app.use("/admin/reindex", reindexAdminRoutes);
app.use("/search", searchRfpChunksRoutes);

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

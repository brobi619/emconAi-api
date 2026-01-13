import { Router } from "express";
import { getActiveVectorIndex } from "../../services/vectorIndex.service";

const router = Router();

router.get("/vector-index/:namespace", async (req, res) => {
  try {
    const index = await getActiveVectorIndex(req.params.namespace);
    res.json(index);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

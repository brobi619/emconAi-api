// src/services/vectorIndex.service.ts
import pool from "../db";

/**
 * NOTE:
 * For now, multiple namespaces (e.g. "rfp_chunks", "kb") may point to the same
 * physical Qdrant collection for simplicity during early development.
 *
 * TODO:
 * Split KB into its own physical Qdrant collection once:
 *  - KB size grows significantly, OR
 *  - different embedding models are required, OR
 *  - multi-tenant isolation is introduced.
 *
 * This is intentional and not a bug.
 */


export async function getActiveVectorIndex(namespace: string) {
  const result = await pool.query(
    `
    SELECT
      qdrant_collection,
      embedding_model_id,
      embedding_dim
    FROM vector_indexes
    WHERE namespace = $1
      AND is_active = true
      AND status = 'ready'
    LIMIT 1
    `,
    [namespace]
  );

  if (result.rows.length === 0) {
    throw new Error(`No active vector index for namespace: ${namespace}`);
  }

  return result.rows[0];
}

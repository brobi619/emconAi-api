import {
  DEFAULT_KB_SEARCH_COLLECTIONS,
  QdrantCollectionName,
} from "../../../config/qdrantCollections";
import { getActiveVectorIndex } from "../../../services/vectorIndex.service";
import { qdrantClient } from "../../../lib/qdrant";
import { embedText } from "../../../lib/embeddings";

export type KBCandidate = {
  source: "kb";
  collection: QdrantCollectionName;
  id: string;
  score: number;
  title?: string;
  snippet: string;
  metadata?: Record<string, any>;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function toSnippet(text: string, maxLen = 300) {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

export async function retrieveKBCandidates(params: {
  tenant_id?: string; // optional now; useful later
  queries: string[];
  top_k: number;
  collections?: readonly QdrantCollectionName[];
}): Promise<KBCandidate[]> {
  const activeIndex = (await getActiveVectorIndex("kb")) as {
    qdrant_collection: string;
    embedding_model_id: string;
    embedding_dim: number;
  };

  const collections = params.collections ?? DEFAULT_KB_SEARCH_COLLECTIONS;
  const top_k = clamp(params.top_k, 1, 50);

  // Pull a bit more per-collection/per-query, then merge down to top_k.
  const perQueryPerCollection = clamp(Math.ceil(top_k / 2), 5, 20);

  const all: KBCandidate[] = [];

  for (const q of params.queries) {
    const vector = await embedText(q);

    if (vector.length !== activeIndex.embedding_dim) {
      throw new Error(
        `Embedding dimension mismatch for KB index (expected ${activeIndex.embedding_dim}, got ${vector.length}, model_id=${activeIndex.embedding_model_id})`
      );
    }

    for (const collection of collections) {
      const filter: Record<string, any> = {
        must: [
          {
            key: "collection",
            match: { value: collection },
          },
        ],
      };

      if (params.tenant_id) {
        filter.must.push({
          key: "tenant_id",
          match: { value: params.tenant_id },
        });
      }

      const result = await qdrantClient.search(activeIndex.qdrant_collection, {
        vector,
        limit: perQueryPerCollection,
        with_payload: true,
        filter,
      });

      for (const point of result) {
        const payload: any = point.payload ?? {};
        const text =
          payload.text ?? payload.chunk_text ?? payload.content ?? "";
        const title = payload.title ?? payload.doc_title ?? payload.filename;
        const payloadCollection =
          (payload.collection as QdrantCollectionName | undefined) ??
          collection;

        all.push({
          source: "kb",
          collection: payloadCollection,
          id: String(point.id),
          score: Number(point.score ?? 0),
          title,
          snippet: toSnippet(text),
          metadata: payload,
        });
      }
    }
  }

  // De-dupe by collection + id, keep best score
  const best = new Map<string, KBCandidate>();
  for (const c of all) {
    const key = `${c.collection}:${c.id}`;
    const existing = best.get(key);
    if (!existing || c.score > existing.score) best.set(key, c);
  }

  // Sort by score descending and return top_k
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k);
}

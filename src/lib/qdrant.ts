const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "";

export type QdrantSearchParams = {
  vector: number[];
  limit: number;
  with_payload?: boolean | string[];
  filter?: Record<string, any>;
};

export type QdrantPoint = {
  id: string | number;
  score: number;
  payload?: Record<string, any>;
};

export const qdrantClient = {
  async search(
    collection: string,
    params: QdrantSearchParams
  ): Promise<QdrantPoint[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (QDRANT_API_KEY) {
      headers["api-key"] = QDRANT_API_KEY;
    }

    const resp = await fetch(
      `${QDRANT_URL}/collections/${collection}/points/search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      }
    );

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `Qdrant search failed: ${resp.status} ${resp.statusText} ${detail}`
      );
    }

    const json = (await resp.json()) as { result?: QdrantPoint[] };
    return Array.isArray(json.result) ? json.result : [];
  },
};


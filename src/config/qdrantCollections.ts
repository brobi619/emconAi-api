// src/config/qdrantCollections.ts

export type QdrantCollectionName =
  | "rfp_chunks"
  | "kb_past_performance"
  | "kb_resumes"
  | "kb_capabilities"
  | "kb_compliance_quality"
  | "kb_templates_boilerplate";

export const QDRANT_COLLECTIONS = {
  RFP: ["rfp_chunks"] as const,

  // Core KB collections we will search for candidate evidence
  KB_CORE: [
    "kb_past_performance",
    "kb_resumes",
    "kb_capabilities",
    "kb_compliance_quality",
  ] as const,

  // Optional KB collections that can be included if you want
  KB_OPTIONAL: ["kb_templates_boilerplate"] as const,
} as const;

/**
 * Default KB collections to search in most workflows.
 * Keep this small and stable.
 */
export const DEFAULT_KB_SEARCH_COLLECTIONS: readonly QdrantCollectionName[] = [
  ...QDRANT_COLLECTIONS.KB_CORE,
];

/**
 * If you ever want a "search absolutely everything KB" mode, use this.
 */
export const ALL_KB_SEARCH_COLLECTIONS: readonly QdrantCollectionName[] = [
  ...QDRANT_COLLECTIONS.KB_CORE,
  ...QDRANT_COLLECTIONS.KB_OPTIONAL,
];

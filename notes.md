# Vector DB Collection Structure (EMCON)

## Goals

- Keep retrieval **targeted** and explainable (few collections, clear purpose)
- Separate **customer-provided** RFP content from **internal** company KB evidence
- Support proposal workflows: **understand → cross-check → shortlist → draft**
- Avoid collection sprawl (no “one collection per doc type”)

---

## Collection Naming Convention

Use lowercase, snake_case. Prefix by domain.

### RFP Domain

- `rfp_chunks`

### KB Domain

- `kb_past_performance`
- `kb_resumes`
- `kb_capabilities`
- `kb_compliance_quality`
- `kb_templates_boilerplate` (optional)

If tenant separation is required later, prefer **payload filters** (for example `tenant_id`) over creating per-tenant collections unless scale demands otherwise.

---

## Collections and What Goes Where

### 1) `rfp_chunks`

**Purpose:** Authoritative solicitation content (the RFP itself)

**Typical documents**

- RFP PDF text
- Attachments provided with the RFP
- Amendments and clarifications

**Used for**

- RFP understanding and requirement extraction
- Clause and deliverables lookup
- Evaluation criteria identification

**Rule**

- Never store internal KB content here

---

### 2) `kb_past_performance`

**Purpose:** “We did this before” evidence

**Typical documents**

- Project descriptions
- Award summaries and performance highlights
- CPAR excerpts (where allowed)
- Customer references (sanitized as required)

**Retrieval intent**

- Scope match
- Customer or domain match
- Measurable outcomes and relevance

---

### 3) `kb_resumes`

**Purpose:** “We have people who can do this”

**Typical documents**

- Individual resumes or bios
- Role summaries (PM, QA lead, cybersecurity lead, etc.)
- Key personnel narratives

**Retrieval intent**

- Labor category match
- Certifications and clearances
- Relevant program experience

---

### 4) `kb_capabilities`

**Purpose:** “We can do this” (methods, tools, systems, services)

**Typical documents**

- Capability statements
- Service descriptions
- Tooling and platforms (CI/CD, GIS stack, QA tooling, etc.)
- Management or technical approaches (non-generic)

**Retrieval intent**

- Alignment to SOW tasks
- Technical approach compatibility

---

### 5) `kb_compliance_quality`

**Purpose:** “We can prove we meet requirements” (hard evidence)

**Typical documents**

- ISO certificates and scopes
- QA plans (NAVSEA-approved references, internal QMS docs)
- Safety plans
- Training certifications
- Policies and procedures relevant to compliance
- Audit-related documentation

**Retrieval intent**

- Evidence for requirements such as ISO, QA plans, safety programs, certifications

---

### 6) `kb_templates_boilerplate` (optional)

**Purpose:** Reusable writing blocks

**Typical documents**

- Corporate overview paragraphs
- Program management boilerplate
- Past performance format shells

**Rule**

- Keep separate so it does not pollute evidence-focused retrieval

---

## Common Vector Record Shape (Payload / Metadata)

### Required Fields (all collections)

- `tenant_id` (string): Owner of the data
- `doc_id` (string): Stable source document ID
- `chunk_id` (string): Stable chunk ID
- `title` (string): Document title
- `source_type` (enum): `rfp | kb`
- `collection` (string): Redundant but convenient
- `created_at` (ISO datetime)

### Recommended Fields

- `source_uri` (string): Storage location (R2, S3, local path, etc.)
- `page` (number): Page number for PDFs
- `section` (string): Section or heading name
- `tags` (string[]): Lightweight tags (for example `["ISO 9001", "QA"]`)
- `embedding_model` (string): For example `text-embedding-3-large`
- `embedding_dim` (number): Embedding vector size

### Compliance-Specific Fields (`kb_compliance_quality`)

- `doc_type` (enum): `iso_certificate | qa_plan | policy | procedure | training | audit_report`
- `standard` (string): For example `ISO 9001`, `ISO 27001`
- `issuer` (string): Registrar or authority
- `effective_date` (date)
- `expiration_date` (date)
- `scope` (string): What the certification or plan covers
- `evidence_level` (enum): `primary_document | summary | reference`

---

## Retrieval Rules of Thumb

- **RFP understanding:** search `rfp_chunks`
- **Compliance cross-check:** search `kb_compliance_quality` (optionally `kb_capabilities`)
- **KB candidate shortlist:** search across
  - `kb_past_performance`
  - `kb_resumes`
  - `kb_capabilities`
  - `kb_compliance_quality`
  - `kb_templates_boilerplate` (optional)

Prefer **filtering** by metadata (for example `tenant_id`, `doc_type`, `tags`) over creating additional collections.

---

## Things to Avoid

- Do not create a collection per ISO standard, customer, or proposal
- Do not mix RFP chunks and internal KB evidence in the same collection
- Do not rely solely on free-text for compliance (store structured metadata)

---

## Versioning and Embedding Changes

- Store `embedding_model` and `embedding_dim` with each vector
- If the embedding model changes:
  - Re-embed and reindex affected collections, or
  - Maintain parallel collections by version (only if scale requires)

---

## Design Principle Summary

- Few collections, clear intent
- Metadata over collection sprawl
- Evidence-first retrieval
- Explainable outputs for bid / no-bid and proposal drafting

# EMCON RFP Processing & Analysis Flow (Actual Implementation)

---

## A. Upload, processing, and vector indexing (current behavior)

| Step | What happens (plain English)                                                                                                                                                    | Route / file(s)                                                                              | Data written / read                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | User uploads an RFP file; API saves it to disk, computes a hash, creates the `rfps` record, creates an `rfp_runs` record, and starts the pipeline. Returns `rfp_id` + `run_id`. | `POST /rfps/upload` → `modules/rfps/routes/upload.ts` (orchestrator entry)                   | **Write:** local disk (`data/rfps/<rfpId>/file.pdf`), **PG:** `rfps`, `rfp_runs`, update `rfps.current_run_id` + `rfps.pipeline_*`    |
| 2    | Pipeline step: API loads the file, extracts raw text, chunks with overlap, and stores chunks tied to the RFP.                                                                   | Internal pipeline call → `POST /rfps/:id/process` → `modules/rfps/routes/index.ts`           | **Read:** local file; **Write:** **PG:** `rfp_chunks`, update `rfps.extraction_status`, `rfp_runs.stage/progress/message`             |
| 3    | Pipeline step: API reads all chunks for the RFP and creates embeddings for each chunk.                                                                                          | Internal pipeline call → `POST /rfps/:id/index` → `routes/indexOne.ts` + `lib/embeddings.ts` | **Read:** **PG:** `rfp_chunks`; **Write:** progress to `rfp_runs`, mirror to `rfps.pipeline_*`                                        |
| 4    | Pipeline step: Chunk vectors are upserted into Qdrant; RFP is marked indexed and run is completed (success or failure).                                                         | same as step 3 → `lib/qdrant.ts`                                                             | **Write:** **Qdrant:** `rfp_chunks__bge_small_en_v1_5__384`; **PG:** `rfps.qdrant_indexed_at`, `rfp_runs.status/stage/progress/error` |
| 5    | UI subscribes to run status updates for live progress (“Step X of X …”).                                                                                                        | `GET /rfps/:runId/events` → `modules/rfps/routes/runEvents.ts`                               | **Read:** **PG:** `rfp_runs` (streamed via SSE)                                                                                       |

**Notes**

- `rfp_runs` is the authoritative record of pipeline execution and history.
- `rfps.pipeline_*` fields mirror the latest run for fast grid rendering without joining runs.

---

---

## B. Metadata & understanding (stored outputs)

| Step | What happens                                                                                                | Route / file(s)                                                                      | Data written / read                                             |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 5    | Guarded metadata extraction runs only if chunks + vectors exist; LLM extracts structured fields for DB use. | `POST /rfps/:id/extract-metadata` → `extractMetadata.ts` + `prompts/meta_v1.ts`      | **Read:** `rfp_chunks`; **Write:** `rfps.extracted_fields_json` |
| 6    | “RFP Understanding” pass summarizes scope, requirements, and risks into strict JSON and stores it.          | `POST /rfps/:id/understand` → `understandRfp.ts` + `prompts/rfp_understanding_v1.ts` | **Write:** **PG:** `rfp_analyses`                               |

---

## C. KB candidate retrieval (RAG logic – accurate to your code)

| Step | What happens                                                                                         | Route / file(s)                                           | Data read                       |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| 7    | API receives request to find relevant KB evidence for this RFP (past performance, resumes, etc.).    | `POST /rfps/:id/kb-candidates` → `routes/kbCandidates.ts` | —                               |
| 8    | System decides which KB collections to search based on request mode (`default` vs `all`).            | `config/qdrantCollections.ts`                             | Reads static collection config  |
| 9    | Query embeddings are generated from RFP-derived text using the same embedding model as KB vectors.   | `lib/embeddings.ts`                                       | —                               |
| 10   | Qdrant is queried collection-by-collection, retrieving top-K candidates per collection.              | `services/kbRetrieval.ts` → `lib/qdrant.ts`               | **Read:** KB Qdrant collections |
| 11   | Retrieved candidates are grouped by type (PP, resumes, capabilities, compliance).                    | `kbRetrieval.ts`                                          | In-memory                       |
| 12   | Selection logic ranks, deduplicates, and trims candidates, producing recommendations + gaps.         | `kbCandidateSelection.ts`                                 | In-memory                       |
| 13   | API returns a structured response with candidates, selections, and explicit “no data” gaps if empty. | `routes/kbCandidates.ts`                                  | Response only (no DB write)     |

**Important design note (by design):**

If KB collections are empty or unindexed, the system returns gaps and does not fabricate evidence.

---

## D. Final RFP analysis (stored, not recomputed)

| Step | What happens                                                                                         | Route / file(s)                                                       | Data written / read               |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| 14   | Analysis endpoint builds authoritative context from RFP chunks (and later can accept KB selections). | `POST /rfps/:id/analyze` → `analyzeRfp.ts` + `prompts/analysis_v1.ts` | **Read:** `rfp_chunks`            |
| 15   | LLM generates final structured analysis JSON (bid/no-bid, risks, requirements, gaps).                | same as step 14                                                       | In-memory                         |
| 16   | Analysis JSON is persisted so the UI doesn’t re-run the model on every view.                         | same as step 14                                                       | **Write:** **PG:** `rfp_analyses` |

---

## Mental model for future developers

- **RFP chunks in Postgres are the authoritative source of truth.**
- **Qdrant is used strictly for similarity search** (RFP chunks and KB evidence).
- **KB retrieval is a separate, explicit step** that queries configured collections, ranks results, and returns evidence or gaps.
- **All meaningful LLM outputs** (understanding, analysis) are stored in `rfp_analyses` so the system is deterministic, auditable, and fast to render.

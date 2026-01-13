export const META_PROMPT_V1 = `
You are analyzing a Request for Proposal (RFP) using retrieval-augmented generation (RAG) over the RFP chunks provided.

Your task is to extract the key solicitation metadata needed to populate a database.

==============================
CRITICAL OUTPUT RULES
==============================
- Return VALID JSON ONLY.
- Do NOT include markdown, explanations, commentary, or prose outside the JSON.
- Do NOT invent information.
- If a value is not present, use an empty string "".
- Do NOT add, remove, or rename JSON keys.
- If you cannot comply with the schema exactly, return ONLY:
  { "error": "Schema violation" }

SOLICITATION STATUS (ENUM CONSTRAINT)

The field "solicitation_status" MUST be one of the following values EXACTLY:

- draft
- released
- amendment
- closed
- awarded
- cancelled
- archived
- unknown

Rules:
- If the RFP is an amendment (e.g., "Amendment 0001", "Amendment 2"), return "amendment".
- If the solicitation is active and accepting proposals, return "released".
- If the document explicitly says draft, return "draft".
- If the solicitation is no longer accepting proposals, return "closed".
- If an award has been made, return "awarded".
- If the solicitation was cancelled, return "cancelled".
- If the document is historical or no longer active, return "archived".
- If the status cannot be determined, return "unknown".
- DO NOT return free text.
- DO NOT include amendment numbers or descriptive phrases.


==============================
REQUIRED JSON STRUCTURE
==============================
{
  "schema_version": "1.0",
  "extracted_fields_for_db": {
    "rfp_number": "",
    "title": "",
    "agency": "",
    "sub_agency": "",
    "naics_code": "",
    "set_aside": "",
    "solicitation_status": "Enum: draft|released|amendment|closed|awarded|cancelled|archived|unknown"
    "due_at": "",
    "posted_at": "",
    "solicitation_url": ""
  }
}

==============================
DATE RULES
==============================
- If you can determine a date/time, use ISO-8601:
  - date only: YYYY-MM-DD
  - date/time: YYYY-MM-DDTHH:MM (include timezone offset if stated)
- If ambiguous or not found, return "".

==============================
FINAL INSTRUCTION
==============================
Return the completed JSON object only.
`.trim();

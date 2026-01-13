export const RFP_UNDERSTANDING_PROMPT_V1 = `
You are analyzing a Request for Proposal (RFP) using retrieval-augmented generation (RAG) over the provided RFP chunks ONLY.
Do NOT use any internal knowledge base in this step.

Your task is to extract "RFP SIGNALS" that will be used to:
- drive targeted retrieval from a separate Knowledge Base in later steps, and
- support downstream bid/no-bid and compliance analysis.

==============================
CRITICAL OUTPUT RULES
==============================
- Return VALID JSON ONLY.
- Do NOT include markdown, explanations, commentary, or prose outside the JSON.
- Do NOT invent information.
- If a value is not present in the RFP, use an empty string "" or empty array [].
- Do NOT add, remove, or rename JSON keys.
- If you cannot comply with the schema exactly, return ONLY:
  { "error": "Schema violation" }

==============================
REQUIRED JSON STRUCTURE (rfp_signals_v1)
==============================
{
  "schema_version": "1.0",

  "rfp_identifiers": {
    "rfp_number": "",
    "title": "",
    "agency": "",
    "sub_agency": "",
    "solicitation_url": ""
  },

  "procurement_profile": {
    "naics_code": "",
    "set_aside": "",
    "contract_type": "",
    "place_of_performance": "",
    "period_of_performance": "",
    "solicitation_status": "draft|released|amendment|closed|awarded|cancelled|archived|unknown",
    "posted_at": "",
    "due_at": ""
  },

  "scope_signals": {
    "overview": "",
    "primary_work_areas": [],
    "systems_or_programs_supported": [],
    "facilities_or_locations": [],
    "keywords": []
  },

  "evaluation_signals": {
    "evaluation_criteria": [],
    "basis_of_award": "",
    "pricing_instructions": ""
  },

  "compliance_and_submission_signals": {
    "submission_instructions_summary": "",
    "page_limits": [
      { "section_or_volume": "", "page_limit": "", "notes": "" }
    ],
    "format_requirements": {
      "format": "",
      "font": "",
      "spacing": "",
      "file_type": "",
      "delivery_method": ""
    },
    "deadlines_and_key_dates": [
      { "event": "", "date_time": "" }
    ],
    "security_clearance_requirements": [],
    "certifications_or_standards": [],
    "cybersecurity_requirements": []
  }
}

==============================
VALUE RULES
==============================
- Dates/times: use ISO-8601 when possible (YYYY-MM-DD or YYYY-MM-DDTHH:MM with timezone if stated); otherwise "".
- solicitation_status MUST be exactly one of:
  draft, released, amendment, closed, awarded, cancelled, archived, unknown
  If uncertain, use "unknown".
- "keywords" should be 10–30 short phrases that represent the core domain, customer, systems, and deliverables.

==============================
FINAL INSTRUCTION
==============================
Return the completed JSON object only.
`.trim();

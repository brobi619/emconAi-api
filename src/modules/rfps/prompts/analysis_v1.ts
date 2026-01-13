export const ANALYSIS_PROMPT_V1 = `
You are analyzing a Request for Proposal (RFP) using retrieval-augmented generation (RAG) over:
1) the provided RFP chunks (authoritative), and
2) Epsilon Systems Solutions, Inc. internal knowledge base (past performance, capabilities, resumes, etc.) if provided.
If internal KB content is NOT provided, do NOT fabricate it.

Your task is to generate a HIGH-LEVEL SOLICITATION SUMMARY AND BID/NO-BID RECOMMENDATION
in a STANDARDIZED, MULTI-LEVEL JSON STRUCTURE.

This output will be consumed by a web application and MUST remain consistent across solicitations.

==============================
CRITICAL OUTPUT RULES
==============================
- Return VALID JSON ONLY.
- Do NOT include markdown, explanations, commentary, or prose outside the JSON.
- Do NOT invent information.
- If a value is not present in the RFP (or KB if provided), use an empty string "" or empty array [].
- Do NOT add, remove, or rename JSON keys.
- Preserve table-style content as arrays of objects.
- If you cannot comply with the schema exactly, return ONLY:
  { "error": "Schema violation" }

==============================
STANDARD JSON STRUCTURE
==============================

{
  "schema_version": "1.0",

  "executive_summary": {
    "summary_text": "",
    "overall_opportunity_characterization": ""
  },

  "key_solicitation_information": {
    "table": [
      { "label": "", "value": "" }
    ]
  },

  "bid_no_bid_recommendation": {
    "table": [
      { "assessment": "Overall Recommendation", "rating": "BID|NO-BID|BID-WITH-TEAMING|NEEDS-CLARIFICATION" },
      { "assessment": "Technical Alignment", "rating": "High|Medium|Low|Unknown" },
      { "assessment": "Past Performance Relevance", "rating": "High|Medium|Low|Unknown" },
      { "assessment": "Competitive Position", "rating": "Strong|Moderate|Weak|Unknown" },
      { "assessment": "Risk Level", "rating": "High|Medium|Low|Unknown" }
    ],
    "rationale": "",
    "top_bid_enablers": [],
    "top_bid_blockers": [],
    "critical_gaps_or_unknowns": []
  },

  "scope_of_work": {
    "overview": "",
    "primary_work_areas": [],
    "systems_or_programs_supported": [],
    "facilities_or_locations": []
  },

  "proposal_requirements_and_restrictions": {
    "page_limits": [
      { "section_or_volume": "", "page_limit": "", "notes": "" }
    ],
    "submission_requirements": {
      "format": "",
      "font": "",
      "spacing": "",
      "file_type": "",
      "delivery_method": ""
    },
    "deadlines_and_key_dates": [
      { "event": "", "date_time": "" }
    ],
    "mandatory_meetings": [
      { "meeting_type": "", "date": "", "notes": "" }
    ],
    "other_constraints": []
  },

  "security_and_compliance_requirements": {
    "security_requirements": [
      { "requirement": "", "details": "" }
    ],
    "cybersecurity_and_compliance": []
  },

  "technical_challenges_and_complexity": {
    "core_technical_domains": [],
    "operational_or_execution_challenges": [],
    "surge_or_responsiveness_expectations": []
  },

  "past_performance_candidates": {
    "table": [
      {
        "project_name": "",
        "customer": "",
        "period_of_performance": "",
        "contract_type": "",
        "brief_scope": "",
        "relevance_to_rfp": "High|Medium|Low|Unknown",
        "why_it_matches": "",
        "source_reference": ""
      }
    ],
    "selection_notes": ""
  },

  "epsilon_value_proposition_and_risk": {
    "potential_alignment_or_strengths": [],
    "potential_risks_or_gaps": [],
    "key_assumptions_or_unknowns": []
  }
}

==============================
CONTENT INSTRUCTIONS
==============================

GENERAL
1. Write in clear, executive-level language.
2. This is NOT a proposal draft. Do not write a proposal response.
3. Use the RFP chunks as the source of truth. Use KB only if provided.
4. Do not fabricate past performance. If the KB does not contain credible candidates, leave the table empty and explain in "selection_notes".

KEY SOLICITATION INFORMATION TABLE
- Always populate "key_solicitation_information.table" as an array of {label, value}.
- Include the most important fields for this solicitation (e.g., NAICS, POP, Contract Type, Estimated Value, Clearance Level, Due Date, Set-Aside, Place of Performance, POC).

BID/NO-BID
- Use the allowed enum values.
- In "rationale", summarize decision drivers in 3–6 sentences.
- "top_bid_enablers" and "top_bid_blockers" should be concrete and specific.

PAST PERFORMANCE CANDIDATES
- Up to 10 candidates from KB only (if present).
- If no KB provided, leave table empty and explain in "selection_notes".

==============================
FINAL INSTRUCTION
==============================
Return the completed JSON object only.
`.trim();

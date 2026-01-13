import { getOpenAIClient } from "../../../lib/openaiClient";

export type KBCandidate = {
  source: "kb";
  collection: string;
  id: string;
  score: number;
  title?: string;
  snippet: string;
  metadata?: Record<string, any>;
};

export type KBCandidateSelection = {
  win_themes: string[];
  recommended_pp_ids: string[];
  recommended_resume_ids: string[];
  recommended_capability_ids: string[];
  recommended_compliance_evidence_ids: string[];
  gaps: string[];
  notes: string[];
};

const KB_CANDIDATE_SELECTION_PROMPT_V1 = `
You are selecting the BEST internal knowledge base (KB) evidence to support a proposal response.

Inputs:
1) rfp_understanding_json (authoritative for what the customer wants)
2) kb_candidates (retrieved chunks from internal KB). If KB is empty, say so and do NOT fabricate.

Your task:
Return VALID JSON ONLY that identifies:
- the strongest matching past performance references
- the most relevant resumes/roles
- the most relevant capability statements
- the most relevant compliance/quality evidence (ISO certs, QA plans, policies, etc.)
- gaps / risks where KB coverage appears weak

==============================
CRITICAL OUTPUT RULES
==============================
- Return VALID JSON ONLY. No markdown.
- Use ONLY the provided kb_candidates for evidence. Do not invent IDs or claims.
- recommended_*_ids MUST be IDs from kb_candidates items.
- If nothing matches, return empty arrays and explain in gaps.
- Keep it high-level; do not write proposal text yet.
- Put rationale in notes (short bullets), not long narrative.

==============================
OUTPUT JSON SCHEMA
==============================
{
  "win_themes": string[],
  "recommended_pp_ids": string[],
  "recommended_resume_ids": string[],
  "recommended_capability_ids": string[],
  "recommended_compliance_evidence_ids": string[],
  "gaps": string[],
  "notes": string[]
}
`.trim();

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function defaultSelection(extraGap?: string): KBCandidateSelection {
  return {
    win_themes: [],
    recommended_pp_ids: [],
    recommended_resume_ids: [],
    recommended_capability_ids: [],
    recommended_compliance_evidence_ids: [],
    gaps: extraGap ? [extraGap] : [],
    notes: [],
  };
}

function idsFrom(cands: KBCandidate[]) {
  return new Set(cands.map((c) => String(c.id)));
}

export async function selectKBCandidates(params: {
  rfp_understanding_json: any;
  kb_candidates: KBCandidate[];
}): Promise<KBCandidateSelection> {
  const { rfp_understanding_json, kb_candidates } = params;

  if (!kb_candidates || kb_candidates.length === 0) {
    return defaultSelection(
      "No KB candidates were retrieved (KB may be empty or not indexed yet)."
    );
  }

  const openai = getOpenAIClient();
  const model = process.env.KB_SELECTION_OPEN_AI_MODEL || "gpt-5-mini";

  const userPayload = {
    rfp_understanding_json,
    kb_candidates,
  };

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: KB_CANDIDATE_SELECTION_PROMPT_V1 },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseJson<KBCandidateSelection>((raw || "").trim());

  if (!parsed) {
    return defaultSelection("LLM selection returned non-JSON output.");
  }

  // Enforce “IDs must come from kb_candidates”
  const allowed = idsFrom(kb_candidates);

  const filterIds = (arr: any): string[] =>
    Array.isArray(arr) ? arr.map(String).filter((id) => allowed.has(id)) : [];

  return {
    win_themes: Array.isArray(parsed.win_themes)
      ? parsed.win_themes.map(String)
      : [],
    recommended_pp_ids: filterIds(parsed.recommended_pp_ids),
    recommended_resume_ids: filterIds(parsed.recommended_resume_ids),
    recommended_capability_ids: filterIds(parsed.recommended_capability_ids),
    recommended_compliance_evidence_ids: filterIds(
      parsed.recommended_compliance_evidence_ids
    ),
    gaps: Array.isArray(parsed.gaps)
      ? parsed.gaps.map(String)
      : ["LLM selection output missing 'gaps'."],
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
  };
}

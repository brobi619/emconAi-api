import { getOpenAIClient } from "../../../lib/openaiClient";
import { getKbPrompt } from "../prompts";

function safeParseJson(text: string) {
  try {
    return JSON.parse((text ?? "").trim());
  } catch (err) {
    throw new Error("Failed to parse JSON from model");
  }
}

function normalizeText(s: any) {
  if (!s && s !== 0) return "";
  return String(s)
    .toLowerCase()
    .replace(/[\p{P}$+<>\[\]{}"'`~:;=\/\\|@#%^&*_?(),.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDateToYMD(input: any) {
  if (!input && input !== 0) return "";
  const s = String(input).trim();
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDollarToNumber(input: any) {
  if (input === null || input === undefined || input === "") return null;
  const s = String(input).replace(/[^0-9.\-]+/g, "");
  const n = Number(s);
  if (isNaN(n)) return null;
  return n;
}

type FieldType = "string" | "string[]" | "number" | "date";

const SCHEMAS: Record<string, Record<string, FieldType>> = {
  resumes: {
    person_name: "string",
    role_title: "string",
    email: "string",
    clearance: "string",
    certifications: "string[]",
    skills: "string[]",
    employers: "string[]",
    years_experience: "number",
  },
  past_performance: {
    customer_name: "string",
    pop_end_date: "date",
    project_name: "string",
    pop_start_date: "date",
    contract_value_usd: "number",
    duration_months: "number",
    contract_type: "string",
    naics: "string",
    psc: "string",
    place_of_performance: "string",
    prime_or_sub: "string",
    keywords: "string[]",
  },
  capabilities: {
    capability_area: "string",
    keywords: "string[]",
    tools_platforms: "string[]",
    methodologies: "string[]",
    standards_supported: "string[]",
    industries: "string[]",
  },
  compliance: {
    standard: "string",
    evidence_type: "string",
    issuer: "string",
    effective_date: "date",
    expiration_date: "date",
    scope: "string",
    evidence_level: "string",
  },
  templates: {
    template_category: "string",
    intended_use: "string",
    audience: "string",
    applicable_sections: "string[]",
    tone: "string",
  },
  other: {
    label: "string",
    topic_keywords: "string[]",
    suggested_collection: "string",
    notes: "string",
  },
};

function ensureFieldsForType(
  kbTypeRaw: string,
  inputFields: any,
  warnings: string[] = []
) {
  const kbType = (kbTypeRaw || "other").toLowerCase();
  const schema = SCHEMAS[kbType] ?? SCHEMAS["other"];
  const out: Record<string, any> = {};

  Object.entries(schema).forEach(([key, ftype]) => {
    const val = inputFields?.[key];
    if (ftype === "string") {
      out[key] = val ? String(val) : "";
    } else if (ftype === "string[]") {
      if (!val) out[key] = [];
      else if (Array.isArray(val))
        out[key] = val.slice(0, 20).map((v) => String(v));
      else
        out[key] = String(val)
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20);
    } else if (ftype === "number") {
      if (val === null || val === undefined || val === "") out[key] = null;
      else {
        const n = typeof val === "number" ? val : parseDollarToNumber(val);
        out[key] = n === null ? null : n;
        if (n === null && val) warnings.push(`Failed parse number for ${key}`);
      }
    } else if (ftype === "date") {
      if (!val) out[key] = "";
      else {
        const d = normalizeDateToYMD(val);
        out[key] = d || "";
        if (!d) warnings.push(`Failed parse date for ${key}`);
      }
    }
  });

  // add normalization helper fields where applicable
  if (kbType === "resumes") {
    out["person_name_norm"] = out.person_name
      ? normalizeText(out.person_name)
      : "";
  }
  if (kbType === "past_performance") {
    out["customer_name_norm"] = out.customer_name
      ? normalizeText(out.customer_name)
      : "";
  }
  if (kbType === "capabilities") {
    out["capability_area_norm"] = out.capability_area
      ? normalizeText(out.capability_area)
      : "";
  }
  if (kbType === "compliance") {
    out["standard_norm"] = out.standard ? normalizeText(out.standard) : "";
  }
  if (kbType === "templates") {
    out["template_category_norm"] = out.template_category
      ? normalizeText(out.template_category)
      : "";
  }
  if (kbType === "other") {
    out["label_norm"] = out.label ? normalizeText(out.label) : "";
  }

  return { fields: out, warnings };
}

export async function extractKbMetadata({
  kbType,
  fullText,
  filename,
  title,
}: {
  kbType: string;
  fullText: string;
  filename: string;
  title?: string | null;
}) {
  const text = (fullText ?? "").trim();
  const preview = text.slice(0, 4000); // give model a useful window

  const openai = getOpenAIClient();
  const model = process.env.PROJECT_DESCRIPTION_OPEN_AI_MODEL || "gpt-5-mini";

  const prompt = getKbPrompt(kbType, preview, filename, title);

  const completion = await openai.chat.completions.create({
    model,
    temperature: 1,
    messages: [
      { role: "system", content: "You are a JSON-output-only extractor." },
      { role: "user", content: prompt },
    ],
  });

  const textOut = completion.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseJson(textOut);

  const combinedWarnings: string[] = [];
  if (Array.isArray(parsed.warnings))
    combinedWarnings.push(...parsed.warnings.filter(Boolean));

  const inputFields = parsed.fields ?? parsed.extracted_json ?? {};
  const ensured = ensureFieldsForType(kbType, inputFields, combinedWarnings);

  return {
    kb_type: parsed.kb_type ?? kbType ?? "other",
    title: parsed.title ?? title ?? filename,
    filename: parsed.filename ?? filename,
    summary: parsed.summary ?? text.slice(0, 400),
    tags: parsed.tags ?? [],
    fields: ensured.fields ?? {},
    confidence: parsed.confidence ?? { overall: 0.5 },
    warnings: ensured.warnings ?? combinedWarnings,
  };
}

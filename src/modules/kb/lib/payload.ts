import { randomUUID } from "crypto";

function normalizeText(s: any) {
  if (!s && s !== 0) return "";
  return String(s)
    .toLowerCase()
    .replace(/[\p{P}$+<>\[\]{}"'`~:;=\/\\|@#%^&*_?(),.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asString(v: any) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function asNumber(v: any) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).replace(/[^0-9.\-]+/g, "");
  const n = Number(s);
  if (isNaN(n)) return null;
  return n;
}

function asDateYMD(v: any) {
  if (!v && v !== 0) return "";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function asStringArray(v: any) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).slice(0, 20);
  return String(v)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function buildPayloadForDoc(doc: any, extraction: any) {
  const fields = doc?.reviewed_fields ?? extraction?.fields ?? {};
  const kbType = (doc?.kb_type || "other").toLowerCase();

  const common = {
    tenant_id: doc.tenant_id,
    doc_id: doc.id,
    title: doc.title,
    source_type: "kb",
    collection: doc.kb_type,
    created_at: new Date().toISOString(),
    source_uri: doc.storage_path,
    kb_type: doc.kb_type,
  } as Record<string, any>;

  const out: Record<string, any> = {};

  if (kbType === "resumes") {
    out.person_name = asString(fields.person_name ?? fields.name ?? "");
    out.person_name_norm = normalizeText(out.person_name);
    out.role_title = asString(fields.role_title ?? fields.title ?? "");
    out.email = asString(fields.email ?? "");
    out.clearance = asString(fields.clearance ?? "");
    out.certifications = asStringArray(fields.certifications);
    out.skills = asStringArray(fields.skills);
    out.employers = asStringArray(fields.employers);
    out.years_experience = asNumber(fields.years_experience);
  } else if (kbType === "past_performance") {
    out.customer_name = asString(fields.customer_name ?? "");
    out.customer_name_norm = normalizeText(out.customer_name);
    out.pop_end_date = asDateYMD(fields.pop_end_date ?? "");
    out.project_name = asString(fields.project_name ?? "");
    out.pop_start_date = asDateYMD(fields.pop_start_date ?? "");
    out.contract_value_usd = asNumber(fields.contract_value_usd);
    out.duration_months = asNumber(fields.duration_months);
    out.contract_type = asString(fields.contract_type ?? "");
    out.naics = asString(fields.naics ?? "");
    out.psc = asString(fields.psc ?? "");
    out.place_of_performance = asString(fields.place_of_performance ?? "");
    out.prime_or_sub = asString(fields.prime_or_sub ?? "");
    out.keywords = asStringArray(fields.keywords);
  } else if (kbType === "capabilities") {
    out.capability_area = asString(fields.capability_area ?? "");
    out.capability_area_norm = normalizeText(out.capability_area);
    out.keywords = asStringArray(fields.keywords);
    out.tools_platforms = asStringArray(fields.tools_platforms);
    out.methodologies = asStringArray(fields.methodologies);
    out.standards_supported = asStringArray(fields.standards_supported);
    out.industries = asStringArray(fields.industries);
  } else if (kbType === "compliance" || kbType === "compliance_quality") {
    out.standard = asString(fields.standard ?? "");
    out.standard_norm = normalizeText(out.standard);
    out.evidence_type = asString(fields.evidence_type ?? "");
    out.issuer = asString(fields.issuer ?? "");
    out.effective_date = asDateYMD(fields.effective_date ?? "");
    out.expiration_date = asDateYMD(fields.expiration_date ?? "");
    out.scope = asString(fields.scope ?? "");
    out.evidence_level = asString(fields.evidence_level ?? "");
  } else if (kbType === "templates" || kbType === "templates_boilerplate") {
    out.template_category = asString(fields.template_category ?? "");
    out.template_category_norm = normalizeText(out.template_category);
    out.intended_use = asString(fields.intended_use ?? "");
    out.audience = asString(fields.audience ?? "");
    out.applicable_sections = asStringArray(fields.applicable_sections);
    out.tone = asString(fields.tone ?? "");
  } else {
    out.label = asString(fields.label ?? "");
    out.label_norm = normalizeText(out.label);
    out.topic_keywords = asStringArray(fields.topic_keywords);
    out.suggested_collection = asString(fields.suggested_collection ?? "");
    out.notes = asString(fields.notes ?? "");
  }

  // attach common and type-specific
  return { ...common, ...out };
}

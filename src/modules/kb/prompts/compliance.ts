import { buildBasePrompt } from "./base";

export function getCompliancePrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: compliance\n\nField dictionary:\n- standard (string) [REQUIRED]\n- evidence_type (string) [REQUIRED - certificate|policy|procedure|plan|audit|training|other]\n- issuer (string) [OPTIONAL]\n- effective_date (YYYY-MM-DD) [OPTIONAL]\n- expiration_date (YYYY-MM-DD) [OPTIONAL]\n- scope (string) [OPTIONAL]\n- evidence_level (string) [OPTIONAL - primary_document|summary|reference]\n\nInstructions:\n- Normalize dates to YYYY-MM-DD when possible else empty + warning. Include standard_norm: lowercased, punctuation removed.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

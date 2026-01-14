import { buildBasePrompt } from "./base";

export function getResumesPrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: resumes\n\nField dictionary:\n- person_name (string) [REQUIRED]\n- role_title (string) [REQUIRED]\n- email (string) [OPTIONAL]\n- clearance (string) [OPTIONAL]\n- certifications (string[]) [OPTIONAL]\n- skills (string[]) [OPTIONAL]\n- employers (string[]) [OPTIONAL]\n- years_experience (number) [OPTIONAL]\n\nInstructions:\n- Ensure the top-level fields object contains all keys above; required keys must be present (empty string if not found). Optional keys should be arrays or empty when absent.\n- Also produce person_name_norm: lowercased, punctuation removed, collapsed spaces.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

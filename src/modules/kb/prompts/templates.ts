import { buildBasePrompt } from "./base";

export function getTemplatesPrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: templates\n\nField dictionary:\n- template_category (string) [REQUIRED]\n- intended_use (string) [REQUIRED]\n- audience (string) [OPTIONAL]\n- applicable_sections (string[]) [OPTIONAL]\n- tone (string) [OPTIONAL]\n\nInstructions:\n- Produce template_category_norm: lowercased, punctuation removed, collapsed spaces.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

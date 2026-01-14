import { buildBasePrompt } from "./base";

export function getOtherPrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: other\n\nField dictionary:\n- label (string) [REQUIRED]\n- topic_keywords (string[]) [REQUIRED - 3-10 items]\n- suggested_collection (string) [OPTIONAL]\n- notes (string) [OPTIONAL]\n\nInstructions:\n- Produce label_norm: lowercased, punctuation removed, collapsed spaces.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

import { buildBasePrompt } from "./base";

export function getCapabilitiesPrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: capabilities\n\nField dictionary:\n- capability_area (string) [REQUIRED]\n- keywords (string[]) [REQUIRED - 3-10 items]\n- tools_platforms (string[]) [OPTIONAL]\n- methodologies (string[]) [OPTIONAL]\n- standards_supported (string[]) [OPTIONAL]\n- industries (string[]) [OPTIONAL]\n\nInstructions:\n- Ensure fields contains capability_area and keywords (keywords may be empty array if not present). Limit lists to 20 items. Produce capability_area_norm: lowercased, punctuation removed, collapsed spaces.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

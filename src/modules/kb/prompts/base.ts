export function buildBasePrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const fileLine = filename ? `Filename: ${filename}\n` : "";
  const titleLine = title ? `Title: ${title}\n` : "";

  return (
    `You are a strict JSON extractor for Knowledge Base documents.\n\n` +
    `Rules:\n` +
    `- Use ONLY the DOCUMENT text provided below; do NOT invent facts. If a value is not present, return an empty string, empty array, or null as appropriate.\n` +
    `- Output exactly one JSON object and nothing else. The object MUST include the keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.\n` +
    `- Dates must be normalized to YYYY-MM-DD when possible, else empty and add a warning.\n` +
    `- Numeric dollar amounts should be parsed into numbers (USD) when possible, else empty and add a warning.\n` +
    `- For list fields, limit to max 20 items.\n` +
    `- Confidence should be an object like { overall: 0.0-1.0 } and warnings should be an array of short strings.\n\n` +
    `DOCUMENT METADATA:\n` +
    fileLine +
    titleLine +
    `\nDOCUMENT:\n---\n` +
    preview +
    `\n---\n\n`
  );
}

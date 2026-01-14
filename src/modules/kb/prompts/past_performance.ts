import { buildBasePrompt } from "./base";

export function getPastPerformancePrompt(
  preview: string,
  filename?: string,
  title?: string
) {
  const base = buildBasePrompt(preview, filename, title);
  return (
    base +
    `Type: past_performance\n\nField dictionary:\n- customer_name (string) [REQUIRED]\n- pop_end_date (YYYY-MM-DD string) [REQUIRED]\n- project_name (string) [OPTIONAL]\n- pop_start_date (YYYY-MM-DD string) [OPTIONAL]\n- contract_value_usd (number) [OPTIONAL]\n- duration_months (number) [OPTIONAL]\n- contract_type (string) [OPTIONAL]\n- naics (string) [OPTIONAL]\n- psc (string) [OPTIONAL]\n- place_of_performance (string) [OPTIONAL]\n- prime_or_sub (string: prime|sub|unknown) [OPTIONAL]\n- keywords (string[]) [OPTIONAL]\n\nInstructions:\n- Ensure fields contains all keys above. Required fields must be present (empty if missing). Normalize dates to YYYY-MM-DD or empty + add warning. Parse dollar amounts to numbers.\n- Also produce customer_name_norm: lowercased, punctuation removed, collapsed spaces.\n\nReturn JSON with keys: kb_type, title, filename, summary, tags, fields, confidence, warnings.`
  );
}

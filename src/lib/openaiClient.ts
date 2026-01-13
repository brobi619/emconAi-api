import OpenAI from "openai";

const apiKey = process.env.PROJECT_DESCRIPTION_OPEN_AI_KEY;

if (!apiKey) {
  // Do not throw on import; throw only when used.
  // This lets the server boot even before you add the key.
}

export function getOpenAIClient() {
  const key = process.env.PROJECT_DESCRIPTION_OPEN_AI_KEY;
  if (!key) {
    throw new Error("Missing env var PROJECT_DESCRIPTION_OPEN_AI_KEY");
  }
  return new OpenAI({ apiKey: key });
}

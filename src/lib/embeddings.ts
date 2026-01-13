const TEI_URL = process.env.TEI_URL ?? "http://localhost:8081";

export async function embedText(text: string): Promise<number[]> {
  const input = (text ?? "").trim();

  const resp = await fetch(`${TEI_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [input] }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `TEI embed failed: ${resp.status} ${resp.statusText} ${detail}`
    );
  }

  const data = (await resp.json()) as number[][];
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0])) {
    throw new Error("TEI embed returned unexpected response shape");
  }

  return data[0];
}


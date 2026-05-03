export async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes <= maxBytes) {
      chunks.push(value);
      continue;
    }
    const remaining = Math.max(0, maxBytes - (bytes - value.byteLength));
    if (remaining > 0) chunks.push(value.slice(0, remaining));
    truncated = true;
    await reader.cancel().catch(() => undefined);
    break;
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
  };
}

export async function readJsonResponse<T>(response: Response, {
  label,
  maxBytes = 512000,
  fallback,
}: {
  label: string;
  maxBytes?: number;
  fallback?: T;
}): Promise<T> {
  const body = await readResponseText(response, maxBytes);
  if (!body.text.trim()) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} returned an empty JSON response.`);
  }
  try {
    return JSON.parse(body.text) as T;
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

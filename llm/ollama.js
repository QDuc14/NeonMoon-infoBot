// llm/ollama.js
import 'dotenv/config';

/**
 * Simple chat wrapper for Ollama's /api/chat endpoint.
 * Requires Node 18+ (global fetch).
 */
export async function ollamaChat({ messages, model, options = {}, stream = false }) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const mdl = model || process.env.OLLAMA_MODEL || 'mistral:7b';

  let mergedOptions = options;
  try {
    if (process.env.OLLAMA_OPTIONS_JSON) {
      mergedOptions = { ...JSON.parse(process.env.OLLAMA_OPTIONS_JSON), ...options };
    }
  } catch {
    console.warn('[ollama] Failed parsing OLLAMA_OPTIONS_JSON, ignoring.');
  }

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: mdl, messages, stream, options: mergedOptions })
  });

  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`[ollama] HTTP ${res.status} - ${text}`);
  }

  const data = await res.json();
  return data?.message?.content || '';
}

export function chunkDiscordMessage(text, maxLen = 1900) {
  const chunks = [];
  let remaining = text || '';
  while (remaining.length > maxLen) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

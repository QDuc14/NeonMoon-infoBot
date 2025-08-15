import 'dotenv/config';

/**
 * Ollama chat helpers (Node 18+)
 * - ollamaChat: non-streaming, returns a full string
 * - ollamaStream: async generator for streaming tokens
 * - ollamaStreamToString: consume stream to a single string
 * - chunkDiscordMessage: split long replies cleanly for Discord
 */

const DEFAULTS = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'luna',
  options: (() => {
    try {
      return process.env.OLLAMA_OPTIONS_JSON
        ? JSON.parse(process.env.OLLAMA_OPTIONS_JSON)
        : {};
    } catch {
      console.warn('[ollama] Failed parsing OLLAMA_OPTIONS_JSON, using {}.');
      return {};
    }
  })(),
};

function mergeOptions(override = {}) {
  return { ...DEFAULTS.options, ...override };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetry(status) {
  // timeouts, rate limits, transient server/network errors
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Non-streaming chat (returns a full string).
 * Retries transient errors, supports timeout.
 */
export async function ollamaChat({
  messages,
  model,
  options = {},
  stream = false,        // kept for API compatibility; if true we stream then join.
  timeoutMs = 60_000,
  retries = 2,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[ollama] messages must be a non-empty array');
  }
  const baseUrl = DEFAULTS.baseUrl;
  const mdl = model || DEFAULTS.model;
  const opts = mergeOptions(options);

  if (stream) {
    // Use streaming path, but return a concatenated string (keeps old call sites working)
    return ollamaStreamToString({ messages, model: mdl, options: opts, timeoutMs });
  }

  const payload = JSON.stringify({ model: mdl, messages, stream: false, options: opts });

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(to);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (attempt < retries && shouldRetry(res.status)) {
          await sleep(300 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`[ollama] HTTP ${res.status} - ${text}`);
      }

      const data = await res.json();
      return data?.message?.content || '';
    } catch (err) {
      clearTimeout(to);
      // AbortError / transient network -> retry
      const isAbort = err?.name === 'AbortError';
      const transient = isAbort || /ECONNRESET|ETIMEDOUT|EPIPE/i.test(err?.code || '');
      if (attempt < retries && transient) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }

  // Should never reach here
  return '';
}

/**
 * Streaming chat as an async generator (yields string chunks).
 * Example:
 *   for await (const chunk of ollamaStream({ messages:[...] })) process.stdout.write(chunk)
 */
export async function* ollamaStream({
  messages,
  model,
  options = {},
  timeoutMs = 120_000,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[ollama] messages must be a non-empty array');
  }
  const baseUrl = DEFAULTS.baseUrl;
  const mdl = model || DEFAULTS.model;
  const opts = mergeOptions(options);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ model: mdl, messages, stream: true, options: opts }),
    signal: controller.signal,
  });
  if (!res.ok) {
    clearTimeout(to);
    const text = await res.text().catch(() => '');
    throw new Error(`[ollama] HTTP ${res.status} - ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // NDJSON: split on newlines; lines may arrive partial
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);

        if (!line) continue;
        // Some proxies prepend "data: " — strip it if present
        const jsonStr = line.startsWith('data:') ? line.slice(5).trim() : line;

        try {
          const obj = JSON.parse(jsonStr);
          const delta = obj?.message?.content || '';
          if (delta) yield delta;
          if (obj?.done) break;
        } catch {
          // If it's not parseable, keep accumulating (rare)
          buf = jsonStr + '\n' + buf;
          break;
        }
      }
    }
  } finally {
    clearTimeout(to);
    reader.releaseLock?.();
  }
}

/** Consume the stream and return a single concatenated string. */
export async function ollamaStreamToString(args) {
  let out = '';
  for await (const chunk of ollamaStream(args)) out += chunk;
  return out;
}

/**
 * Smarter splitting for Discord: prefers paragraph -> line -> word breaks,
 * and only hard-cuts if needed.
 */
export function chunkDiscordMessage(text, maxLen = 1900) {
  if (!text) return [''];
  const chunks = [];

  // Helper that may split a long segment further
  const pushSmart = (segment) => {
    segment = String(segment);
    while (segment.length > maxLen) {
      // Try double newline, newline, then space
      let cut =
        segment.lastIndexOf('\n\n', maxLen) >= 0
          ? segment.lastIndexOf('\n\n', maxLen)
          : segment.lastIndexOf('\n', maxLen) >= 0
          ? segment.lastIndexOf('\n', maxLen)
          : segment.lastIndexOf(' ', maxLen);

      // If all fail or too close to start, hard cut
      if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;

      chunks.push(segment.slice(0, cut).trimEnd());
      segment = segment.slice(cut).trimStart();
    }
    if (segment) chunks.push(segment);
  };

  for (const para of String(text).split(/\n{2,}/)) {
    pushSmart(para);
  }
  return chunks;
}

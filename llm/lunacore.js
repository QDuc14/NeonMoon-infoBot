export async function* lunaChatStream({
  userId, userName, guildId, guildName, channelId,
  text, messages, model, conversationId, metadata = {},
  timeoutMs = 0
} = {}) {
  const BASE  = process.env.LUNACORE_BASE_URL || 'http://127.0.0.1:8000';
  const KEY   = process.env.LUNA_API_KEY || '';
  const MODEL = process.env.LUNA_MODEL || process.env.OLLAMA_MODEL || 'luna-mistral';
  const USE_MEMORY = (process.env.LUNA_USE_SERVER_MEMORY ?? 'true').toString().toLowerCase() === 'true';

  const body = {
    model: model || MODEL,
    messages: (Array.isArray(messages) && messages.length)
      ? messages
      : [{ role: 'user', content: String(text ?? '').trim() }],
    user_id: userId,
    user_name: userName,
    conversation_id: conversationId || `${guildId || 'DM'}:${channelId || 'NA'}`,
    use_server_memory: USE_MEMORY,
    metadata
  };

  const controller = new AbortController();
  let to;
  if (timeoutMs > 0) to = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(`${BASE}/discord/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {})
    },
    body: JSON.stringify(body, (k, v) => (v === undefined ? undefined : v)),
    signal: controller.signal
  });
  if (to) clearTimeout(to);

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`[LunaCore] /discord/chat/stream ${res.status} ${t}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Split SSE frames by the blank line separator
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      // Parse the frame WITHOUT trimming payload spaces
      let event = 'message';
      const datas = [];

      for (const rawLine of frame.split(/\r?\n/)) {
        // do not trim leading/trailing spaces globally
        if (rawLine.startsWith('event:')) {
          event = rawLine.slice(6).trim();     // trimming the event type is fine
        } else if (rawLine.startsWith('data:')) {
          // keep payload spaces; just remove the "data:" prefix and ONE optional leading space
          let payload = rawLine.slice(5);
          if (payload.startsWith(' ')) payload = payload.slice(1);
          datas.push(payload);
        }
      }

      const payload = datas.join('\n'); // preserve embedded newlines

      if (event === 'error') {
        throw new Error(payload || 'stream error');
      }
      if (event === 'done') {
        return; // final frame (your server puts full text in data; we stop)
      }
      if (payload) {
        yield payload; // this chunk may begin with a space — keep it!
      }
    }
  }
}
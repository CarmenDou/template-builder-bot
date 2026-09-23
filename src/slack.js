import crypto from 'node:crypto';

// Slack rejects its own replays past five minutes; matching that keeps a
// captured request from being useful later.
const MAX_SKEW_SECONDS = 300;

export function verifySlackSignature({ signingSecret, signature, timestamp, rawBody, now = Date.now() }) {
  if (!signingSecret || !signature || !timestamp) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(now / 1000 - sent) > MAX_SKEW_SECONDS) return false;

  const expected =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function postMessage({ token, channel, threadTs, text, fetchImpl = fetch }) {
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
  // Slack answers HTTP 200 even when it refused, so the body is the real status
  const body = await response.json().catch(() => ({}));
  if (!body.ok) throw new Error(`chat.postMessage failed: ${body.error ?? response.status}`);
  return body;
}

/**
 * The replies in one thread, oldest first. Needs the channels:history scope.
 * Returns [] rather than throwing: losing the context should degrade the reply,
 * not fail the request.
 */
export async function fetchThread({ token, channel, threadTs, limit = 50, fetchImpl = fetch }) {
  const url =
    'https://slack.com/api/conversations.replies' +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=${limit}`;
  try {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => ({}));
    if (!body.ok) return { messages: [], error: body.error ?? String(response.status) };
    return { messages: body.messages ?? [], error: null };
  } catch (error) {
    return { messages: [], error: error.message };
  }
}

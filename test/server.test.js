import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

const SECRET = 'shh';

const config = {
  slackSigningSecret: SECRET,
  slackBotToken: 'xoxb-test',
  allowedChannels: ['C_OK'],
  jobTimeoutMs: 1000,
  pollIntervalMs: 5,
  port: 0,
};

function sign(body, ts = Math.floor(Date.now() / 1000)) {
  const sig =
    'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) };
}

async function withServer(deps, fn) {
  const server = createServer(config, deps);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, body, headers) =>
  fetch(`${base}/slack/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

test('health check answers without a signature', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});

test('unknown paths are 404', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('an unsigned request is refused', async () => {
  await withServer({ mention: async () => assert.fail('must not run') }, async (base) => {
    const res = await post(base, JSON.stringify({ type: 'event_callback' }), {});
    assert.equal(res.status, 401);
  });
});

test('a request signed with the wrong secret is refused', async () => {
  await withServer({ mention: async () => assert.fail('must not run') }, async (base) => {
    const body = JSON.stringify({ type: 'event_callback' });
    const ts = Math.floor(Date.now() / 1000);
    const bad =
      'v0=' + crypto.createHmac('sha256', 'wrong').update(`v0:${ts}:${body}`).digest('hex');
    const res = await post(base, body, {
      'x-slack-signature': bad,
      'x-slack-request-timestamp': String(ts),
    });
    assert.equal(res.status, 401);
  });
});

test('an old timestamp is refused even with a valid hmac', async () => {
  await withServer({ mention: async () => assert.fail('must not run') }, async (base) => {
    const body = JSON.stringify({ type: 'event_callback' });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await post(base, body, sign(body, old));
    assert.equal(res.status, 401);
  });
});

test('the url_verification handshake echoes the challenge', async () => {
  await withServer({}, async (base) => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await post(base, body, sign(body));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'abc123');
  });
});

test('a mention is acknowledged immediately, before the work runs', async () => {
  let released;
  const blocked = new Promise((r) => (released = r));
  const deps = {
    mention: async () => {
      await blocked;
      return { reply: null, job: null };
    },
    post: async () => ({ ok: true }),
  };
  await withServer(deps, async (base) => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev1',
      event: { type: 'app_mention', channel: 'C_OK', text: 'hi', ts: '1' },
    });
    const res = await post(base, body, sign(body));
    // Slack's window is three seconds; the handler is still blocked here.
    assert.equal(res.status, 200);
    released();
  });
});

test('a Slack retry of the same event does not start a second agent', async () => {
  let starts = 0;
  const deps = {
    mention: async () => {
      starts += 1;
      return { reply: null, job: null };
    },
    post: async () => ({ ok: true }),
  };
  await withServer(deps, async (base) => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvSame',
      event: { type: 'app_mention', channel: 'C_OK', text: 'hi', ts: '1' },
    });
    await post(base, body, sign(body));
    await post(base, body, sign(body));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(starts, 1, 'a retried delivery must not double-run the job');
  });
});

test('non-mention events are ignored', async () => {
  const deps = { mention: async () => assert.fail('must not run'), post: async () => ({}) };
  await withServer(deps, async (base) => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev2',
      event: { type: 'message', channel: 'C_OK', text: 'hi', ts: '1' },
    });
    const res = await post(base, body, sign(body));
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 30));
  });
});

// --- the /mcp endpoint -------------------------------------------------------

async function withMcpServer(tokenConfig, deps, fn) {
  const server = createServer({ ...config, ...tokenConfig }, deps);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const mcp = (base, body, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('with no token configured the endpoint does not exist', async () => {
  // Fail closed. An open /mcp lets anyone who finds this URL start an agent that
  // holds a GitHub token, so missing config must not mean missing lock.
  await withMcpServer({ mcpToken: '' }, {}, async (base) => {
    const res = await mcp(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 404);
  });
});

test('a wrong or missing bearer token is refused before dispatch', async () => {
  const deps = { rpc: async () => assert.fail('must not dispatch') };
  await withMcpServer({ mcpToken: 'sekret' }, deps, async (base) => {
    assert.equal((await mcp(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    const wrong = await mcp(
      base,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: 'Bearer nope' },
    );
    assert.equal(wrong.status, 401);
  });
});

test('an authorised call is dispatched and answered', async () => {
  await withMcpServer(
    { mcpToken: 'sekret' },
    { rpc: async (_c, m) => ({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) },
    async (base) => {
      const res = await mcp(
        base,
        { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        { authorization: 'Bearer sekret' },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 7, result: { tools: [] } });
    },
  );
});

test('a notification is accepted with no body', async () => {
  await withMcpServer({ mcpToken: 'sekret' }, { rpc: async () => null }, async (base) => {
    const res = await mcp(
      base,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: 'Bearer sekret' },
    );
    assert.equal(res.status, 202, 'a body here would be a protocol error');
  });
});

test('a batch comes back as a batch, with notifications dropped', async () => {
  await withMcpServer(
    { mcpToken: 'sekret' },
    { rpc: async (_c, m) => (m.id ? { jsonrpc: '2.0', id: m.id, result: {} } : null) },
    async (base) => {
      const res = await mcp(
        base,
        [
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ],
        { authorization: 'Bearer sekret' },
      );
      const body = await res.json();
      assert.ok(Array.isArray(body));
      assert.deepEqual(body.map((r) => r.id), [1, 2]);
    },
  );
});

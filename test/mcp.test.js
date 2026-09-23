import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, TOOLS } from '../src/mcp.js';

const config = { agentService: 'claude-code' };
const rpc = (method, params, deps) => handleRpc(config, { jsonrpc: '2.0', id: 1, method, params }, deps);

test('initialize answers with tools capability', async () => {
  const out = await rpc('initialize');
  assert.equal(out.result.capabilities.tools !== undefined, true);
  assert.match(out.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('a notification gets no response at all', async () => {
  const out = await handleRpc(config, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out, null, 'answering a notification is a protocol error');
});

test('every tool says what it is for, and none of them can delete', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'ask_for_review',
    'continue_template_pr',
    'list_running_jobs',
    'read_job',
    'start_template_job',
    'steer_job',
    'stop_job',
  ]);
  // The box holds a platform key for the whole org. Nothing here may reach it:
  // a caller can only do these seven things, whatever it is asked to do.
  const surface = JSON.stringify(TOOLS);
  assert.ok(!/delete|remove|destroy/i.test(surface), 'no destructive verb is offered');
  for (const t of TOOLS) assert.ok(t.description.length > 60, `${t.name} explains itself`);
});

test('starting a second job on a repo already running is refused, with the way out', async () => {
  const out = await rpc(
    'tools/call',
    { name: 'start_template_job', arguments: { repo_url: 'https://github.com/a/b' } },
    {
      running: async () => [{ jobId: 'J-old', url: 'https://github.com/a/b' }],
      start: async () => assert.fail('must not start a second agent on one repo'),
    },
  );
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /J-old/, 'names the job that holds it');
  assert.match(out.result.content[0].text, /steer_job/, 'points at what to do instead');
});

test('the same guard covers a PR', async () => {
  const out = await rpc(
    'tools/call',
    { name: 'continue_template_pr', arguments: { pr_number: 149, instructions: 'x' } },
    {
      running: async () => [{ jobId: 'J-old', url: 'PR #149' }],
      start: async () => assert.fail('must not start a second agent on one PR'),
    },
  );
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /steer_job/);
});

test('a free repo starts, and the requester words are passed through', async () => {
  let started = null;
  const out = await rpc(
    'tools/call',
    {
      name: 'start_template_job',
      arguments: { repo_url: 'https://github.com/a/b', instructions: 'use the tiny model' },
    },
    {
      running: async () => [],
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J-new' };
      },
    },
  );
  assert.equal(started.url, 'https://github.com/a/b');
  assert.equal(started.extra, 'use the tiny model');
  assert.match(out.result.content[0].text, /J-new/);
});

test('something that is not a GitHub URL is refused before anything starts', async () => {
  const out = await rpc(
    'tools/call',
    { name: 'start_template_job', arguments: { repo_url: 'our internal gitlab' } },
    { running: async () => [], start: async () => assert.fail('must not start') },
  );
  assert.equal(out.result.isError, true);
});

test('read_job carries the stages, the result and a bounded log tail', async () => {
  const out = await rpc(
    'tools/call',
    { name: 'read_job', arguments: { job_id: 'J1' } },
    {
      read: async () => ({
        done: true,
        exitCode: 0,
        stages: ['triage: thin-shell'],
        log: 'x'.repeat(20000) + '\nRESULT\nverdict: thin-shell\ncreated: admin / hunter2',
      }),
    },
  );
  const body = JSON.parse(out.result.content[0].text);
  assert.equal(body.done, true);
  assert.deepEqual(body.stages, ['triage: thin-shell']);
  assert.equal(body.result.verdict, 'thin-shell');
  assert.deepEqual(body.result.created, ['admin / hunter2']);
  assert.ok(body.logTail.length <= 4000, 'the tail is bounded or it floods the caller');
});

test('steer passes the message on and says plainly when it could not', async () => {
  const ok = await rpc(
    'tools/call',
    { name: 'steer_job', arguments: { job_id: 'J1', message: 'drop ttyd' } },
    { steer: async (_c, id, m) => (id === 'J1' && m === 'drop ttyd' ? 'steered' : 'wrong args') },
  );
  assert.ok(!ok.result.isError);

  const gone = await rpc(
    'tools/call',
    { name: 'steer_job', arguments: { job_id: 'J1', message: 'drop ttyd' } },
    { steer: async () => 'already finished' },
  );
  assert.equal(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /already finished/);
});

test('a tool that throws comes back as a readable failure, not a dead connection', async () => {
  const out = await rpc(
    'tools/call',
    { name: 'list_running_jobs', arguments: {} },
    {
      running: async () => {
        throw new Error('the box is unreachable');
      },
    },
  );
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /the box is unreachable/);
  assert.equal(out.error, undefined, 'a tool failure is a result, not a JSON-RPC error');
});

test('an unknown method is a JSON-RPC error', async () => {
  const out = await rpc('tools/explode');
  assert.equal(out.error.code, -32601);
});

test('a job is followed by whoever started it, so the start tools take no thread to post into', async () => {
  const start = (await handleRpc({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.filter((t) =>
    ['start_template_job', 'continue_template_pr'].includes(t.name),
  );
  for (const t of start) {
    const props = Object.keys(t.inputSchema.properties);
    assert.ok(!props.some((p) => /slack/i.test(p)), `${t.name} has no slack parameter`);
  }
});

test('starting a job says how to follow it', async () => {
  const deps = {
    start: async () => ({ jobId: 'J42' }),
    running: async () => [],
  };
  const res = await handleRpc(
    {},
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_template_job', arguments: { repo_url: 'https://github.com/a/b' } } },
    deps,
  );
  const said = res.result.content[0].text;
  assert.match(said, /follow J42 0 0/);
  assert.doesNotMatch(said, /"/, 'nothing for the caller to quote');
  assert.match(said, /says nothing on its own/);
});

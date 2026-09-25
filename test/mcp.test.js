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
    'follow_job',
    'list_running_jobs',
    'offer_template_upstream',
    'read_job',
    'review_status',
    'start_template_job',
    'steer_job',
    'stop_job',
  ]);
  // The box holds a platform key for the whole org. Nothing here may reach it:
  // a caller can only do these ten things, whatever it is asked to do.
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
    { steer: async (_c, id, m) => (id === 'J1' && m === 'drop ttyd' ? 'steered 120 3' : 'wrong args') },
  );
  assert.ok(!ok.result.isError);
  assert.match(ok.result.content[0].text, /follow_job\(job_id: "J1", offset: 120, stages: 3\)/, 'and where to follow from');

  const back = await rpc(
    'tools/call',
    { name: 'steer_job', arguments: { job_id: 'J1', message: 'delete the seed data' } },
    { steer: async () => 'resumed 900 8' },
  );
  assert.ok(!back.result.isError, 'a finished job is not a refusal any more');
  assert.match(back.result.content[0].text, /had finished/);
  assert.match(back.result.content[0].text, /offset: 900, stages: 8/);

  const gone = await rpc(
    'tools/call',
    { name: 'steer_job', arguments: { job_id: 'J1', message: 'drop ttyd' } },
    { steer: async () => 'no such job' },
  );
  assert.equal(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /no such job/);
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
  assert.match(said, /follow_job\(job_id: "J42", offset: 0, stages: 0\)/);
  assert.doesNotMatch(said, /sleep|\bcc\b|ssh/, 'no shell for the caller to assemble');
  assert.match(said, /says nothing on its own/);
});

const call = (name, args, deps) =>
  handleRpc({}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps);

test('follow_job hands back the offsets for the next call, and says when it is done', async () => {
  const feed = async (_c, id, o) => ({
    activity: ['stage: build: green', 'said: deploying now'],
    offset: o.offset + 100,
    stages: o.stages + 1,
    done: false,
    exitCode: null,
  });
  const res = await call('follow_job', { job_id: 'J1', offset: 5, stages: 2 }, { feed });
  const said = res.result.content[0].text;
  assert.match(said, /stage: build: green/);
  assert.match(said, /offset: 105/);
  assert.match(said, /stages: 3/);
  assert.match(said, /done: false/);
});

test('follow_job with nothing new says so rather than returning an empty page', async () => {
  const feed = async () => ({ activity: [], offset: 7, stages: 1, done: false, exitCode: null });
  const said = (await call('follow_job', { job_id: 'J1' }, { feed })).result.content[0].text;
  assert.match(said, /nothing new/);
});

test('a dropped channel tells the follower to go on, not that the job failed', async () => {
  const feed = async () => {
    throw new Error('exec channel dropped');
  };
  const res = await call('follow_job', { job_id: 'J1', offset: 9, stages: 3 }, { feed });
  assert.ok(!res.result.isError);
  assert.match(res.result.content[0].text, /Call follow_job again with the same offset and stages/);
});

test('follow_job is described so that nobody needs a skill to use it', () => {
  const d = TOOLS.find((t) => t.name === 'follow_job').description;
  assert.match(d, /never sleep between calls/);
  assert.match(d, /ONE plain sentence/);
  assert.match(d, /Ending your turn does NOT stop the job/);
  assert.match(d, /stop_job/);
});

test('steer_job is described as the way to reach what a job built', () => {
  const d = TOOLS.find((t) => t.name === 'steer_job').description;
  assert.match(d, /AND for anything afterwards about what a job built/);
  assert.match(d, /Do not try to do those yourself from here/);
  assert.match(d, /follow it with follow_job/);
});

test('review_status hands over what people said, with enough to read it', async () => {
  const reviews = async () => ({
    waiting: false,
    activity: [{ kind: 'review', author: 'jwfing', at: '2026-09-23T18:33:57Z', state: 'COMMENTED', onHead: true, body: '## Verdict\n\n**Approved** — zero Critical findings.' }],
  });
  const said = (await call('review_status', { pr_url: 'https://github.com/InsForge/instacloud-oss/pull/146', after: '2026-09-23T18:28:19Z' }, { reviews })).result.content[0].text;
  assert.match(said, /^1 new since 2026-09-23T18:28:19Z:/);
  assert.match(said, /--- review, COMMENTED, on the current head, by jwfing at 2026-09-23T18:33:57Z/);
  assert.match(said, /zero Critical findings/);
});

test('a review of an older commit is called out, because newer code was never read', async () => {
  const reviews = async () => ({ waiting: false, activity: [{ kind: 'review', author: 'jwfing', at: 'T', state: 'COMMENTED', onHead: false, body: 'ok' }] });
  const said = (await call('review_status', { pr_url: 'https://github.com/a/b/pull/1' }, { reviews })).result.content[0].text;
  assert.match(said, /on an OLDER commit/);
});

test('waiting for a review that has not come yet says to call again', async () => {
  const reviews = async () => ({ waiting: true, activity: [] });
  const said = (await call('review_status', { pr_url: 'https://github.com/a/b/pull/1', after: '2026-09-23T07:30:00Z' }, { reviews })).result.content[0].text;
  assert.match(said, /Nothing from a person since 2026-09-23T07:30:00Z yet\. Call review_status again with the same after/);
});

test('the review result is reported, not used as a gate on the person', () => {
  const status = TOOLS.find((t) => t.name === 'review_status').description;
  assert.match(status, /not a gate/);
  assert.match(status, /bots, such as cubic, are left out/);
  assert.match(status, /Codex and Claude post as the ordinary account jwfing/);
  assert.match(status, /never on your own/, 'nobody asked means nobody is pinged');
  const ask = TOOLS.find((t) => t.name === 'ask_for_review').description;
  assert.match(ask, /Their word is what counts, not the review's result/);
  assert.match(ask, /even with Critical findings open/);
  assert.doesNotMatch(ask, /only once that comes back clean/);
});

test('every follow_job answer ends by saying what to call next, with no sleep in it', async () => {
  const running = async () => ({ activity: ['stage: pr: https://x/1'], offset: 42, stages: 3, done: false, exitCode: null });
  const said = (await call('follow_job', { job_id: 'J9', offset: 0, stages: 0 }, { feed: running })).result.content[0].text;
  const last = said.trim().split('\n').at(-1);
  assert.match(last, /^Next: call follow_job\(job_id: "J9", offset: 42, stages: 3\) straight away/);
  assert.match(last, /sleeping first only delays/);

  const finished = async () => ({ activity: [], offset: 50, stages: 4, done: true, exitCode: 0 });
  const end = (await call('follow_job', { job_id: 'J9', offset: 42, stages: 3 }, { feed: finished })).result.content[0].text;
  assert.match(end.trim().split('\n').at(-1), /^Next: call read_job for the result/);
});

test('a quiet look says nothing, so a short wait does not turn into chatter', () => {
  const d = TOOLS.find((t) => t.name === 'follow_job').description;
  assert.match(d, /when it shows nothing new, say nothing and call again/);
  assert.match(d, /about 20 seconds/);
});

test('offering upstream can only reach the repository the job itself names', async () => {
  // The credential behind this is broad, so what it may be pointed at comes from the job's own
  // record. A caller naming another repository has nowhere to put it: there is no such argument.
  const tool = TOOLS.find((t) => t.name === 'offer_template_upstream');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['job_id']);

  let sentTo = null;
  await call(
    'offer_template_upstream',
    { job_id: 'J1' },
    {
      read: async () => ({ url: 'https://github.com/louislam/uptime-kuma', stages: [], steps: [] }),
      offer: async () => ({ manifest: 'code: x\n', readmeLine: '[![x](y)](z)', title: 't', body: 'b' }),
      openPr: async (_c, input) => {
        sentTo = input.repoUrl;
        return { url: 'https://github.com/louislam/uptime-kuma/pull/9', number: 9, fork: 'CarmenDou/uptime-kuma', branch: 'b' };
      },
    },
  );
  assert.equal(sentTo, 'https://github.com/louislam/uptime-kuma');
});

test('a job that came from a PR number, not a repository, has nothing to offer back', async () => {
  const res = await call(
    'offer_template_upstream',
    { job_id: 'J1' },
    {
      read: async () => ({ url: 'PR #149', stages: [], steps: [] }),
      offer: async () => assert.fail('must not read an offer'),
      openPr: async () => assert.fail('must not open anything'),
    },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not started from a GitHub repository/);
});

test('a job that prepared nothing is refused, and told how to prepare it', async () => {
  const res = await call(
    'offer_template_upstream',
    { job_id: 'J1' },
    {
      read: async () => ({ url: 'https://github.com/o/r', stages: [], steps: [] }),
      offer: async () => ({ manifest: '', readmeLine: '', title: '', body: '' }),
      openPr: async () => assert.fail('must not open anything'),
    },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /prepared no upstream offer.*steer_job/s);
});

test('offering upstream says it is outward and needs a person to have said so', () => {
  const d = TOOLS.find((t) => t.name === 'offer_template_upstream').description;
  assert.match(d, /Only when a person has read what the job prepared and said to send it/);
  assert.match(d, /cannot be taken back/);
  assert.match(d, /Never because a job finished/);
});

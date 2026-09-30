import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, TOOLS } from '../src/mcp.js';
import { describeDrift, checkUpstream } from '../src/drift.js';

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
    'bump_template',
    'check_template_upstream',
    'continue_template_pr',
    'follow_job',
    'list_running_jobs',
    'offer_template_upstream',
    'read_job',
    'review_status',
    'send_upstream_offer',
    'start_template_job',
    'steer_job',
    'stop_job',
  ]);
  // The box holds a platform key for the whole org. Nothing here may reach it:
  // a caller can only do the things listed above, whatever it is asked to do.
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

const OPENED = {
  url: 'https://github.com/louislam/uptime-kuma/pull/9',
  number: 9,
  upstream: 'louislam/uptime-kuma',
  declared: 'louislam/uptime-kuma',
  fork: 'CarmenDou/uptime-kuma',
  branch: 'instacloud-deploy-button',
  added: 4,
  removed: 0,
};

test('the preview writes nothing and hands back what the decision needs', async () => {
  let sent = null;
  const res = await call('offer_template_upstream', { template_code: 'uptime-kuma' }, {
    openPr: async (_c, input) => {
      sent = input;
      return {
        preview: true,
        upstream: 'kuma-org/uptime-kuma',
        declared: 'louislam/uptime-kuma',
        line: '[![Deploy on InstaCloud](b.svg)](https://instacloud.com/templates/uptime-kuma)',
        lines: 120,
        briefing: '  1 | # Kuma',
      };
    },
  });
  assert.deepEqual(sent, { code: 'uptime-kuma', preview: true }, 'it asks for a preview, not a write');
  const out = res.result.content[0].text;
  assert.match(out, /kuma-org\/uptime-kuma is where this would go/);
  assert.match(out, /which is a fork, so this goes to the project that was forked from/);
  assert.match(out, /1 \| # Kuma/);
  assert.match(out, /call send_upstream_offer/);
});

test('sending takes a template code and nothing a caller could aim', async () => {
  // The credential behind this is broad, so nothing a caller writes may decide WHICH repository
  // gets written to. The code decides that, and everything else is derived from it. What a caller
  // does get to write is the text of one region of one file, which is checked before it is pushed.
  const tool = TOOLS.find((t) => t.name === 'send_upstream_offer');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['template_code', 'from', 'to', 'text']);

  let sent = null;
  const res = await call(
    'send_upstream_offer',
    { template_code: 'uptime-kuma', repo_url: 'https://github.com/someone/else' },
    { openPr: async (_c, input) => ((sent = input), OPENED) },
  );
  assert.deepEqual(sent, { code: 'uptime-kuma', edit: undefined }, 'the extra argument is not passed through');
  assert.match(res.result.content[0].text, /louislam\/uptime-kuma/);
  assert.match(res.result.content[0].text, /instacloud\.com\/templates\/uptime-kuma/);
  assert.match(res.result.content[0].text, /adds 4 line\(s\) and changes 0/);
});

test('a region named by the caller is passed through as the edit', async () => {
  let sent = null;
  await call(
    'send_upstream_offer',
    { template_code: 'uptime-kuma', from: 12, to: 14, text: '## One-click Deployment' },
    { openPr: async (_c, input) => ((sent = input), OPENED) },
  );
  assert.deepEqual(sent, { code: 'uptime-kuma', edit: { from: 12, to: 14, text: '## One-click Deployment' } });
});

test('a refusal from the gate is reported as one, not as a success', async () => {
  const res = await call(
    'offer_template_upstream',
    { template_code: 'openclaw' },
    {
      openPr: async () => {
        throw new Error('openclaw is not published, so https://instacloud.com/templates/openclaw does not exist');
      },
    },
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not published/);
  assert.match(res.result.content[0].text, /openclaw/);
});

test('a missing code is refused by name rather than reported as "(no code)" work done', async () => {
  const res = await call('offer_template_upstream', {}, {
    openPr: async () => { throw new Error("'' is not a template code."); },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /\(no code\)/);
});

test('the preview says it writes nothing, so it can be called freely', () => {
  const d = TOOLS.find((t) => t.name === 'offer_template_upstream').description;
  assert.match(d, /READ ONLY/);
  assert.match(d, /Writes nothing and opens nothing/);
  // The gate and the derivation, both stated where the caller reads them.
  assert.match(d, /must already be PUBLISHED/);
  assert.match(d, /following a fork through to the project itself/);
});

test('sending says it is outward, needs a person, and what it will refuse', () => {
  const d = TOOLS.find((t) => t.name === 'send_upstream_offer').description;
  assert.match(d, /Only when a person has said to send it/);
  assert.match(d, /cannot be taken back/);
  assert.match(d, /Never because a job finished or a template published/);
  // What the caller may write, and what will be done to it before it is pushed.
  assert.match(d, /may only add/);
  assert.match(d, /may not introduce a link that is not ours/);
  assert.match(d, /in their language/);
  // And that a second call revises rather than reopens, which is the answer to "I do not like it".
  assert.match(d, /replaces the commit on the same branch/);
});

// A stub that throws proves nothing when the caller catches what it throws, so these count their
// calls instead and the count is read after the answer has come back.
const OTHER_DEPS = ['start', 'read', 'feed', 'steer', 'stop', 'running', 'review', 'reviews', 'openPr', 'findOpen', 'bump', 'openBump'];
const spied = (names) => {
  const calls = [];
  return { calls, deps: Object.fromEntries(names.map((n) => [n, async () => (calls.push(n), {})])) };
};

// The real detector code, with only the box faked, so the answers a person sees when a question goes
// wrong are the ones checkUpstream writes and not a stand-in for them.
const box = (behave) => {
  const scripts = [];
  return { scripts, run: async (_c, script) => (scripts.push(script), behave(script)) };
};
const viaBox = (run) => ({ drift: (c, codes) => checkUpstream(c, codes, { run }) });
const surface = () => TOOLS.map((t) => t.name);

test('check_template_upstream answers, and says what to do about it', async () => {
  const rows = [
    { code: 'n8n', kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor' },
    { code: 'pi', kind: 'npm', current: true },
    { code: 'openclaw', kind: 'docker-digest', unknown: 'a digest needs a registry token' },
  ];
  let asked = null;
  let askedWith = null;
  // A question about the world is not a reason to open, steer, stop or ask anyone for anything.
  const { calls, deps } = spied(OTHER_DEPS);
  const out = await rpc(
    'tools/call',
    { name: 'check_template_upstream', arguments: {} },
    { ...deps, drift: async (c, codes) => ((askedWith = c), (asked = codes), { rows }) },
  );
  const said = out.result.content[0].text;
  assert.equal(askedWith, config, 'the box is reached through the same config as every other tool');
  assert.deepEqual(asked, [], 'no code means the whole registry');
  assert.deepEqual(calls, [], 'a read only question reaches nothing else, caught or not');
  assert.match(said, /n8n: 2\.36\.5 -> 2\.41\.3/);
  // Up to date and unresolved are both answers, and both get said.
  assert.match(said, /pi: up to date/);
  assert.match(said, /openclaw: could not be resolved/);
  assert.match(said, /^1 behind\. \S/m, 'the next step is in the answer, not in a prompt that may be older');
  assert.equal(said, describeDrift(rows), 'the words are describeDrift over the rows, whole and unadorned');
  assert.equal(out.result.content.length, 1);
  assert.equal(out.result.isError, undefined);
});

test('check_template_upstream asks about one template when it is given one', async () => {
  let asked = null;
  await rpc(
    'tools/call',
    { name: 'check_template_upstream', arguments: { code: 'n8n' } },
    { drift: async (_c, codes) => ((asked = codes), { rows: [{ code: 'n8n', current: true }] }) },
  );
  assert.deepEqual(asked, ['n8n']);
});

test('check_template_upstream treats an empty code as no code, not as a template called nothing', async () => {
  // A model filling in an optional string tends to send "" for "none".
  let asked = null;
  await rpc(
    'tools/call',
    { name: 'check_template_upstream', arguments: { code: '' } },
    { drift: async (_c, codes) => ((asked = codes), { rows: [{ code: 'n8n', current: true }] }) },
  );
  assert.deepEqual(asked, []);
});

test('check_template_upstream passes a refusal through as a refusal', async () => {
  let asked = null;
  const out = await rpc(
    'tools/call',
    { name: 'check_template_upstream', arguments: { code: 'n88n' } },
    { drift: async (_c, codes) => ((asked = codes), { error: 'There is no template called n88n.' }) },
  );
  assert.deepEqual(asked, ['n88n'], 'the refusal is the answer to THIS question, not a stock one');
  // The text is the refusal itself, verbatim: not describeDrift over nothing, and not a thrown
  // "failed:" wrapper, both of which would still be an error and still not say why.
  assert.deepEqual(out.result, {
    content: [{ type: 'text', text: 'There is no template called n88n.' }],
    isError: true,
  });
});

test('a code that is really an option is refused at this boundary, and the box is never reached', async () => {
  // The detector's --apply WRITES files on a box that holds push rights. The pattern in drift.js is
  // what stops it and is tested there, and this says so from where a caller stands.
  for (const code of ['--apply', '--apply --json', 'n8n --apply', 'n8n; reboot', '$(reboot)', '-h']) {
    const { scripts, run } = box(() => ({ stdout: '[]' }));
    const { calls, deps } = spied(OTHER_DEPS);
    const out = await rpc('tools/call', { name: 'check_template_upstream', arguments: { code } }, { ...deps, ...viaBox(run) });
    assert.equal(out.result.isError, true, `${code} is refused`);
    assert.match(out.result.content[0].text, /is not a template code/, code);
    assert.deepEqual(scripts, [], `${code} must not reach the box`);
    assert.deepEqual(calls, [], `${code} must not reach anything else either`);
  }
});

test('what is sent to the box is the detector in its read only mode, for one template or for all', async () => {
  for (const [args, tail] of [
    [{}, /check-upstreams\.mjs --json$/],
    [{ code: 'n8n' }, /check-upstreams\.mjs --json n8n$/],
  ]) {
    const { scripts, run } = box(() => ({ stdout: '[{"code":"n8n","current":true}]\n' }));
    const out = await rpc('tools/call', { name: 'check_template_upstream', arguments: args }, viaBox(run));
    assert.equal(out.result.isError, undefined);
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], tail);
    assert.doesNotMatch(scripts[0], /--apply/, 'nothing this tool sends can write');
  }
});

test('check_template_upstream is described so that nobody needs a skill to use it', () => {
  const tool = TOOLS.find((t) => t.name === 'check_template_upstream');
  const d = tool.description;
  // What it is, and what asking costs: read only is true of the repository it reports on, and not of
  // the box, where a call resets a shared checkout, installs into it and takes a lock.
  assert.match(d, /What each published template pins, and what its upstream has released since/);
  assert.match(d, /Read only as to the repository it reports on/);
  assert.match(d, /no pull request is opened and no pin is moved/);
  assert.match(d, /does refresh a shared checkout of instacloud-oss on the agent box/, 'it says what it does to the box');
  assert.match(d, /exclusive lock/, 'and that a second call waits behind the first');
  assert.doesNotMatch(d, /changes nothing|opens nothing/, 'a call changes the checkout on the box');
  // How to ask: the whole registry is the default question, and one code narrows it.
  assert.match(d, /Call it with no code for the whole registry/);
  assert.match(d, /whenever anyone wonders whether a template is behind/);
  assert.match(d, /never guessed/, 'an unresolved template is reported as unknown, with the reason');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['code']);
  assert.ok(!(tool.inputSchema.required ?? []).includes('code'), 'the code is optional, or the whole registry cannot be asked for');
});

// Hermes tries whatever an answer tells it to call, and an answer that names a tool this server does
// not offer makes the bot look broken in front of the person who asked. This looks for words shaped
// like a tool name, in snake_case, kebab-case or camelCase, that are not a tool or an argument on
// the surface right now, and it reads the surface when it runs so a tool added later counts.
//
// What it CAN catch: a multi-word name in any of those three spellings, inside backticks or bare,
// anywhere in an answer, a refusal, a description or a property description that is scanned below.
// What it CANNOT: a single word such as `bump`, a name written in Slack italics (_bump_template_,
// where the underscores read as part of the word), a paraphrase like "the bump tool", or a name in
// text nobody scans here. The words allowed through are the surface, the codes in the rows, and the
// two below that have the shape and are not tools, so a tool name that collides with one is missed.
const NAME_SHAPED = /\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g;
const snake = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
const NOT_TOOLS = ['instacloud-oss', 'check-upstreams']; // a repository, and the detector's npm script
const notOffered = (s, ...codes) => {
  const fine = new Set(
    [
      ...surface(),
      ...TOOLS.flatMap((t) => Object.keys(t.inputSchema.properties)),
      ...NOT_TOOLS,
      ...codes,
    ].map(snake),
  );
  return (s.match(NAME_SHAPED) ?? []).filter((n) => !fine.has(snake(n)));
};

// notOffered lets a real tool through, so this is the check that an answer names none at all:
// whether the reader has a tool that moves a pin is the reader's call, and a name here claims it
// does. It reads the text as snake_case, so `steerJob`, `steer-job` and _steer_job_ all count.
// Single words are left out on purpose: a tool called `apply`, `diff` or `check` would fire on the
// correct answer, which has --apply, "the diff" and "This check" in it. A name is also only a name
// when a letter or digit does not run on from it, so check-upstreams is not check_upstream.
const namedTools = (s, names = surface()) => {
  const text = snake(s);
  return names
    .map(snake)
    .filter((n) => n.includes('_') && new RegExp(`(^|[^a-z0-9])${n}($|[^a-z0-9])`).test(text));
};

test('the check for a tool that is not offered catches every spelling of a name, and passes what is offered', () => {
  // Without this, the tests below could be green because the check finds nothing at all. The name is
  // made up on purpose: a real one would stop being absent the day somebody builds it.
  for (const said of [
    'frobnicate_widget(code) opens a draft PR',
    'call frobnicate-widget for it',
    'call frobnicateWidget for it',
    'use `frobnicate_widget`',
  ]) {
    assert.deepEqual(notOffered(said).map(snake), ['frobnicate_widget'], said);
  }
  assert.deepEqual(notOffered('Follow it with follow_job(job_id: "J1", offset: 0, stages: 0).'), []);
  assert.deepEqual(notOffered('review_status, then ask-for-review, then askForReview'), []);
  assert.deepEqual(notOffered('run `npm run check-upstreams -- --apply` in templates/ of InsForge/instacloud-oss'), []);
  assert.deepEqual(notOffered('claude-code: 1 -> 2', 'claude-code'), []);
});

test('the check for any named tool sees every spelling of a real one, and leaves single words alone', () => {
  for (const spelling of ['steer_job', 'steer-job', 'steerJob', 'SteerJob', '_steer_job_', '`steer_job`', 'steer_job(job_id: "J1")']) {
    assert.deepEqual(namedTools(`Tell them, or ${spelling}, for it.`), ['steer_job'], spelling);
  }
  const answer = describeDrift([{ code: 'n8n', from: '1', to: '2', level: 'major' }]);
  const words = ['apply', 'report', 'reports', 'diff', 'pin', 'check', 'this'];
  assert.deepEqual(namedTools(answer, [...words, 'steer_job']), [], 'the correct answer names no tool');
  assert.deepEqual(namedTools(`${answer} steerJob`, [...words, 'steer_job']), ['steer_job']);
  assert.deepEqual(namedTools(answer, ['check_upstream']), [], 'the front of a longer name is not that name');
});

test('check_template_upstream never names a tool, on the surface or not, whatever it finds', async () => {
  const shapes = {
    'one behind, one current, one unresolved': [
      { code: 'n8n', kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor' },
      { code: 'pi', kind: 'npm', current: true },
      { code: 'openclaw', kind: 'docker-digest', unknown: 'a digest needs a registry token' },
    ],
    'several behind, no level': [
      { code: 'laya', from: 'c9dcaab', to: 'd113dca', level: null },
      { code: 'claude-code', from: '1.0.0', to: '2.0.0', level: 'major' },
    ],
    'all current': [{ code: 'pi', current: true }],
    'nothing behind, something unresolved': [
      { code: 'pi', current: true },
      { code: 'openclaw', unknown: 'needs a registry token' },
    ],
    'no rows at all': [],
  };
  for (const [what, rows] of Object.entries(shapes)) {
    const out = await rpc('tools/call', { name: 'check_template_upstream', arguments: {} }, { drift: async () => ({ rows }) });
    const said = out.result.content[0].text;
    assert.ok(said.length > 0 && !out.result.isError, `${what}: there is an answer`);
    assert.deepEqual(notOffered(said, ...rows.map((r) => r.code)), [], `${what}: names a tool nobody can call`);
    assert.deepEqual(namedTools(said), [], `${what}: names a tool, and whether the reader has it is not this server's to say`);
  }
});

test('the answers a person sees when the question goes wrong name no tool that is not on the surface either', async () => {
  const gone = (fields) => () => {
    throw Object.assign(new Error('Command failed: the whole refresh script, which says nothing'), fields);
  };
  const cases = [
    ['a code that cannot be one', { code: 'Not A Code' }, null, /is not a template code/],
    ['an option in the code slot', { code: '--apply' }, null, /'--apply' is not a template code/],
    ['a template that is not there', { code: 'n88n' }, gone({ code: 2, stderr: 'no such template: n88n\n' }), /There is no template called n88n/],
    ['a registry with nothing in it', {}, () => ({ stdout: '[]\n' }), /no templates at all/],
    ['an answer that is not json', {}, () => ({ stdout: 'fatal: unable to access the repository' }), /did not answer with json/],
    ['a run that was killed', {}, gone({ killed: true, signal: 'SIGTERM' }), /was killed/],
    ['a run that failed with output', {}, gone({ code: 1, stderr: 'npm ERR! missing script' }), /exit code 1/],
  ];
  for (const [what, args, behave, shows] of cases) {
    const { scripts, run } = box(behave ?? (() => ({ stdout: '[]' })));
    const out = await rpc('tools/call', { name: 'check_template_upstream', arguments: args }, viaBox(run));
    const said = out.result.content[0].text;
    assert.equal(out.result.isError, true, `${what}: is a refusal`);
    assert.match(said, shows, `${what}: says what went wrong`);
    assert.equal(scripts.length, behave ? 1 : 0, `${what}: the box is reached exactly when the question was well formed`);
    assert.deepEqual(notOffered(said), [], `${what}: names a tool nobody can call`);
  }
});

test('the tool describes itself without naming a tool that is not on the surface', () => {
  const tool = TOOLS.find((t) => t.name === 'check_template_upstream');
  const words = [tool.description, ...Object.values(tool.inputSchema.properties).map((p) => p.description)];
  assert.equal(words.length, 2, 'the description and the one property');
  // claude-code is the example template code the property gives, which is not a tool.
  for (const w of words) assert.deepEqual(notOffered(w, 'claude-code'), [], w);
});

// bump_template. Its own copy of the patcher's answer: the one in test/bump.test.js is not in scope.
const APPLIED = {
  code: 'n8n',
  kind: 'docker-tag',
  level: 'minor',
  upstream: { from: '2.36.5', to: '2.41.3' },
  version: { from: '1.3.2', to: '1.4.0' },
};
const BRANCH = 'feat/n8n-2.41.3';
const NEW_PR = 'https://github.com/InsForge/instacloud-oss/pull/192';
const OLD_PR = 'https://github.com/InsForge/instacloud-oss/pull/191';

// All three calls into the box are stubbed, and each is counted: a stub that throws proves nothing
// when the caller catches what it throws. A test that leaves one out gets an answer, not the box.
const bumpTool = async (args, answers = {}) => {
  const { open = {}, bumped = { applied: APPLIED, branch: BRANCH }, pr = { url: NEW_PR } } = answers;
  const calls = [];
  const handed = {};
  const out = await rpc('tools/call', { name: 'bump_template', arguments: args }, {
    findOpen: async (...a) => (calls.push(`open?:${a[1]}`), (handed.open = a), open),
    bump: async (...a) => (calls.push(`bump:${a[1]}`), (handed.bump = a), bumped),
    openBump: async (...a) => (calls.push(`pr:${a[1]}`), (handed.pr = a), pr),
  });
  return { out, calls, handed, said: out.result.content[0].text };
};

// The only sentences allowed to mention deploying or verifying: the ones that deny it.
const DENIALS = [
  /It has NOT been deployed and no verification has run, so do not say it was tested\./,
  /This did not check whether it has been deployed or verified\./,
];

// Any way of saying a push did not happen, which is false wherever a branch was pushed.
const SAYS_NOT_PUSHED = /\b(nothing|no|not|never)\b[^.\n]{0,40}\bpush/i;

test('bump_template asks whether a bump is open before it pushes anything, then opens a draft pull request', async () => {
  const { out, calls, handed, said } = await bumpTool({ code: 'n8n' });
  // The whole array: a subset or a set check would pass the very order this exists to forbid.
  assert.deepEqual(calls, ['open?:n8n', 'bump:n8n', 'pr:n8n']);
  assert.deepEqual(handed.open, [config, 'n8n']);
  assert.deepEqual(handed.bump, [config, 'n8n']);
  assert.deepEqual(handed.pr, [config, 'n8n', APPLIED, BRANCH], 'the pull request is for what was patched, on the branch that was pushed');
  assert.match(said, /^n8n 2\.36\.5 -> 2\.41\.3 \(minor\), template 1\.3\.2 -> 1\.4\.0$/m);
  assert.match(said, /^Draft pull request: https:\/\/github\.com\/InsForge\/instacloud-oss\/pull\/192$/m);
  assert.match(said, DENIALS[0], 'Hermes must not claim this was tested');
  assert.equal(out.result.content.length, 1);
  assert.equal(out.result.isError, undefined);
});

test('a code with a hyphen in it is a code', async () => {
  const { calls } = await bumpTool({ code: 'claude-code' });
  assert.deepEqual(calls, ['open?:claude-code', 'bump:claude-code', 'pr:claude-code']);
});

test('a bump that is already open is answered with its link, and nothing is bumped or opened', async () => {
  // The branch comes with the link when the list gave one, and a bare link is an answer too.
  for (const open of [{ existing: OLD_PR, head: 'feat/n8n-2.40.0' }, { existing: OLD_PR }]) {
    const { out, calls, said } = await bumpTool({ code: 'n8n' }, { open });
    // Not just no second pull request: the bump ends in a push that would rewrite this one's branch.
    assert.deepEqual(calls, ['open?:n8n'], JSON.stringify(open));
    // Named, not "this template": the weekly run lists eight of these in one message.
    assert.match(said, /^A bump pull request for n8n is already open: https:\/\/github\.com\/InsForge\/instacloud-oss\/pull\/191$/m);
    assert.doesNotMatch(said, /this template/);
    assert.match(said, /Nothing was pushed and nothing was opened\./);
    assert.match(said, DENIALS[1], 'nothing here looked at whether that pull request was ever tested');
    // Somebody may have continued that pull request and deployed it since, so it is not called untested.
    assert.doesNotMatch(said, DENIALS[0]);
    assert.doesNotMatch(said, /->/, 'no move is named, because none was worked out');
    assert.doesNotMatch(said, /Draft pull request/);
    assert.equal(out.result.isError, undefined);
  }
});

test('a pull request that appeared while the bump ran is said to hold the branch this bump pushed', async () => {
  const { out, calls, said } = await bumpTool({ code: 'n8n' }, { pr: { existing: OLD_PR } });
  assert.deepEqual(calls, ['open?:n8n', 'bump:n8n', 'pr:n8n']);
  assert.match(said, /^n8n 2\.36\.5 -> 2\.41\.3 \(minor\), template 1\.3\.2 -> 1\.4\.0$/m);
  // A whole line, so nothing can stand between the words and the link, "Draft pull request:" included.
  assert.ok(said.split('\n').includes(`A bump pull request for n8n appeared while this bump was running: ${OLD_PR}`));
  assert.match(said, /pushed feat\/n8n-2\.41\.3, which is that pull request's branch/);
  assert.match(said, /no second pull request was opened/);
  assert.match(said, DENIALS[0]);
  // A branch WAS pushed, and it is the one that pull request is from.
  assert.doesNotMatch(said, SAYS_NOT_PUSHED);
  assert.doesNotMatch(said, /no pull request of its own/, 'the branch is covered, so it is not stranded');
  assert.equal(out.result.isError, undefined);
});

test('a branch pushed while a different pull request was open is said to be pushed, and is named', async () => {
  // Not the name describeBump would derive from the patch, so the answer can only have it from `stranded`.
  const { out, said } = await bumpTool({ code: 'n8n' }, { pr: { existing: OLD_PR, stranded: 'feat/n8n-9.9.9' } });
  assert.ok(said.split('\n').includes(`A bump pull request for n8n is already open: ${OLD_PR}`));
  assert.match(said, /pushed a branch anyway, feat\/n8n-9\.9\.9,/);
  assert.match(said, /not known to be from it/);
  assert.match(said, /no pull request of its own/);
  assert.match(said, /Nothing was opened\./);
  assert.match(said, DENIALS[0]);
  // The one thing the plain "already open" answer says, and false here.
  assert.doesNotMatch(said, SAYS_NOT_PUSHED);
  assert.doesNotMatch(said, /appeared while/, 'this is not the case where the pull request holds the branch');
  assert.equal(out.result.isError, undefined);
});

test('a template that is current opens nothing and says so', async () => {
  const { out, calls, said } = await bumpTool({ code: 'pi' }, { bumped: { current: true, code: 'pi' } });
  assert.deepEqual(calls, ['open?:pi', 'bump:pi'], 'nothing to open for a template that has not moved');
  assert.equal(said, 'pi is up to date, so there is nothing to open.');
  assert.equal(out.result.isError, undefined);
});

test('a refusal from the patcher reaches the person, with its reason, and nothing is opened', async () => {
  const bumped = { refused: 'the Dockerfile does not name c9dcaab in any instruction', code: 'laya' };
  const { out, calls, said } = await bumpTool({ code: 'laya' }, { bumped });
  assert.deepEqual(calls, ['open?:laya', 'bump:laya']);
  assert.equal(said, 'laya was not patched: the Dockerfile does not name c9dcaab in any instruction');
  assert.equal(out.result.isError, true);
});

test('an error at any of the three calls is the answer as written, and stops there', async () => {
  const error = 'The branch is pushed but the pull request was not opened: no route to github.';
  for (const [stage, answers, expected] of [
    // Not being able to ask is not a licence to bump: the push is what cannot be taken back.
    ['asking', { open: { error } }, ['open?:n8n']],
    ['bumping', { bumped: { error } }, ['open?:n8n', 'bump:n8n']],
    ['opening', { pr: { error } }, ['open?:n8n', 'bump:n8n', 'pr:n8n']],
  ]) {
    const { out, calls } = await bumpTool({ code: 'n8n' }, answers);
    assert.deepEqual(calls, expected, stage);
    assert.deepEqual(out.result, { content: [{ type: 'text', text: error }], isError: true }, stage);
  }
});

test('bump_template refuses a code that is not one, and reaches nothing', async () => {
  // The bump WRITES and PUSHES on a box that holds push rights. The pattern is checked here, before any
  // call, because with the calls stubbed nothing else would stop an option arriving as a code.
  for (const code of ['--apply', '--apply --json', 'n8n --apply', 'n8n; reboot', '$(reboot)', '-h', 'N8N', 'n8n\n', '', 'a--b']) {
    const { out, calls, said } = await bumpTool({ code });
    assert.deepEqual(calls, [], `${JSON.stringify(code)} must not reach anything`);
    assert.equal(out.result.isError, true, `${JSON.stringify(code)} is refused`);
    assert.match(said, /is not a template code/, JSON.stringify(code));
  }
  const missing = await bumpTool({});
  assert.deepEqual(missing.calls, [], 'no code at all reaches nothing either');
  assert.equal(missing.out.result.isError, true);
  // What a caller wrote lands in a chat reply, so a refusal does not repeat all of it.
  const long = await bumpTool({ code: 'N'.repeat(5000) });
  assert.equal(long.out.result.isError, true);
  assert.ok(long.said.length < 200, `${long.said.length} characters`);
});

test('whatever bump_template says, it says nothing untrue about testing and names no tool', async () => {
  const shapes = {
    opened: [{}, 0],
    'opened, no level': [{ bumped: { applied: { ...APPLIED, level: null }, branch: BRANCH } }, 0],
    'found open first': [{ open: { existing: OLD_PR, head: 'feat/n8n-2.40.0' } }, 1],
    'found open late': [{ pr: { existing: OLD_PR } }, 0],
    'found open late, branch stranded': [{ pr: { existing: OLD_PR, stranded: BRANCH } }, 0],
  };
  for (const [what, [answers, denial]] of Object.entries(shapes)) {
    const { out, said } = await bumpTool({ code: 'n8n' }, answers);
    assert.equal(out.result.isError, undefined, what);
    assert.doesNotMatch(said, /undefined|null|NaN|\[object/, `${what}: a blank was left in the answer`);
    assert.match(said, DENIALS[denial], `${what}: says what was not done`);
    assert.doesNotMatch(said, DENIALS[1 - denial], `${what}: says the other shape's denial`);
    // Take the denials out and nothing left may claim anything about how well it is known to work.
    const rest = DENIALS.reduce((s, d) => s.replace(d, ''), said);
    assert.doesNotMatch(rest, /\b(deploy|test|verif|valid|check|pass|green|work|safe|ready|confirm|approv|good|succe|complet|done|finish)/i, `${what}: says something about testing that is not a denial`);
    assert.deepEqual(namedTools(said), [], `${what}: names a tool, and whether the reader has it is not this server's to say`);
  }
});

test('bump_template is described so that nobody needs a skill to use it', () => {
  const tool = TOOLS.find((t) => t.name === 'bump_template');
  const d = tool.description;
  assert.match(d, /open a DRAFT pull request with the result/);
  assert.match(d, /Every edit is made by the registry's own patcher and none is written by hand/);
  assert.match(d, /refuses rather than leave a file half edited/);
  // The patcher reads live registries, so the same command later can write a different patch.
  assert.doesNotMatch(d, /deterministic/);
  assert.match(d, /It does NOT deploy the result and nothing verifies that the template still works, so never say it was tested/);
  // What the push does besides open a pull request: the tool is not only "a draft, nothing deployed".
  assert.match(d, /so never say it was tested\. Pushing the branch also runs that repository's image build, which publishes container images to GHCR under tags for the branch and commit, and because a new branch has no base to compare against, that first run rebuilds every template that ships its own image\. It first asks/);
  // It asks before it pushes, and what it answers when the answer is yes.
  assert.match(d, /first asks whether a bump pull request for this template is already open/);
  assert.match(d, /answers with that link and pushes and opens nothing/);
  assert.match(d, /already up to date opens nothing and says so/);
  assert.match(d, /another bump of the same template runs waits for it, and gives up with an error after a short while/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['code']);
  assert.deepEqual(tool.inputSchema.required, ['code']);
  // claude-code is the example code the property gives, which is not a tool.
  for (const w of [d, tool.inputSchema.properties.code.description]) assert.deepEqual(notOffered(w, 'claude-code'), [], w);
});

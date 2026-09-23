import test from 'node:test';
import assert from 'node:assert/strict';
import { newJobId, buildTask, parseResult, startJob, readJob, jobFeed, stageInstructions } from '../src/agent.js';

const config = {
  instaBin: 'insta',
  agentProjectId: 'proj-1',
  agentService: 'claude-code',
  instaApiKey: 'insta_x',
};

test('job ids are sortable by time and unique enough', () => {
  const a = newJobId(Date.parse('2026-09-17T19:30:00Z'), () => 'aaaaaa');
  const b = newJobId(Date.parse('2026-09-17T19:31:00Z'), () => 'bbbbbb');
  assert.match(a, /^\d{14}-[0-9a-f]{6}$/);
  assert.ok(a < b, 'later job sorts after earlier one');
});

test('the task names the repo and forbids publishing', () => {
  const task = buildTask({ url: 'https://github.com/a/b' });
  assert.match(task, /https:\/\/github\.com\/a\/b/);
  assert.match(task, /Do not publish/);
  assert.match(task, /DRAFT PR/);
});

test('extra instructions are passed through', () => {
  const task = buildTask({ url: 'https://github.com/a/b', extra: 'use the tiny model' });
  assert.match(task, /use the tiny model/);
});

test('parseResult reads the block the agent is asked to print', () => {
  const log = `blah blah
RESULT
verdict: thin-shell
project: abc-123
service: https://x.example.com
pr: https://github.com/InsForge/instacloud-oss/pull/7
ask: decide whether base or tiny is the right default
ask: crm is a new meta.category
ask: alwaysOn bills continuously`;
  const r = parseResult(log);
  assert.equal(r.verdict, 'thin-shell');
  assert.equal(r.project, 'abc-123');
  assert.equal(r.pr, 'https://github.com/InsForge/instacloud-oss/pull/7');
  assert.deepEqual(r.asks, [
    'decide whether base or tiny is the right default',
    'crm is a new meta.category',
    'alwaysOn bills continuously',
  ]);
});

test('created lines are collected separately from asks', () => {
  const log = `RESULT
verdict: thin-shell
created: signed up admin@example.com / 12345678
created: seeded one contact named "Acme Test"
ask: crm is a new meta.category`;
  const r = parseResult(log);
  assert.deepEqual(r.created, [
    'signed up admin@example.com / 12345678',
    'seeded one contact named "Acme Test"',
  ]);
  assert.deepEqual(r.asks, ['crm is a new meta.category']);
});

test('the task tells the agent to report what it made and to withhold what it was given', () => {
  const task = buildTask({ url: 'https://github.com/a/b' });
  assert.match(task, /created: /, 'the field exists in the contract');
  assert.match(task, /BROUGHT INTO EXISTENCE/, 'only its own doing');
  assert.match(task, /GitHub\s+token and the platform key/, 'never the credentials it was handed');
});

test('an agent still writing the old one-line "asks:" is not dropped on the floor', () => {
  // Jobs launched before the contract changed are still in flight.
  const r = parseResult('RESULT\nverdict: out\nasks: (1) one thing; (2) another');
  assert.deepEqual(r.asks, ['(1) one thing; (2) another']);
});

test('parseResult treats "none" as absent, so the bot does not print empty links', () => {
  const r = parseResult('RESULT\nverdict: out\nproject: none\nservice: none\npr: none\nask: none');
  assert.equal(r.verdict, 'out');
  assert.equal(r.project, null);
  assert.equal(r.pr, null);
  assert.deepEqual(r.asks, []);
});

test('parseResult returns null when the agent never printed one', () => {
  assert.equal(parseResult('it just rambled and stopped'), null);
});

test('parseResult uses the LAST result block, not a quoted earlier one', () => {
  const log = 'RESULT\nverdict: out\n\nlater...\nRESULT\nverdict: directly-usable';
  assert.equal(parseResult(log).verdict, 'directly-usable');
});

// Decodes the run.sh the outer script writes, so assertions can be made about
// what will actually execute rather than about the transport.
function runnerOf(script) {
  const m = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \S+run\.sh/);
  assert.ok(m, 'the script must ship a base64 run.sh');
  return Buffer.from(m[1], 'base64').toString('utf8');
}

test('startJob launches with nohup and writes an exit code afterwards', async () => {
  let script = null;
  const run = async (_cfg, s) => {
    script = s;
    return { stdout: 'started' };
  };
  const { jobId, dir } = await startJob(config, { url: 'https://github.com/a/b' }, { run, jobId: 'J1' });

  assert.equal(jobId, 'J1');
  assert.equal(dir, '/data/work/jobs/J1');
  assert.match(script, /nohup setsid sh \S+run\.sh/, 'setsid so one kill reaches the whole job');

  const runnerText = runnerOf(script);
  assert.match(runnerText, /echo \$\$ > \S+pid/, 'records its pid so it can be stopped');

  const runner = runnerOf(script);
  assert.match(runner, /exit\.code/, 'completion signal must be written');
  assert.match(runner, /--allowedTools/, 'must not run with permissions bypassed');
  assert.ok(!runner.includes('set -e'), 'set -e would skip writing exit.code on failure');
  assert.ok(!script.includes('dangerously'), 'never bypasses permission checks');
});

test('the agent gets a headless browser, configured per job and nowhere else', async () => {
  let script = null;
  const run = async (_cfg, s) => {
    script = s;
    return { stdout: 'started' };
  };
  await startJob(config, { url: 'https://github.com/a/b' }, { run, jobId: 'J7' });

  const runner = runnerOf(script);
  assert.match(runner, /'mcp__playwright'/, 'the browser tools are allowed');
  assert.match(runner, /--mcp-config \S+J7\/mcp\.json --strict-mcp-config/, 'this job config only, nothing inherited from the box');

  const mcp = JSON.parse(fileOf(script, 'mcp.json'));
  const args = mcp.mcpServers.playwright.args;
  assert.equal(args[args.indexOf('--browser') + 1], 'chromium', 'the default channel is system Chrome, which is not installed');
  assert.ok(args.includes('--headless'), 'no display on the box');
  assert.ok(args.includes('--isolated'), "one template must never see another's cookies");
  assert.equal(args[args.indexOf('--output-dir') + 1], '/data/work/jobs/J7/browser', 'screenshots beside the job, not inside a clone');
  assert.match(args.find((a) => a.startsWith('@playwright/mcp@')), /@\d/, 'pinned, not @latest');
});

test('the runner reinstalls browser libraries after a restart wiped the root disk', async () => {
  let script = null;
  const run = async (_cfg, s) => {
    script = s;
    return { stdout: 'started' };
  };
  await startJob(config, { url: 'https://github.com/a/b' }, { run, jobId: 'J8' });

  const runner = runnerOf(script);
  assert.match(runner, /dpkg -s libnss3/, 'cheap check first');
  assert.match(runner, /playwright@\S+ install --with-deps chromium/, 'the full install only when something is missing');
  assert.ok(runner.indexOf('dpkg -s') < runner.indexOf('claude -p'), 'the check runs before claude starts');
});

test('the verify stage is four verdicts, not prose', () => {
  const text = stageInstructions('/data/work/jobs/J1');
  assert.match(text, /verify: reach ✓\s+enter ✓\s+round-trip ✓\s+survive ✓/);
  assert.match(text, /never free text/);
});

// Any file the outer script ships as base64, decoded.
function fileOf(script, name) {
  const m = script.match(new RegExp(`printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d > \\S+${name.replace('.', '\\.')}`));
  assert.ok(m, `the script must ship a base64 ${name}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

test('the tool patterns never appear unencoded in the command line', async () => {
  // Regression: the runner used to be inlined as `sh -c '... 'Read' 'Bash(insta *)' ...'`,
  // whose inner quotes closed the outer one. That left the parenthesis bare
  // (`sh: Syntax error: "(" unexpected`) and the shell ate the `*` as a glob.
  let script = null;
  const run = async (_cfg, s) => {
    script = s;
    return { stdout: 'started' };
  };
  await startJob(config, { url: 'https://github.com/a/b' }, { run, jobId: 'J3' });

  assert.ok(!script.includes('Bash('), 'tool patterns must travel encoded, not on the command line');
  assert.ok(!script.includes("sh -c"), 'no inline sh -c to quote-escape wrongly');

  const runner = runnerOf(script);
  assert.match(runner, /'Bash\(insta \*\)'/, 'the glob must survive intact');
  assert.match(runner, /'Bash\(gh \*\)'/);
});

test('the task text reaches the box base64-encoded, never inline in the shell', async () => {
  let script = null;
  const run = async (_cfg, s) => {
    script = s;
    return { stdout: 'started' };
  };
  // A repo whose name would break a naive shell string
  await startJob(config, { url: "https://github.com/a/b", extra: "it's \"quoted\" `backticks`" }, { run, jobId: 'J2' });
  assert.match(script, /base64 -d/);
  assert.ok(!script.includes('backticks'), 'raw task text must not appear in the script');
});

test('readJob reports running while the exit code is absent', async () => {
  const run = async () => ({ stdout: 'STATUS running\n---STAGES---\n---LOG---\nworking on it' });
  const state = await readJob(config, 'J1', { run });
  assert.equal(state.done, false);
  assert.equal(state.exitCode, null);
  assert.equal(state.log, 'working on it');
});

test('readJob reports done with the exit code once it lands', async () => {
  const run = async () => ({ stdout: 'STATUS done 0\n---STAGES---\n---LOG---\nRESULT\nverdict: out' });
  const state = await readJob(config, 'J1', { run });
  assert.equal(state.done, true);
  assert.equal(state.exitCode, 0);
  assert.match(state.log, /verdict: out/);
});

test('readJob keeps log content that itself contains the separator', async () => {
  const run = async () => ({ stdout: 'STATUS done 0\n---STAGES---\n---LOG---\na\n---LOG---\nb' });
  const state = await readJob(config, 'J1', { run });
  assert.match(state.log, /a/);
  assert.match(state.log, /b/);
});

test('readJob returns the stage lines the agent has appended', async () => {
  const run = async () => ({
    stdout:
      'STATUS running\n---STAGES---\ntriage: thin-shell — no HTTP face\npr: https://x/1 — waiting on CI\n---STEPS---\nRead templates/AGENTS.md\n$ insta template deploy .\n---LOG---\n',
  });
  const state = await readJob(config, 'J1', { run });
  assert.deepEqual(state.stages, [
    'triage: thin-shell — no HTTP face',
    'pr: https://x/1 — waiting on CI',
  ]);
  assert.deepEqual(state.steps, ['Read templates/AGENTS.md', '$ insta template deploy .']);
  assert.equal(state.done, false);
});

test('output from before the trace existed still parses, minus the trace', async () => {
  const run = async () => ({
    stdout: 'STATUS done 0\n---STAGES---\ntriage: directly-usable — nothing to patch\n---LOG---\nRESULT\n',
  });
  const state = await readJob(config, 'J1', { run });
  assert.deepEqual(state.stages, ['triage: directly-usable — nothing to patch']);
  assert.deepEqual(state.steps, [], 'a missing section is empty, not the section after it');
  assert.equal(state.log, 'RESULT');
});

test('no stage file yet means no stages, not a crash', async () => {
  const run = async () => ({ stdout: 'STATUS running\n---STAGES---\n---STEPS---\n---LOG---\n' });
  const state = await readJob(config, 'J1', { run });
  assert.deepEqual(state.stages, []);
});

test('the steps it is asked to report are the steps it actually walks', () => {
  // The four it had before stopped at `build`, so the twenty minutes of
  // deploying and debugging a stalled migration had no line to be written on,
  // and the thread went quiet at exactly the interesting part.
  const task = buildTask({ url: 'https://github.com/a/b', dir: '/data/work/jobs/J1' });
  for (const step of ['triage:', 'manifest:', 'pr:', 'build:', 'deploy:', 'verify:']) {
    assert.match(task, new RegExp(step.replace(':', ':')), `${step} has somewhere to be reported`);
  }
  assert.match(task, /more than about five minutes/, 'a long step still has to say something');
});

test('the task tells the agent where to append its stages', () => {
  const task = buildTask({ url: 'https://github.com/a/b', dir: '/data/work/jobs/J1' });
  assert.match(task, /\/data\/work\/jobs\/J1\/stage\.txt/);
  assert.match(task, /triage:/);
  assert.match(task, /Append, never rewrite/);
});

test('every start puts the current job-feed on the box, where the follower reads from', async () => {
  let script = '';
  await startJob(
    { agentService: 'claude-code', instaBin: 'insta' },
    { url: 'https://github.com/a/b', slack: {} },
    { run: async (_c, s) => ((script = s), { stdout: 'started' }), jobId: 'J1', sessionId: 'S1' },
  );
  const m = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/data\/home\/bin\/job-feed/);
  assert.ok(m, 'job-feed is written to a fixed path, not into the job dir');
  const body = Buffer.from(m[1], 'base64').toString();
  assert.match(body, /next: \$\{nextOffset\}/, 'and it is the feed that hands back its own offsets');
  assert.match(script, /chmod 755 \/data\/home\/bin\/job-feed/);
});

test('jobFeed asks the box to wait, and reads its offsets back', async () => {
  let script = '';
  const run = async (_c, s) => ((script = s), { stdout: 'stage: pr: https://x/1\nsaid: waiting on CI\nnext: 4096 3 status: running\n' });
  const f = await jobFeed({}, 'J1', { offset: 10, stages: 2 }, { run });
  assert.equal(script, '/data/home/bin/job-feed J1 10 2 45');
  assert.deepEqual(f.activity, ['stage: pr: https://x/1', 'said: waiting on CI']);
  assert.equal(f.offset, 4096);
  assert.equal(f.stages, 3);
  assert.equal(f.done, false);
});

test('jobFeed reads a finished job and its exit code', async () => {
  const run = async () => ({ stdout: 'next: 9 8 status: done exit=0\n' });
  const f = await jobFeed({}, 'J1', {}, { run });
  assert.equal(f.done, true);
  assert.equal(f.exitCode, 0);
  assert.deepEqual(f.activity, []);
});

test('jobFeed never puts anything but a job id and numbers into the command', async () => {
  const run = async () => assert.fail('must not run');
  await assert.rejects(() => jobFeed({}, 'J1; rm -rf /', {}, { run }), /not a job id/);
  let script = '';
  await jobFeed({}, 'J1', { offset: '3; ls', stages: -4 }, { run: async (_c, s) => ((script = s), { stdout: 'next: 0 0 status: running' }) });
  assert.equal(script, '/data/home/bin/job-feed J1 0 0 45');
});

test('an answer that is not job-feed output is an error, not a guess', async () => {
  const run = async () => ({ stdout: 'bash: job-feed: No such file or directory' });
  await assert.rejects(() => jobFeed({}, 'J1', {}, { run }), /something else/);
});

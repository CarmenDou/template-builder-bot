import test from 'node:test';
import assert from 'node:assert/strict';
import { newJobId, buildTask, parseResult, startJob, readJob } from '../src/agent.js';

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
asks: decide whether base or tiny is the right default`;
  const r = parseResult(log);
  assert.equal(r.verdict, 'thin-shell');
  assert.equal(r.project, 'abc-123');
  assert.equal(r.pr, 'https://github.com/InsForge/instacloud-oss/pull/7');
  assert.match(r.asks, /base or tiny/);
});

test('parseResult treats "none" as absent, so the bot does not print empty links', () => {
  const r = parseResult('RESULT\nverdict: out\nproject: none\nservice: none\npr: none\nasks: none');
  assert.equal(r.verdict, 'out');
  assert.equal(r.project, null);
  assert.equal(r.pr, null);
  assert.equal(r.asks, null);
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
  assert.match(script, /nohup sh \S+run\.sh/, 'must survive the exec channel closing');

  const runner = runnerOf(script);
  assert.match(runner, /exit\.code/, 'completion signal must be written');
  assert.match(runner, /--allowedTools/, 'must not run with permissions bypassed');
  assert.ok(!runner.includes('set -e'), 'set -e would skip writing exit.code on failure');
  assert.ok(!script.includes('dangerously'), 'never bypasses permission checks');
});

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
  const run = async () => ({ stdout: 'STATUS running\n---LOG---\nworking on it' });
  const state = await readJob(config, 'J1', { run });
  assert.equal(state.done, false);
  assert.equal(state.exitCode, null);
  assert.equal(state.log, 'working on it');
});

test('readJob reports done with the exit code once it lands', async () => {
  const run = async () => ({ stdout: 'STATUS done 0\n---LOG---\nRESULT\nverdict: out' });
  const state = await readJob(config, 'J1', { run });
  assert.equal(state.done, true);
  assert.equal(state.exitCode, 0);
  assert.match(state.log, /verdict: out/);
});

test('readJob keeps log content that itself contains the separator', async () => {
  const run = async () => ({ stdout: 'STATUS done 0\n---LOG---\na\n---LOG---\nb' });
  const state = await readJob(config, 'J1', { run });
  assert.match(state.log, /a/);
  assert.match(state.log, /b/);
});

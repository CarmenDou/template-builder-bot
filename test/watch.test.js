import test from 'node:test';
import assert from 'node:assert/strict';
import { watchJob } from '../src/watch.js';

const config = { slackBotToken: 'xoxb-test', jobTimeoutMs: 60_000, pollIntervalMs: 0 };
const job = { jobId: 'J1', url: 'https://github.com/twentyhq/twenty', channel: 'C1', threadTs: '1.1' };

function slack() {
  const posted = [];
  return { posted, post: async (m) => (posted.push(m), { ok: true, ts: `ts${posted.length}` }) };
}

/** A scripted sequence of job states, one per poll. */
const reader = (states) => {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)];
};

test('a stage line reaches the thread with nothing added to it', async () => {
  const line = 'deploy: migration stalled after creating the postgres extensions, reading logs first';
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: [line], steps: ['x'], done: false },
      { stages: [line], steps: ['x'], done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  assert.equal(s.posted[0].text, line, 'verbatim: the watcher is a wire, not a voice');
  assert.equal(s.posted[0].threadTs, '1.1');
});

test('each stage is said once, however many times it is read', async () => {
  const stages = ['triage: thin-shell', 'build: green'];
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: stages.slice(0, 1), steps: [], done: false },
      { stages: stages.slice(0, 1), steps: [], done: false },
      { stages, steps: [], done: false },
      { stages, steps: [], done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  for (const line of stages) {
    assert.equal(s.posted.filter((m) => m.text === line).length, 1, line);
  }
});

test('what the agent did is never posted, only what it said about it', async () => {
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: [], steps: ['searching for healthz in packages/twenty-server/src'], done: false },
      { stages: [], steps: ['searching for healthz in packages/twenty-server/src'], done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  assert.ok(!s.posted.some((m) => /searching for healthz/.test(m.text)), 'the raw trace stays out of the thread');
});

test('the result arrives without anyone asking', async () => {
  const s = slack();
  const out = await watchJob(config, job, {
    read: reader([{ stages: [], steps: [], done: true, exitCode: 0, log: 'RESULT\nverdict: thin-shell\n' }]),
    ...s,
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
  assert.match(s.posted.at(-1).text, /thin-shell/);
});

test('a Slack failure never ends the watch', async () => {
  const out = await watchJob(config, job, {
    read: reader([
      { stages: ['triage: x'], steps: [], done: false },
      { stages: ['triage: x'], steps: [], done: true, exitCode: 0, log: '' },
    ]),
    post: async () => {
      throw new Error('ratelimited');
    },
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
});

test('a dropped channel is waited out, not treated as the end', async () => {
  const s = slack();
  let calls = 0;
  const read = async () => {
    calls += 1;
    if (calls < 3) throw new Error('exec channel dropped');
    return { stages: [], steps: [], done: true, exitCode: 0, log: 'RESULT\n' };
  };
  const out = await watchJob(config, job, { read, ...s, sleep: async () => {} });
  assert.ok(calls >= 3);
  assert.equal(out.finished, true);
});

test('running out of patience is reported as still running, not as failure', async () => {
  const s = slack();
  let t = 0;
  const out = await watchJob(config, job, {
    read: reader([{ stages: [], steps: [], done: false, log: 'still going' }]),
    ...s,
    sleep: async () => {},
    now: () => (t += 20_000),
  });
  assert.equal(out.finished, false);
  assert.match(s.posted.at(-1).text, /NOT been killed/);
});

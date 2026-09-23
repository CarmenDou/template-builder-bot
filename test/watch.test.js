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

const steps = (n, from = 0) => Array.from({ length: n }, (_, i) => `action ${from + i + 1}`);
const done = (extra = {}) => ({ stages: [], steps: [], done: true, exitCode: 0, log: '', ...extra });

test('what the agent did goes to the narrator, not into the thread', async () => {
  const s = slack();
  const seen = [];
  await watchJob(config, job, {
    read: reader([{ stages: [], steps: steps(8), done: false }, done({ steps: steps(8) })]),
    ...s,
    say: async (_c, { activity }) => (seen.push(activity), 'Reading how Twenty starts.'),
    sleep: async () => {},
  });
  assert.deepEqual(seen[0], steps(8), 'the raw actions reach the narrator');
  const texts = s.posted.map((m) => m.text);
  assert.ok(texts.includes('Reading how Twenty starts.'), 'the sentence is posted');
  assert.ok(!texts.some((t) => /action \d/.test(t)), 'and the raw actions are not');
});

test('a handful of new actions is not worth a sentence yet', async () => {
  const s = slack();
  let calls = 0;
  await watchJob(config, job, {
    read: reader([{ stages: [], steps: steps(2), done: false }, done({ steps: steps(2) })]),
    ...s,
    say: async () => (calls += 1, 'something'),
    sleep: async () => {},
  });
  assert.equal(calls, 1, 'only the one at the end, when there is nothing left to wait for');
});

test('each sentence is told what the last one was, so it does not repeat', async () => {
  const s = slack();
  const previous = [];
  await watchJob(config, job, {
    read: reader([
      { stages: [], steps: steps(8), done: false },
      { stages: [], steps: steps(16), done: false },
      done({ steps: steps(16) }),
    ]),
    ...s,
    say: async (_c, p) => (previous.push(p.previous), `sentence ${previous.length}`),
    sleep: async () => {},
  });
  assert.equal(previous[0], '');
  assert.equal(previous[1], 'sentence 1');
});

test('a narrator with nothing to say posts nothing', async () => {
  const s = slack();
  await watchJob(config, job, {
    read: reader([{ stages: [], steps: steps(9), done: false }, done({ steps: steps(9) })]),
    ...s,
    say: async () => '',
    sleep: async () => {},
  });
  assert.ok(!s.posted.some((m) => /^$/.test(m.text)), 'no empty message is sent');
});

test('a milestone is posted as plainly as anything else', async () => {
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: ['triage: thin-shell — no command: key'], steps: [], done: false },
      done({ stages: ['triage: thin-shell — no command: key'] }),
    ]),
    ...s,
    say: async () => '',
    sleep: async () => {},
  });
  const milestone = s.posted.find((m) => /triage/.test(m.text));
  assert.equal(milestone.text, 'triage: thin-shell — no command: key');
  assert.doesNotMatch(milestone.text, /[*•]/, 'no bullet and no bold: one voice in the thread');
});

test('each milestone is said once, however many times it is read', async () => {
  const s = slack();
  const stages = ['triage: x', 'pr: y'];
  await watchJob(config, job, {
    read: reader([
      { stages: stages.slice(0, 1), steps: [], done: false },
      { stages, steps: [], done: false },
      done({ stages }),
    ]),
    ...s,
    say: async () => '',
    sleep: async () => {},
  });
  assert.equal(s.posted.filter((m) => m.text === 'triage: x').length, 1);
  assert.equal(s.posted.filter((m) => m.text === 'pr: y').length, 1);
});

test('the result arrives without anyone asking', async () => {
  const s = slack();
  const out = await watchJob(config, job, {
    read: reader([done({ log: 'RESULT\nverdict: thin-shell\n' })]),
    ...s,
    say: async () => '',
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
  assert.ok(s.posted.length >= 1);
});

test('a Slack failure never ends the watch', async () => {
  const out = await watchJob(config, job, {
    read: reader([{ stages: ['triage: x'], steps: steps(8), done: false }, done({ stages: ['triage: x'] })]),
    post: async () => { throw new Error('ratelimited'); },
    say: async () => 'a sentence',
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
});

test('a narrator that throws does not take the job report with it', async () => {
  const s = slack();
  const out = await watchJob(config, job, {
    read: reader([done({ steps: steps(8), log: 'RESULT\n' })]),
    ...s,
    say: async () => { throw new Error('anthropic is down'); },
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
  assert.ok(s.posted.length >= 1, 'the result still lands');
});

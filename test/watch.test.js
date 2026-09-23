import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTrace, fitTrace, watchJob } from '../src/watch.js';

const config = {
  slackBotToken: 'xoxb-test',
  jobTimeoutMs: 60_000,
  pollIntervalMs: 0,
};
const job = { jobId: 'J1', url: 'https://github.com/a/b', channel: 'C1', threadTs: '1.1' };

function slack() {
  const posted = [];
  const updated = [];
  return {
    posted,
    updated,
    post: async (m) => (posted.push(m), { ok: true, ts: `ts${posted.length}` }),
    update: async (m) => (updated.push(m), { ok: true }),
  };
}

/** Reads a scripted sequence of job states, one per poll. */
const reader = (states) => {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)];
};

test('the trace keeps every line rather than showing a window', async () => {
  const steps = Array.from({ length: 40 }, (_, i) => `step ${i + 1}`);
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: [], steps: steps.slice(0, 5), done: false },
      { stages: [], steps, done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  const trace = [...s.posted, ...s.updated].map((m) => m.text).join('\n');
  for (const line of steps) assert.match(trace, new RegExp(`• ${line}$`, 'm'), `${line} survived`);
  assert.doesNotMatch(trace, /earlier/, 'nothing is collapsed away');
});

test('one message grows in place instead of a message per step', async () => {
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: [], steps: ['a'], done: false },
      { stages: [], steps: ['a', 'b'], done: false },
      { stages: [], steps: ['a', 'b', 'c'], done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  const tracePosts = s.posted.filter((m) => /^Working/.test(m.text));
  assert.equal(tracePosts.length, 1, 'the trace is posted once');
  assert.ok(s.updated.length >= 2, 'and rewritten as it grows');
  assert.match(s.updated.at(-1).text, /• a\n• b\n• c/);
});

test('a trace too long for one message continues in a second one', async () => {
  const long = Array.from({ length: 80 }, (_, i) => `${'x'.repeat(90)} ${i}`);
  const s = slack();
  await watchJob(config, job, {
    read: reader([{ stages: [], steps: long, done: true, exitCode: 0, log: '' }]),
    ...s,
    sleep: async () => {},
  });
  const traces = [...s.posted, ...s.updated].filter((m) => /^(Working|Finished)/.test(m.text));
  assert.ok(traces.length >= 2, 'it rolls over');
  for (const m of traces) assert.ok(m.text.length <= 4000, 'and every message is sendable');
  const seen = traces.flatMap((m) => m.text.split('\n')).filter((l) => l.startsWith('• '));
  assert.equal(seen.length, long.length, 'across the messages, nothing is lost');
});

test('a stage is its own message, because it is a landmark', async () => {
  const s = slack();
  await watchJob(config, job, {
    read: reader([
      { stages: ['triage: directly-usable — nothing to patch'], steps: [], done: false },
      { stages: ['triage: directly-usable — nothing to patch'], steps: [], done: true, exitCode: 0, log: '' },
    ]),
    ...s,
    sleep: async () => {},
  });
  assert.ok(s.posted.some((m) => /\*triage\*/.test(m.text)), 'the stage is posted on its own');
});

test('the result arrives without anyone asking', async () => {
  const s = slack();
  const out = await watchJob(config, job, {
    read: reader([{ stages: [], steps: [], done: true, exitCode: 0, log: 'RESULT\nverdict: directly-usable\n' }]),
    ...s,
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
  assert.ok(s.posted.length >= 1);
});

test('a Slack failure never ends the watch', async () => {
  const failing = { post: async () => { throw new Error('ratelimited'); }, update: async () => { throw new Error('nope'); } };
  const out = await watchJob(config, job, {
    read: reader([
      { stages: ['triage: x'], steps: ['a'], done: false },
      { stages: ['triage: x'], steps: ['a'], done: true, exitCode: 0, log: '' },
    ]),
    ...failing,
    sleep: async () => {},
  });
  assert.equal(out.finished, true);
});

test('fitTrace never returns an empty first page, which would not terminate', () => {
  const huge = ['y'.repeat(9000)];
  const { shown, overflow } = fitTrace(huge, { first: true });
  assert.equal(shown.length, 1);
  assert.equal(overflow.length, 0);
});

test('renderTrace says which message this is', () => {
  assert.match(renderTrace(['a'], { first: true }), /^Working\n/);
  assert.match(renderTrace(['a'], { first: true, done: true }), /^Finished\n/);
  assert.match(renderTrace(['a'], { first: false }), /^Working, continued\n/);
});

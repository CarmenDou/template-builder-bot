import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMention, followJob, describeResult, describeTimeout } from '../src/handler.js';

const config = {
  allowedChannels: ['C_OK'],
  jobTimeoutMs: 1000,
  pollIntervalMs: 10,
};

const mention = (text, channel = 'C_OK') => ({ channel, text, ts: '1.0' });

test('stays silent in a channel it does not serve', async () => {
  const out = await handleMention({
    event: mention('https://github.com/a/b', 'C_OTHER'),
    config,
    deps: { start: async () => assert.fail('must not start work') },
  });
  assert.equal(out.reply, null);
  assert.equal(out.job, null);
});

test('explains itself when there is no url', async () => {
  const out = await handleMention({ event: mention('hello'), config, deps: {} });
  assert.match(out.reply, /GitHub repository URL/);
  assert.equal(out.job, null);
});

test('refuses two repos in one message instead of guessing', async () => {
  const out = await handleMention({
    event: mention('https://github.com/a/b https://github.com/c/d'),
    config,
    deps: { start: async () => assert.fail('must not start work') },
  });
  assert.match(out.reply, /one at a time/);
  assert.equal(out.job, null);
});

test('starts the job and says what will happen', async () => {
  let started = null;
  const out = await handleMention({
    event: mention('<@U1> https://github.com/a/b'),
    config,
    deps: {
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J9' };
      },
    },
  });
  assert.equal(started.url, 'https://github.com/a/b');
  assert.equal(out.job.jobId, 'J9');
  assert.match(out.reply, /J9/);
  assert.match(out.reply, /draft PR/i);
});

test('reports the result once the job finishes', async () => {
  const read = async () => ({
    done: true,
    exitCode: 0,
    log: 'RESULT\nverdict: directly-usable\npr: https://example.com/pr/1\nservice: https://svc.example.com\nproject: p1\nasks: none',
  });
  const text = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.match(text, /directly-usable/);
  assert.match(text, /example\.com\/pr\/1/);
  assert.match(text, /Nothing was published/);
});

test('says plainly when the agent finished without a RESULT block', async () => {
  const read = async () => ({ done: true, exitCode: 1, log: 'it crashed somewhere' });
  const text = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.match(text, /did not print a RESULT block/);
  assert.match(text, /exit code 1/);
  assert.ok(!/verdict/i.test(text), 'must not invent a verdict');
});

test('a dropped exec channel does not end the watch', async () => {
  let calls = 0;
  const read = async () => {
    calls += 1;
    if (calls < 3) throw new Error('exec channel dropped');
    return { done: true, exitCode: 0, log: 'RESULT\nverdict: out' };
  };
  const text = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.ok(calls >= 3);
  assert.match(text, /out/);
});

test('a timeout is reported as still running, not as failure', async () => {
  let t = 0;
  const text = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: {
      read: async () => ({ done: false, exitCode: null, log: 'still going' }),
      sleep: async () => {},
      now: () => (t += 400),
    },
  });
  assert.match(text, /still running/);
  assert.match(text, /NOT been killed/);
});

test('describeResult omits links the agent did not provide', () => {
  const text = describeResult({
    url: 'https://github.com/a/b',
    jobId: 'J1',
    exitCode: 0,
    result: { verdict: 'out', project: null, service: null, pr: null, asks: null },
    log: '',
  });
  assert.match(text, /out/);
  assert.ok(!text.includes('Draft PR'), 'no PR line when there is no PR');
  assert.ok(!text.includes('undefined'));
});

test('describeTimeout never claims the job failed', () => {
  const text = describeTimeout({ url: 'u', jobId: 'J1', log: 'tail' });
  assert.ok(!/failed/i.test(text));
});

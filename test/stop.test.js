import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopRequest } from '../src/command.js';
import { stopJob } from '../src/agent.js';
import { handleMention, describeResult } from '../src/handler.js';

const config = { allowedChannels: ['C_OK'], slackBotToken: 'xoxb-test', agentService: 'claude-code' };
const ev = (text, extra = {}) => ({ channel: 'C_OK', text, ts: '2', ...extra });

test('recognises the ways a person asks for a stop', () => {
  for (const t of ['<@U1> stop', '<@U1> Stop', '<@U1> cancel', '<@U1> abort it', '<@U1> halt']) {
    assert.equal(isStopRequest(t), true, t);
  }
  for (const t of ['<@U1> https://github.com/a/b', '<@U1> #147 change the model', '<@U1> do not stop']) {
    assert.equal(isStopRequest(t), false, t);
  }
});

test('"stop #147" is a stop, never work on 147', async () => {
  let stopped = null;
  const out = await handleMention({
    event: ev('<@U1> stop #147'),
    config,
    deps: {
      running: async () => [{ jobId: 'J1', url: 'PR #147', threadTs: '1' }],
      stop: async (_c, id) => {
        stopped = id;
        return 'stopped';
      },
      start: async () => assert.fail('a stop must never start work'),
    },
  });
  assert.equal(stopped, 'J1');
  assert.match(out.reply, /Stopped it/);
});

test('in a thread it stops that thread job, not everything', async () => {
  const stopped = [];
  await handleMention({
    event: ev('<@U1> stop', { thread_ts: 'T2' }),
    config,
    deps: {
      running: async () => [
        { jobId: 'J1', url: 'PR #147', threadTs: 'T1' },
        { jobId: 'J2', url: 'PR #148', threadTs: 'T2' },
      ],
      stop: async (_c, id) => {
        stopped.push(id);
        return 'stopped';
      },
    },
  });
  assert.deepEqual(stopped, ['J2'], 'only the job belonging to this thread');
});

test('with nothing running it says so instead of pretending', async () => {
  const out = await handleMention({
    event: ev('<@U1> stop'),
    config,
    deps: { running: async () => [], stop: async () => assert.fail('nothing to stop') },
  });
  assert.match(out.reply, /Nothing is running/);
});

test('the reply is honest about what a stop does not undo', async () => {
  const out = await handleMention({
    event: ev('<@U1> stop'),
    config,
    deps: {
      running: async () => [{ jobId: 'J1', url: 'PR #147', threadTs: 'T1' }],
      stop: async () => 'stopped',
    },
  });
  assert.match(out.reply, /already pushed stays pushed/);
  assert.match(out.reply, /nothing is reverted/i);
});

test('stopJob kills the group and leaves a finished marker', async () => {
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: 'stopped' };
  };
  const out = await stopJob(config, 'J1', { run });
  assert.equal(out, 'stopped');
  assert.match(script, /kill -TERM -"\$\(cat \S+pid\)"/, 'kills the whole process group');
  assert.match(script, /pkill -TERM -f/, 'falls back for jobs started before pids were recorded');
  assert.match(script, /echo 143 > \S+exit\.code/, 'leaves a terminal marker so nobody waits forever');
  assert.match(script, /already finished/, 'a finished job is not killed');
});

test('a stopped job reads as stopped, not as a mysterious failure', () => {
  const text = describeResult({
    url: 'https://github.com/a/b',
    jobId: 'J1',
    exitCode: 143,
    result: null,
    log: '',
  });
  assert.match(text, /was stopped/);
  assert.ok(!/did not print a RESULT block/.test(text), 'a stop is not a missing-result bug');
});

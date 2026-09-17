import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMention } from '../src/handler.js';

const config = { allowedChannels: ['C_OK'], slackBotToken: 'xoxb-test' };
const ev = (text, extra = {}) => ({ channel: 'C_OK', text, ts: '2', ...extra });

test('a second mention of the same PR is refused, not raced', async () => {
  // Both agents would push to the same branch and rewrite the same body, so the
  // slower one silently overwrites the better one.
  const out = await handleMention({
    event: ev('<@U1> #147 also fix the README'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'PR #147', channel: 'C_OK', threadTs: '1' }],
      start: async () => assert.fail('must not start a second agent on the same PR'),
    },
  });
  assert.match(out.reply, /Already working on PR #147/);
  assert.match(out.reply, /J-old/, 'names the job that is already on it');
  assert.equal(out.job, null);
});

test('a different PR is not blocked by an unrelated running job', async () => {
  let started = null;
  await handleMention({
    event: ev('<@U1> #900 do it'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'PR #147' }],
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J-new' };
      },
    },
  });
  assert.equal(started.pr, 900);
});

test('a second mention of the same repo is refused too', async () => {
  const out = await handleMention({
    event: ev('<@U1> https://github.com/openai/whisper'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'https://github.com/openai/whisper' }],
      start: async () => assert.fail('must not start twice on one repo'),
    },
  });
  assert.match(out.reply, /Already templating/);
  assert.equal(out.job, null);
});

test('a different repo goes through', async () => {
  let started = null;
  await handleMention({
    event: ev('<@U1> https://github.com/a/b'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'https://github.com/openai/whisper' }],
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J-new' };
      },
    },
  });
  assert.equal(started.url, 'https://github.com/a/b');
});

test('the thread path is guarded as well', async () => {
  const out = await handleMention({
    event: ev('<@U1> also do the thing', { thread_ts: '1' }),
    config,
    deps: {
      thread: async () => ({
        messages: [{ text: 'Draft PR: https://github.com/InsForge/instacloud-oss/pull/147', bot_id: 'B1' }],
        error: null,
      }),
      running: async () => [{ jobId: 'J-old', url: 'PR #147' }],
      start: async () => assert.fail('must not start a second agent from the thread path either'),
    },
  });
  assert.match(out.reply, /Already working on PR #147/);
});

test('an unreachable box does not block new work', async () => {
  // Refusing every request because the check failed would be worse than the
  // collision it prevents: the collision is rare, the outage is total.
  let started = null;
  await handleMention({
    event: ev('<@U1> https://github.com/a/b'),
    config,
    deps: {
      running: async () => {
        throw new Error('exec channel down');
      },
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J-new' };
      },
    },
  });
  assert.equal(started.url, 'https://github.com/a/b');
});

test('a finished job does not block a follow-up', async () => {
  // listRunningJobs only returns jobs without an exit code, so a completed one
  // is simply absent. This asserts the handler trusts that rather than
  // re-deriving it.
  let started = null;
  await handleMention({
    event: ev('<@U1> #147 one more change'),
    config,
    deps: {
      running: async () => [],
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J-new' };
      },
    },
  });
  assert.equal(started.pr, 147);
});

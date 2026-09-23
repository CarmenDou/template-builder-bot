import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMention } from '../src/handler.js';

const config = { allowedChannels: ['C_OK'], slackBotToken: 'xoxb-test' };
const ev = (text, extra = {}) => ({ channel: 'C_OK', text, ts: '2', ...extra });

test('a second mention of the same PR goes to the agent already on it', async () => {
  // Both agents would push to the same branch and rewrite the same body, so the
  // slower one silently overwrites the better one. The guard is that no second
  // agent starts, not that the person is ignored.
  let steered = null;
  const out = await handleMention({
    event: ev('<@U1> #147 also fix the README'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'PR #147', channel: 'C_OK', threadTs: '1' }],
      start: async () => assert.fail('must not start a second agent on the same PR'),
      steer: async (_c, jobId, said) => {
        steered = { jobId, said };
        return 'steered';
      },
    },
  });
  assert.equal(steered.jobId, 'J-old', 'the running job is the one that hears it');
  assert.match(steered.said, /fix the README/, 'what they actually said is what it gets');
  assert.match(out.reply, /J-old/, 'names the job that picked it up');
  assert.equal(out.job, null, 'no new job to follow');
});

test('a steer that fails says so rather than pretending it landed', async () => {
  const out = await handleMention({
    event: ev('<@U1> #147 change the image'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'PR #147' }],
      start: async () => assert.fail('still must not start a second agent'),
      steer: async () => 'already finished',
    },
  });
  assert.match(out.reply, /could not pass that/);
  assert.match(out.reply, /already finished/, 'the reason is carried through');
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

test('a second mention of the same repo reaches the running agent too', async () => {
  let steered = null;
  const out = await handleMention({
    event: ev('<@U1> https://github.com/openai/whisper use the tiny model'),
    config,
    deps: {
      running: async () => [{ jobId: 'J-old', url: 'https://github.com/openai/whisper' }],
      start: async () => assert.fail('must not start twice on one repo'),
      steer: async (_c, jobId, said) => {
        steered = { jobId, said };
        return 'steered';
      },
    },
  });
  assert.equal(steered.jobId, 'J-old');
  assert.match(steered.said, /tiny model/);
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
  let steered = null;
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
      steer: async (_c, jobId, said) => {
        steered = { jobId, said };
        return 'steered';
      },
    },
  });
  assert.equal(steered.jobId, 'J-old', 'a bare thread reply reaches the running agent');
  assert.match(steered.said, /also do the thing/, 'the mention is stripped, the words are not');
  assert.equal(out.job, null);
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

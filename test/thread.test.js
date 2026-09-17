import test from 'node:test';
import assert from 'node:assert/strict';
import { findPrInThread, renderThread } from '../src/command.js';
import { fetchThread } from '../src/slack.js';
import { handleMention } from '../src/handler.js';

const config = {
  allowedChannels: ['C_OK'],
  slackBotToken: 'xoxb-test',
  jobTimeoutMs: 1000,
  pollIntervalMs: 5,
};

const msg = (text, extra = {}) => ({ text, ...extra });

test('finds the PR from the bot own earlier reply', () => {
  // This is the whole point: the human says "use the small model" with no number,
  // and the number is sitting in what the bot said earlier in the same thread.
  const messages = [
    msg('<@U1> https://github.com/elie222/rakazo'),
    msg('On it: job 20260917-abc', { bot_id: 'B1' }),
    msg('Done. Draft PR: https://github.com/InsForge/instacloud-oss/pull/147', { bot_id: 'B1' }),
    msg('use the small model'),
  ];
  assert.equal(findPrInThread(messages), 147);
});

test('a thread that moved on to a second PR is about the second one', () => {
  const messages = [
    msg('Draft PR: https://github.com/InsForge/instacloud-oss/pull/140', { bot_id: 'B1' }),
    msg('Draft PR: https://github.com/InsForge/instacloud-oss/pull/147', { bot_id: 'B1' }),
  ];
  assert.equal(findPrInThread(messages), 147);
});

test('slack-wrapped links in the thread still parse', () => {
  const messages = [msg('<https://github.com/InsForge/instacloud-oss/pull/99>', { bot_id: 'B1' })];
  assert.equal(findPrInThread(messages), 99);
});

test('no PR anywhere in the thread yields null', () => {
  assert.equal(findPrInThread([msg('hello'), msg('hi back')]), null);
  assert.equal(findPrInThread([]), null);
  assert.equal(findPrInThread(undefined), null);
});

test('renderThread labels who said what and drops mentions', () => {
  const out = renderThread([
    msg('<@U1> do the thing'),
    msg('On it', { bot_id: 'B1' }),
  ]);
  assert.match(out, /^human: do the thing$/m);
  assert.match(out, /^bot: On it$/m);
  assert.ok(!out.includes('<@U1>'));
});

test('renderThread keeps the END of a long thread, not the start', () => {
  const messages = Array.from({ length: 200 }, (_, i) => msg(`line ${i}`));
  const out = renderThread(messages, { max: 200 });
  assert.ok(out.length <= 200);
  assert.match(out, /line 199/, 'the most recent turn is the one that matters');
});

test('a bare reply in a thread becomes a follow-up on that thread PR', async () => {
  let started = null;
  const out = await handleMention({
    event: { channel: 'C_OK', text: '<@U1> as discussed above, use the small model', ts: '2', thread_ts: '1' },
    config,
    deps: {
      thread: async () => ({
        messages: [
          msg('Draft PR: https://github.com/InsForge/instacloud-oss/pull/147', { bot_id: 'B1' }),
          msg('as discussed above, use the small model'),
        ],
        error: null,
      }),
      start: async (_c, req) => {
        started = req;
        return { jobId: 'JT1' };
      },
    },
  });
  assert.equal(started.pr, 147);
  assert.match(started.extra, /use the small model/);
  assert.match(started.extra, /The thread this came from/, 'the agent gets the context, not just the last line');
  assert.match(out.reply, /Picking PR #147 back up/);
});

test('a thread with no PR still just explains itself', async () => {
  const out = await handleMention({
    event: { channel: 'C_OK', text: '<@U1> what can you do', ts: '2', thread_ts: '1' },
    config,
    deps: {
      thread: async () => ({ messages: [msg('hello')], error: null }),
      start: async () => assert.fail('must not start work'),
    },
  });
  assert.match(out.reply, /GitHub repository URL/);
  assert.equal(out.job, null);
});

test('a missing channels:history scope degrades to the help text, not a crash', async () => {
  const out = await handleMention({
    event: { channel: 'C_OK', text: '<@U1> change it', ts: '2', thread_ts: '1' },
    config,
    deps: {
      thread: async () => ({ messages: [], error: 'missing_scope' }),
      start: async () => assert.fail('must not start work'),
    },
  });
  assert.match(out.reply, /GitHub repository URL/);
});

test('an explicit PR number wins over whatever the thread says', async () => {
  let started = null;
  await handleMention({
    event: { channel: 'C_OK', text: '<@U1> #900 do it', ts: '2', thread_ts: '1' },
    config,
    deps: {
      thread: async () => assert.fail('must not need the thread when the message is explicit'),
      start: async (_c, req) => {
        started = req;
        return { jobId: 'JT2' };
      },
    },
  });
  assert.equal(started.pr, 900);
});

test('fetchThread turns a Slack refusal into an empty result with the reason', async () => {
  const out = await fetchThread({
    token: 't',
    channel: 'C1',
    threadTs: '1',
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'missing_scope' }) }),
  });
  assert.deepEqual(out.messages, []);
  assert.equal(out.error, 'missing_scope');
});

test('fetchThread survives a network failure', async () => {
  const out = await fetchThread({
    token: 't',
    channel: 'C1',
    threadTs: '1',
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.deepEqual(out.messages, []);
  assert.match(out.error, /socket hang up/);
});

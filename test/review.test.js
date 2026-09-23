import test from 'node:test';
import assert from 'node:assert/strict';
import { askForReview } from '../src/review.js';

const config = {
  slackBotToken: 'xoxb-test',
  slackReviewChannel: 'C_REVIEW',
  slackReviewBotIds: ['U_CODEX'],
  slackApproveBotIds: ['U_CLAUDE'],
};

const PR = 'https://github.com/InsForge/instacloud-oss/pull/173';

function capture() {
  const sent = [];
  return { sent, post: async (m) => (sent.push(m), { ok: true, ts: '1' }) };
}

test('review mentions the review bot, in the one line those bots read', async () => {
  const { sent, post } = capture();
  await askForReview(config, { prUrl: PR, stage: 'review' }, { post });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'C_REVIEW');
  assert.equal(sent[0].text, `<@U_CODEX> review this ${PR}`);
  assert.equal(sent[0].threadTs, undefined, 'the review channel is not a thread');
});

test('approve asks the other bot, with the other verb', async () => {
  const { sent, post } = capture();
  await askForReview(config, { prUrl: PR, stage: 'approve' }, { post });
  assert.equal(sent[0].text, `<@U_CLAUDE> approve this ${PR}`);
});

test('several reviewers are all mentioned in the one message', async () => {
  const { sent, post } = capture();
  await askForReview(
    { ...config, slackReviewBotIds: ['U_A', 'W_B'] },
    { prUrl: PR, stage: 'review' },
    { post },
  );
  assert.equal(sent[0].text, `<@U_A> <@W_B> review this ${PR}`);
});

test('an id that cannot mention anyone is refused rather than sent', async () => {
  const { sent, post } = capture();
  const out = await askForReview(
    { ...config, slackReviewBotIds: ['B_BOT'] },
    { prUrl: PR, stage: 'review' },
    { post },
  );
  assert.match(out, /not a member id/);
  assert.equal(sent.length, 0, 'a message nobody is woken by is worse than none');
});

test('a repository url is not a pull request url', async () => {
  const { sent, post } = capture();
  const out = await askForReview(
    config,
    { prUrl: 'https://github.com/InsForge/instacloud-oss', stage: 'review' },
    { post },
  );
  assert.match(out, /not a pull request/);
  assert.equal(sent.length, 0);
});

test('unconfigured, it says so instead of guessing where to post', async () => {
  const { sent, post } = capture();
  const out = await askForReview(
    { ...config, slackReviewChannel: undefined },
    { prUrl: PR, stage: 'review' },
    { post },
  );
  assert.match(out, /no review channel/i);
  assert.equal(sent.length, 0);
});

test('an unknown stage names the order it should have been asked in', async () => {
  const { sent, post } = capture();
  const out = await askForReview(config, { prUrl: PR, stage: 'merge' }, { post });
  assert.match(out, /review first/i);
  assert.equal(sent.length, 0);
});

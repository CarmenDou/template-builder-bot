import test from 'node:test';
import assert from 'node:assert/strict';
import { askForReview, activitySince, readPrScript, reviewStatus } from '../src/review.js';

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

test('an unknown stage names the two there are', async () => {
  const { sent, post } = capture();
  const out = await askForReview(config, { prUrl: PR, stage: 'merge' }, { post });
  assert.match(out, /review, or approve/i);
  assert.equal(sent.length, 0);
});

test('an ask says when it was sent, so its answer can be waited for', async () => {
  const { post } = capture();
  const out = await askForReview(config, { prUrl: PR, stage: 'review' }, { post, now: () => Date.parse('2026-09-23T07:30:00Z') });
  assert.match(out, /asked at: 2026-09-23T07:30:00\.000Z/);
});

test('approve is sent whatever the review said: the decision is the person\'s', async () => {
  const { sent, post } = capture();
  const out = await askForReview(config, { prUrl: PR, stage: 'approve' }, { post });
  assert.match(out, /^Asked/, 'nothing checks the review before an approve');
  assert.equal(sent.length, 1);
});

// Shaped like the REST API as readPrScript gathers it, from PR #146 on 09-23: an
// automatic reviewer that is a bot, then Codex twice under its ordinary account.
const pr = {
  head: 'NEW',
  reviews: [
    { author: 'cubic-dev-ai[bot]', type: 'Bot', at: '2026-09-23T18:03:55Z', state: 'COMMENTED', commit: 'OLD', body: '**3 issues found**' },
    { author: 'jwfing', type: 'User', at: '2026-09-23T18:04:15Z', state: 'CHANGES_REQUESTED', commit: 'OLD', body: '**Summary**\n\n**Critical**\n\n- ttyd prints the password' },
    { author: 'jwfing', type: 'User', at: '2026-09-23T18:33:57Z', state: 'COMMENTED', commit: 'NEW', body: '## Summary\n\n## Verdict\n\n**Approved** — zero Critical findings.' },
  ],
  comments: [
    { author: 'someone', type: 'User', at: '2026-09-23T18:40:00Z', body: 'looks good to me' },
    { author: 'github-actions[bot]', type: 'Bot', at: '2026-09-23T18:41:00Z', body: 'build passed' },
  ],
};

test('only what people said after the ask comes back, reviews and comments together, oldest first', () => {
  const a = activitySince(pr, Date.parse('2026-09-23T18:28:19Z'));
  assert.deepEqual(a.map((x) => [x.kind, x.author]), [['review', 'jwfing'], ['comment', 'someone']]);
  assert.equal(a[0].onHead, true, 'and whether a review read the current head');
  assert.match(a[0].body, /Approved\*\* — zero Critical/, 'in full, whatever its headings look like');
});

test('bots are left out, however early they answer', () => {
  const everyone = activitySince(pr);
  assert.ok(!everyone.some((x) => /\[bot\]/.test(x.author)), 'cubic and github-actions are not reviewers here');
  assert.equal(everyone.filter((x) => x.author === 'jwfing').length, 2, 'the account Codex and Claude post as is a person to GitHub');
});

test('a review of an older commit says so', () => {
  const a = activitySince(pr);
  assert.equal(a.find((x) => x.state === 'CHANGES_REQUESTED').onHead, false);
});

test('a very long review is cut, so it does not crowd out the conversation', () => {
  const long = { head: 'H', reviews: [{ author: 'jwfing', type: 'User', at: '2026-09-23T00:00:00Z', state: 'COMMENTED', commit: 'H', body: 'x'.repeat(10000) }], comments: [] };
  assert.ok(activitySince(long)[0].body.length <= 3001);
});

test('reviewStatus waits for something a person said after the ask, then stops', async () => {
  const pages = [
    { head: 'H', reviews: [pr.reviews[0]], comments: [] },
    { head: 'H', reviews: [pr.reviews[0], { ...pr.reviews[2], commit: 'H' }], comments: [] },
  ];
  let reads = 0;
  const run = async () => ({ stdout: JSON.stringify(pages[Math.min(reads++, 1)]) });
  const r = await reviewStatus({}, { prUrl: 'https://github.com/InsForge/instacloud-oss/pull/146', after: '2026-09-23T18:00:00Z' }, { run, sleep: async () => {}, now: () => 0 });
  assert.equal(reads, 2, "the bot's earlier review is not taken as the answer");
  assert.equal(r.waiting, false);
  assert.equal(r.activity[0].author, 'jwfing');
});

test('reviewStatus gives up waiting at the deadline and says so', async () => {
  let t = 0;
  const run = async () => ({ stdout: JSON.stringify({ head: 'H', reviews: [], comments: [] }) });
  const r = await reviewStatus({}, { prUrl: 'https://github.com/a/b/pull/1', after: '2026-09-23T07:30:00Z', waitMs: 60000 }, {
    run, sleep: async () => {}, now: () => (t += 30000),
  });
  assert.equal(r.waiting, true);
});

test('the reader asks the REST API, which is what says who is a bot', () => {
  const script = readPrScript('https://github.com/InsForge/instacloud-oss/pull/146');
  assert.match(script, /api 'repos\/InsForge\/instacloud-oss\/pulls\/146\/reviews\?per_page=100'/);
  assert.match(script, /api 'repos\/InsForge\/instacloud-oss\/issues\/146\/comments\?per_page=100'/);
  assert.match(script, /type: \.user\.type/);
});

test('nothing but an owner, a repo and a number can reach the command', () => {
  for (const bad of ['https://github.com/a;rm -rf x/b/pull/1', 'https://github.com/a/b/pull/1; ls', 'https://github.com/a b/c/pull/1']) {
    assert.throws(() => readPrScript(bad), /not a pull request url/, bad);
  }
});

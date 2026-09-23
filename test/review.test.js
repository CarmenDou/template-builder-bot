import test from 'node:test';
import assert from 'node:assert/strict';
import { askForReview, summarizeReviews, reviewStatus } from '../src/review.js';

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

// Shaped like real Codex reviews: one clean (insta-platform #508), one with a Critical (#503).
const CLEAN = `**Summary**

The narrower row lock removes the reported deadlock.

**Findings**

### Critical

(none)

### Suggestion

- \`test/a.test.ts:66\` — consider a concurrent case.

### Information

- No security-relevant changes.

**Verdict**

Approved: no Critical findings; the suggestion is non-blocking.`;

const BLOCKED = `**Summary**

The implementation is right but a guard is missing.

**Findings**

### Critical

- **Missing clean-room regression guard.** Add the insta-e2e check.

### Suggestion

### Information

- Performance is fine.

**Verdict**

Changes requested: one Critical finding.`;

const review = (state, body, oid, at = '2026-09-21T17:38:51Z') => ({ state, body, commit: { oid }, submittedAt: at });

test('a Codex review with no Critical findings on the head is clean', () => {
  const s = summarizeReviews({ headRefOid: 'H', reviews: [review('COMMENTED', CLEAN, 'H')] });
  assert.equal(s.reviewed, true);
  assert.equal(s.critical, 0);
  assert.equal(s.suggestions, 1);
  assert.equal(s.onHead, true);
  assert.equal(s.clean, true);
  assert.match(s.verdict, /^Approved: no Critical findings/);
});

test('a Critical finding is not clean, and an empty Suggestion section counts as none', () => {
  const s = summarizeReviews({ headRefOid: 'H', reviews: [review('CHANGES_REQUESTED', BLOCKED, 'H')] });
  assert.equal(s.critical, 1);
  assert.equal(s.suggestions, 0);
  assert.equal(s.clean, false);
});

test('Critical 0 is clean even while the state still says changes requested', () => {
  // Once a PR has had changes requested, GitHub keeps that state until an
  // approval, even after a later review finds nothing Critical. Going by the
  // state would hold a fixed PR back forever.
  const s = summarizeReviews({
    headRefOid: 'H2',
    reviews: [review('CHANGES_REQUESTED', BLOCKED, 'H1'), review('CHANGES_REQUESTED', CLEAN, 'H2', '2026-09-22T00:00:00Z')],
  });
  assert.equal(s.state, 'CHANGES_REQUESTED');
  assert.equal(s.critical, 0);
  assert.equal(s.clean, true);
});

test('a clean review of an older commit is not clean: newer code was never read', () => {
  const s = summarizeReviews({ headRefOid: 'NEW', reviews: [review('COMMENTED', CLEAN, 'OLD')] });
  assert.equal(s.onHead, false);
  assert.equal(s.clean, false);
});

test('an approval counts only on the current head, and is not mistaken for a review', () => {
  const s = summarizeReviews({
    headRefOid: 'H',
    reviews: [review('COMMENTED', CLEAN, 'H'), review('APPROVED', 'LGTM - approved.', 'H')],
  });
  assert.equal(s.approved, true);
  assert.match(s.verdict, /^Approved: no Critical/, 'the latest Codex review, not the approval');
  const stale = summarizeReviews({ headRefOid: 'H2', reviews: [review('APPROVED', 'LGTM - approved.', 'H')] });
  assert.equal(stale.approved, false);
  assert.equal(stale.reviewed, false);
});

test('reviewStatus waits for a review newer than the ask, then stops', async () => {
  const pages = [
    { headRefOid: 'H', reviews: [review('COMMENTED', CLEAN, 'H', '2026-09-20T00:00:00Z')] },
    { headRefOid: 'H', reviews: [review('COMMENTED', CLEAN, 'H', '2026-09-23T08:00:00Z')] },
  ];
  let reads = 0;
  let script = '';
  const run = async (_c, s) => ((script = s), { stdout: JSON.stringify(pages[Math.min(reads++, 1)]) });
  const r = await reviewStatus(
    {},
    { prUrl: 'https://github.com/InsForge/instacloud-oss/pull/149', after: '2026-09-23T07:30:00Z' },
    { run, sleep: async () => {}, now: () => 0 },
  );
  assert.equal(reads, 2, 'the older review is not taken as the answer');
  assert.equal(r.waiting, false);
  assert.equal(r.at, '2026-09-23T08:00:00Z');
  assert.match(script, /^\/data\/home\/bin\/gh pr view https:\/\/github\.com\/InsForge\/instacloud-oss\/pull\/149 --json /);
});

test('reviewStatus gives up waiting at the deadline and says so', async () => {
  let t = 0;
  const run = async () => ({ stdout: JSON.stringify({ headRefOid: 'H', reviews: [] }) });
  const r = await reviewStatus({}, { prUrl: 'https://github.com/a/b/pull/1', after: '2026-09-23T07:30:00Z', waitMs: 60000 }, {
    run, sleep: async () => {}, now: () => (t += 30000),
  });
  assert.equal(r.waiting, true);
});

test('reviewStatus refuses anything that is not a PR url before touching the box', async () => {
  await assert.rejects(
    () => reviewStatus({}, { prUrl: 'https://github.com/a/b/pull/1; rm -rf /' }, { run: async () => assert.fail('must not run') }),
    /not a pull request url/,
  );
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

test('the bold heading style is read too, as the reviewer sometimes writes it', () => {
  // insta-platform #503's second review: `**Critical**` on its own line, not `### Critical`.
  const BOLD = `**Summary**

This focused change moves the rejection ahead of execution.

**Findings**

**Critical**

(none)

**Suggestion**

(none)

**Information**

- **Security:** No authentication or secret-handling changes.
- **Performance:** No new queries.

**Verdict**

Approved — no Critical findings.`;
  const s = summarizeReviews({ headRefOid: 'H', reviews: [review('COMMENTED', BOLD, 'H')] });
  assert.equal(s.critical, 0, 'not null: the section was found');
  assert.equal(s.suggestions, 0);
  assert.equal(s.clean, true);
  assert.equal(s.verdict, 'Approved — no Critical findings.');
});

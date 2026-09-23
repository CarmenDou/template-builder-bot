import { postMessage } from './slack.js';
import { execInBox } from './agent.js';

// The two bots, in the order they are usually asked: Codex looks at the change,
// then Claude approves when the person says so. The order is advice, not a gate:
// nothing here checks the review before an approve, because the decision is the
// person's. Naming them by what they do keeps the caller out of picking a bot.
const STAGES = {
  review: { ids: (c) => c.slackReviewBotIds, action: 'review this' },
  approve: { ids: (c) => c.slackApproveBotIds, action: 'approve this' },
};

// Owner and repo as GitHub allows them, and nothing else: the URL is put into a command.
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

/**
 * Asks a review bot to look at a pull request, by posting one line in the
 * review channel. One line, because that is the whole protocol those bots read.
 *
 * Only a member id mentions anyone. A B or C id posts text that looks like a
 * mention and wakes nobody, which is worse than refusing: the PR then sits
 * waiting on a review that was never requested.
 */
export async function askForReview(config, { prUrl, stage }, deps = {}) {
  const { post = postMessage, now = () => Date.now() } = deps;

  const plan = STAGES[stage];
  if (!plan) return `${stage} is not a stage. Use review, or approve when the person says so.`;
  if (!PR_URL.test(String(prUrl ?? ''))) return `${prUrl || '(nothing)'} is not a pull request URL.`;
  if (!config.slackReviewChannel) return 'No review channel is configured, so there is nowhere to ask.';

  const ids = plan.ids(config);
  if (ids.length === 0) return `No bot is configured for ${stage}, so there is nobody to ask.`;

  const wrong = ids.find((id) => !/^[UW]/.test(id));
  if (wrong) return `${wrong} is not a member id, and only a member id mentions anyone. Not sending.`;

  const text = `${ids.map((id) => `<@${id}>`).join(' ')} ${plan.action} ${prUrl}`;
  await post({ token: config.slackBotToken, channel: config.slackReviewChannel, text });
  const at = new Date(now()).toISOString();
  return `Asked in the review channel: ${text}\nasked at: ${at}`;
}

// Where the agent box keeps its GitHub CLI, which is the one with a token.
const GH = '/data/home/bin/gh';

// How much of each review to hand back. Enough for a reviewer's summary, findings
// and verdict; a whole review of a large PR would crowd out the conversation.
const BODY_LIMIT = 3000;

/**
 * Everything people said on a PR after `since`, oldest first: reviews and plain
 * comments alike, each with who wrote it, when, and whether it read the current
 * head. Accounts GitHub marks as bots are left out: automatic reviewers such as
 * cubic comment on every push, and one of them arriving first is not the answer
 * to a review someone asked for. Codex and Claude post as an ordinary account.
 *
 * Nothing here decides what a review means. An earlier version read the
 * reviewer's verdict out of its markdown and missed a review whose headings were
 * written `## Summary` instead of `**Summary**`, so the follower waited on an
 * answer that had already come. The reader of this list is a model, and it can
 * read a review.
 */
export function activitySince(pr, since = -Infinity) {
  const head = pr?.head ?? null;
  const person = (a) => a.type !== 'Bot';
  const reviews = (pr?.reviews ?? []).filter(person).map((r) => ({
    kind: 'review',
    author: r.author,
    at: r.at,
    state: r.state,
    onHead: r.commit === head,
    body: r.body ?? '',
  }));
  const comments = (pr?.comments ?? []).filter(person).map((c) => ({
    kind: 'comment',
    author: c.author,
    at: c.at,
    state: null,
    onHead: null,
    body: c.body ?? '',
  }));
  return [...reviews, ...comments]
    .filter((a) => Date.parse(a.at) > since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((a) => ({ ...a, body: a.body.length > BODY_LIMIT ? `${a.body.slice(0, BODY_LIMIT)}…` : a.body }));
}

/**
 * The shell that gathers a PR's head, reviews and comments as one JSON object.
 * The REST API rather than `gh pr view`, because only REST says which authors
 * are bots.
 */
export function readPrScript(prUrl) {
  const m = String(prUrl ?? '').match(PR_URL);
  if (!m) throw new Error(`not a pull request url: ${prUrl}`);
  const [, owner, repo, n] = m;
  const api = `${GH} api`;
  return [
    `H=$(${api} repos/${owner}/${repo}/pulls/${n} --jq .head.sha)`,
    `R=$(${api} 'repos/${owner}/${repo}/pulls/${n}/reviews?per_page=100' --jq '[.[] | {author: .user.login, type: .user.type, at: .submitted_at, state, commit: .commit_id, body}]')`,
    `C=$(${api} 'repos/${owner}/${repo}/issues/${n}/comments?per_page=100' --jq '[.[] | {author: .user.login, type: .user.type, at: .created_at, body}]')`,
    `printf '{"head":"%s","reviews":%s,"comments":%s}' "$H" "$R" "$C"`,
  ].join('\n');
}

/**
 * Reads a PR's reviews and comments on the agent box, where gh has a token. With
 * `after`, waits up to `waitMs` for anything newer than that moment, so whoever
 * asked for a review can wait for the answer without sleeping on their side.
 * Without it, returns the last few things said.
 */
export async function reviewStatus(config, { prUrl, after, waitMs = 120000 }, deps = {}) {
  const { run = execInBox, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = deps;
  const script = readPrScript(prUrl);
  const since = after ? Date.parse(after) : NaN;
  const waiting = !Number.isNaN(since);
  const deadline = now() + (waiting ? waitMs : 0);

  for (;;) {
    const { stdout } = await run(config, script, { timeoutMs: 60000 });
    const pr = JSON.parse(stdout);
    const activity = waiting ? activitySince(pr, since) : activitySince(pr).slice(-3);
    if (!waiting || activity.length > 0) return { activity, waiting: false };
    if (now() >= deadline) return { activity: [], waiting: true };
    await sleep(20000);
  }
}

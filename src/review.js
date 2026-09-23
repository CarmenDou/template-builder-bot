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

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

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

// Both review bots post as one GitHub account, so the review bot is told apart
// by its format: every Codex review opens with this heading.
const isCodexReview = (r) => /^\*\*Summary\*\*/.test(r?.body ?? '');

/**
 * Findings under one heading: 0 for `(none)`, else the bullets, or null if absent.
 * The reviewer writes the heading two ways, `### Critical` and `**Critical**` on
 * a line of its own, sometimes in consecutive reviews of the same PR.
 */
function findings(body, name) {
  const heading = `(?:#{2,4}[ \\t]*${name}[^\\n]*|\\*\\*${name}[^*\\n]*\\*\\*[ \\t]*)\\n`;
  const next = `\\n(?:#{2,4}[ \\t]|\\*\\*[A-Z][^*\\n]*\\*\\*[ \\t]*(?:\\n|$))`;
  const m = body.match(new RegExp(`${heading}([\\s\\S]*?)(?=${next}|$)`, 'i'));
  if (!m) return null;
  const text = m[1].trim();
  if (text === '' || /^\(none\)$/i.test(text)) return 0;
  return (text.match(/^- /gm) ?? []).length;
}

/**
 * Where a PR stands with the review bots, from `gh pr view --json`.
 *
 * Clean means the latest Codex review looked at the current head and has no
 * Critical findings. The review's state is deliberately not part of it: once a
 * PR has had changes requested, GitHub keeps saying so until someone approves,
 * even after a later review finds nothing Critical. A review of an older commit
 * is reported but never clean: whatever was pushed since has not been read.
 */
export function summarizeReviews(pr) {
  const reviews = pr?.reviews ?? [];
  const head = pr?.headRefOid ?? null;
  const approved = reviews.some((r) => r.state === 'APPROVED' && r.commit?.oid === head);
  const latest = reviews.filter(isCodexReview).at(-1) ?? null;
  if (!latest) return { reviewed: false, approved, head };

  const body = latest.body;
  const verdict = body.match(/\*\*Verdict\*\*\s*\n+\s*([^\n]+)/)?.[1]?.trim() ?? null;
  const critical = findings(body, 'Critical');
  const suggestions = findings(body, 'Suggestion');
  const onHead = latest.commit?.oid === head;
  return {
    reviewed: true,
    at: latest.submittedAt,
    state: latest.state,
    verdict,
    critical,
    suggestions,
    onHead,
    approved,
    head,
    clean: onHead && critical === 0,
  };
}

/**
 * Reads a PR's reviews on the agent box. With `after`, waits up to `waitMs` for a
 * Codex review submitted after that moment, so whoever asked for a review can
 * wait for its answer without sleeping on their side.
 */
export async function reviewStatus(config, { prUrl, after, waitMs = 120000 }, deps = {}) {
  const { run = execInBox, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = deps;
  if (!PR_URL.test(String(prUrl ?? ''))) throw new Error(`not a pull request url: ${prUrl}`);
  const since = after ? Date.parse(after) : NaN;
  const deadline = now() + (Number.isNaN(since) ? 0 : waitMs);

  for (;;) {
    const { stdout } = await run(config, `${GH} pr view ${prUrl} --json reviews,headRefOid,state,isDraft`, {
      timeoutMs: 60000,
    });
    const status = summarizeReviews(JSON.parse(stdout));
    const fresh = Number.isNaN(since) || (status.reviewed && Date.parse(status.at) > since);
    if (fresh) return { ...status, waiting: false };
    if (now() >= deadline) return { ...status, waiting: true };
    await sleep(20000);
  }
}

import { postMessage } from './slack.js';

// The two bots, in the order they are meant to be asked: Codex looks at the
// change, and only once that comes back clean does Claude approve. Naming them
// by what they do rather than who they are keeps the caller out of the habit of
// picking a bot.
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
  const { post = postMessage } = deps;

  const plan = STAGES[stage];
  if (!plan) return `${stage} is not a stage. Use review first, then approve once it comes back clean.`;
  if (!PR_URL.test(String(prUrl ?? ''))) return `${prUrl || '(nothing)'} is not a pull request URL.`;
  if (!config.slackReviewChannel) return 'No review channel is configured, so there is nowhere to ask.';

  const ids = plan.ids(config);
  if (ids.length === 0) return `No bot is configured for ${stage}, so there is nobody to ask.`;

  const wrong = ids.find((id) => !/^[UW]/.test(id));
  if (wrong) return `${wrong} is not a member id, and only a member id mentions anyone. Not sending.`;

  const text = `${ids.map((id) => `<@${id}>`).join(' ')} ${plan.action} ${prUrl}`;
  await post({ token: config.slackBotToken, channel: config.slackReviewChannel, text });
  return `Asked in the review channel: ${text}`;
}

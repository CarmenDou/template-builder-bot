import { parseList } from './command.js';

const SLACK_REQUIRED = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'ALLOWED_CHANNELS'];
const CORE_REQUIRED = ['INSTA_API_KEY', 'AGENT_PROJECT_ID'];

// The stdio server has no Slack side to guard, so it opts out of SLACK_REQUIRED
// rather than that check being loosened for the caller that still needs it.
export function loadConfig(env = process.env, { needsSlack = true } = {}) {
  const required = needsSlack ? [...SLACK_REQUIRED, ...CORE_REQUIRED] : CORE_REQUIRED;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        (needsSlack
          ? 'ALLOWED_CHANNELS is the only thing standing between Slack and an agent that can push branches and deploy, so the bot refuses to start without it.'
          : 'INSTA_API_KEY and AGENT_PROJECT_ID are how this process reaches the platform at all.'),
    );
  }

  return {
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    slackBotToken: env.SLACK_BOT_TOKEN,
    allowedChannels: parseList(env.ALLOWED_CHANNELS),

    // Handing a finished draft to the review bots. A channel id and two member
    // ids, not credentials: the bot posts with its own token. Absent, the tool
    // refuses rather than guessing where to post or who to wake.
    slackReviewChannel: env.SLACK_REVIEW_CHANNEL,
    slackReviewBotIds: parseList(env.SLACK_REVIEW_BOT_IDS ?? ''),
    slackApproveBotIds: parseList(env.SLACK_CLAUDE_BOT_ID ?? ''),

    // Used only to say, in a sentence, what a running job is doing. Absent, a
    // job still reports its milestones and its result, just not the middle.
    anthropicApiKey: env.ANTHROPIC_API_KEY,

    // How the bot reaches the agent box
    instaApiKey: env.INSTA_API_KEY,
    instaBin: env.INSTA_BIN ?? 'insta',
    agentProjectId: env.AGENT_PROJECT_ID,
    agentService: env.AGENT_SERVICE ?? 'claude-code',

    // Set SSH_CONFIG and the box is driven over ssh instead of `compute exec`,
    // which caps a command at 64KB of argv and 180 seconds. Absent, as in the
    // tests and anywhere without the one-time `compute ssh --setup`, it stays
    // on exec. The choice is explicit rather than a fallback, because a silent
    // fallback would hide an expired certificate as a slow day.
    sshConfig: env.SSH_CONFIG,
    sshAlias: env.SSH_ALIAS ?? `${env.AGENT_SERVICE ?? 'claude-code'}.insta`,

    // A job past this is reported as still running rather than silently left
    // going; the agent itself is never killed. 90 minutes because a thin-shell
    // job legitimately takes an hour: CI rebuild, a 400MB image pull, deploy,
    // verify, and often a revert plus a second deploy. The first version used
    // 45 and reported a timeout four minutes before the job actually finished.
    jobTimeoutMs: Number(env.JOB_TIMEOUT_MS ?? 90 * 60 * 1000),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 20 * 1000),

    port: Number(env.PORT ?? 8080),
  };
}

import { parseList } from './command.js';

const REQUIRED = [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'ALLOWED_CHANNELS',
  'INSTA_API_KEY',
  'AGENT_PROJECT_ID',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'ALLOWED_CHANNELS is the only thing standing between Slack and an agent ' +
        'that can push branches and deploy, so the bot refuses to start without it.',
    );
  }

  return {
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    slackBotToken: env.SLACK_BOT_TOKEN,
    allowedChannels: parseList(env.ALLOWED_CHANNELS),

    // How the bot reaches the agent box
    instaApiKey: env.INSTA_API_KEY,
    instaBin: env.INSTA_BIN ?? 'insta',
    agentProjectId: env.AGENT_PROJECT_ID,
    agentService: env.AGENT_SERVICE ?? 'claude-code',

    // A job past this is reported as still running rather than silently left
    // going; the agent itself is never killed. 90 minutes because a thin-shell
    // job legitimately takes an hour: CI rebuild, a 400MB image pull, deploy,
    // verify, and often a revert plus a second deploy. The first version used
    // 45 and reported a timeout four minutes before the job actually finished.
    jobTimeoutMs: Number(env.JOB_TIMEOUT_MS ?? 90 * 60 * 1000),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 20 * 1000),

    // Unset means the /mcp endpoint does not exist. Not required, because the
    // bot works without it, but the endpoint can start an agent that pushes to
    // instacloud-oss, so it is never open.
    mcpToken: env.MCP_TOKEN ?? '',

    port: Number(env.PORT ?? 8080),
  };
}

# template-builder-bot

Mention the bot in Slack with a GitHub URL. It drives the **template-builder agent** (a Claude Code
box on InstaCloud) to triage the repo, write an `insta.template.yaml`, open a **draft PR** on
`InsForge/instacloud-oss`, deploy it once to prove it works, and report back in the thread.

```
@template-builder https://github.com/ahmetoner/whisper-asr-webservice
```

The bot never publishes and never merges. A human verifies the template and decides.

## How it fits together

```
Slack  ──app_mention──▶  bot (this repo, its own compute service)
                            │  insta compute exec … nohup claude -p …
                            ▼
                         agent box (claude-code template, separate service)
                            │  git clone / insta template deploy / gh pr create
                            ▼
                         draft PR on InsForge/instacloud-oss
                         + a deployed service kept running for the human to try
```

The bot and the agent are **separate compute services** on purpose. The bot crashing must not take
down the box you can open in a browser to see what the agent is doing, and one compute service can
only declare one port, which ttyd already owns on the agent side.

## Why it polls instead of waiting

`insta compute exec` is a one-shot channel and it drops on long commands; a template job runs 10 to
30 minutes. So the bot never holds the channel open:

1. it starts the agent with `nohup`, writing to `/data/work/jobs/<id>/out.log`
2. the wrapper writes `/data/work/jobs/<id>/exit.code` **only after** the agent exits
3. the bot polls for that file, and a dropped channel in between is ignored rather than fatal

A job that outlives `JOB_TIMEOUT_MS` is reported as *still running*, not as failed, and is **not**
killed.

## Why the agent reports its own progress

The same poll reads `stage.txt`, which the agent appends one line to at four moments: triage
verdict, PR opened, build result, verification. Each new line is posted to the thread once.

The agent reports these rather than the bot inferring them from GitHub, because only the agent knows
which step it is actually in: a PR can exist while the agent is still deploying, and a green build
says nothing about whether the app was ever exercised. Inferring would produce confident updates
that are wrong.

A failed post never ends the watch. The final report matters more than any one progress line.

## Safety boundaries

- **Channel allowlist.** `ALLOWED_CHANNELS` is the only thing between Slack and an agent that can
  push branches and deploy infrastructure. The bot refuses to start without it, and stays silent in
  any other channel rather than announcing itself.
- **Tool allowlist, not a permission bypass.** The agent runs with an explicit `--allowedTools` list
  (insta, gh, git, curl, file reads and writes). It is never given
  `--dangerously-skip-permissions`, because that box holds a GitHub token that can push to
  `instacloud-oss` and a platform key with full access to its org.
- **Event de-duplication.** Slack retries any delivery it thinks was slow. Without de-duplication a
  retry starts a second agent on the same repo and you get two PRs.
- **The task text never touches a shell.** It is base64-encoded on the way to the box, so a repo
  name or a human's extra instructions can never become a command.
- **One repo per message.** Two URLs in one mention is refused rather than guessed at.

## Configuration

See `.env.example`. Required: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `ALLOWED_CHANNELS`,
`INSTA_API_KEY`, `AGENT_PROJECT_ID`.

## Development

```bash
npm test      # node --test, no dependencies
npm start     # needs the env above
```

The bot has no runtime dependencies: `node:http` and `node:crypto` only.

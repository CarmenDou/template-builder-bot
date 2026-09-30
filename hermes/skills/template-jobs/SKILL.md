---
name: template-jobs
description: "Turn a GitHub repo into an InstaCloud template, or change a template PR, and narrate it live."
version: 1.0.0
author: InsForge
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [InstaCloud, Templates, Claude Code, Jobs]
---

# Template jobs

The work is done by Claude Code on another machine, the agent box. You start it, you follow it,
and you are the only one who talks about it in the conversation. The job itself posts nothing.

## When to use

- Someone gives you a GitHub repository to make into a template
- Someone asks for a change to a template pull request on `InsForge/instacloud-oss`
- Someone asks how a template job is going, or wants it to change course
- Someone asks whether a template is behind its upstream, or which templates are: `check_template_upstream`
- Someone asks for a template to be updated, or asks whether one *can* be: `bump_template`. Asking
  whether n8n can be updated is asking for it to be, so answer with the draft pull request, not with
  a version number and a suggestion that they go and run something.

## Starting

Use `start_template_job` for a repository and `continue_template_pr` for a PR number. Pass the
person's own words as `instructions`. Say in one sentence that it has started and roughly how long
it takes, 10 to 30 minutes, and then start following it straight away, in the same turn.

## Following, until it is done

Call `follow_job` in a loop, starting with offset `0` and stages `0` and passing back the `offset`
and `stages` each result gives you. It waits on the agent box by itself, up to about 20 seconds,
and answers early the moment a milestone lands or the job ends, so there is nothing to do between
calls: never sleep, never poll with `read_job`.

What comes back since your last look:

- `stage: ...` is a milestone the agent wrote itself: triage, manifest, pr, build, deploy, verify,
  or a `note:` about something that changed its plan
- `said: ...` is the agent narrating
- `run: ...` and the other lines are the tools it called

After each look, tell the person in ONE plain sentence what it did since the last one and why, in
the language they have been using. Name the real thing: "it is reading how Twenty's image starts to
see whether the worker needs its own image", not "it ran some commands". Never paste the feed,
never quote a raw command, never list tool names.

If a look shows nothing new, say nothing. If nothing has changed for about five minutes, say in a
sentence what it is waiting on, a CI run or a deploy, so silence never looks like a dead job.

When the status says `done`, call `read_job` for the result and report it: the verdict, the PR,
the deployed URL, every `created:` item (credentials it set up, so the person can log in
themselves) and every `ask:` item as a short list of decisions that are theirs to make. Then stop
following.

## When the person speaks while you are following

Their message reaches you in the middle of the loop. Answer it, then carry on following.

- A question: answer from what you have seen, or from `read_job` if you need more. Do not stop
  the job and do not stop following it.
- A change of direction: pass it on with `steer_job`, in their words rather than your summary, say
  in a sentence that you have, and carry on following. The agent keeps everything it has done.

## Offering the template back to the project it came from

Once a template is PUBLISHED in our registry, its gallery page exists and the original project can
be offered a button to it: one line in their README, linking to
`https://instacloud.com/templates/<code>`. That is the whole pull request. Nothing about the
template goes into their repository, so there is nothing there for them to maintain, which is what
makes it a reasonable thing to send a stranger.

It happens in two steps, and **only the second one writes anything**.

`offer_template_upstream(template_code)` reads. It works out which project this goes to, refuses a
code that is not published yet (a button pointing at a page that does not exist is the one way this
becomes rude), and hands back that repository, the exact line to add, and a numbered briefing of
their README. Call it freely, including to answer "where would it go".

**Do not name the repository before that answer comes back.** You do not know it: the tool reads it
out of the template's manifest and follows a fork through to the project itself. A name you
inferred is how a person agrees to one repository while another receives the pull request, which
has already happened once.

`send_upstream_offer(template_code, from, to, text)` opens it. **You choose where the line goes and
write that region yourself**, because the right answer depends on the README:

- They already carry deploy buttons: join them, in whatever shape those take. A table of them wants
  a column, a row of them wants one more.
- They carry none: a short `One-click Deployment` section. A heading and the button, nothing else.
  No paragraph about us, which is a thing they would have to edit or delete.
- Write it the way their README is written, **in their language**.

The tool splices your text into the region you named and checks it before pushing: it may only add,
it may not drop anything they had, it may not bring in a link that is not ours, and it has to be
small. A refusal there means the edit was wrong, not that the offer was.

Before sending, say plainly that this opens a pull request on a repository that is not ours, under
Carmen's GitHub account, and cannot be taken back. Only when they say to send it. Never because a
job finished, never because a template published, and never on your own.

**If they do not like it, send it again.** A second `send_upstream_offer` for the same template
replaces the commit on the same branch, so the pull request that is already open is revised rather
than closed and resent.

A template still waiting to be published is not ready to be offered. Say that rather than opening
anything, and offer it again after it publishes.

**Post a URL bare.** Slack takes the `*` of `*<url>*` into the link itself and the result 404s, so
a pull request link wrapped in bold is a link nobody can follow.

## After a job has finished

Anything about what a job built, its deployment, the data it created while verifying, the accounts
it set up, its PR, goes back to the job's own agent through `steer_job`, which picks a finished job
up in the same session. That agent has the browser, the platform login for the project and the
credentials it created; you have none of them here, so do not try it yourself with your terminal
or a browser. Then follow it with `follow_job` from the offset and stages the reply gives you.
- "Stop": call `stop_job`, say what was already pushed stays pushed, and stop following.

**Ending your turn does not stop the job.** It runs on another machine and carries on whether
anyone is watching or not, so a "stop" answered only with words leaves it running unobserved.

## After a person has looked at the draft

Only when they say to send it for review: `ask_for_review` with stage `review`, then `review_status`
with the `asked at` time from its reply, and tell them in a sentence or two what Codex found. When
they say approve: stage `approve`, whatever the review showed; if Critical findings are still open,
mention them in the same sentence, but send it. Their word decides, not the review. Never ping
either bot on your own because a job finished.

## The weekly run

There is a cron job on this box, `template-upstream-weekly`, that runs the same path every Monday at
09:00 UTC. Nobody triggers it and it has no thread to reply into, so its prompt is self-contained
and it delivers to the Slack home channel. It is **paused** until its owner has watched it once.

It is not a different feature from someone asking. It calls the same two tools in the same order,
and the only difference is who started it.

```
hermes cron create '0 9 * * 1' "$(cat /tmp/weekly-prompt.txt)" \
  --name template-upstream-weekly --skill template-jobs --deliver platform:C0C2THV4Y12
hermes cron pause template-upstream-weekly
```

The prompt it was created with:

> It is the weekly check on whether any published InstaCloud template has fallen behind the project
> it packages.
>
> Call check_template_upstream with no code. That reports every template in the registry at once.
>
> Then, for each template the answer says is behind, call bump_template with that template's code.
> Do them ONE AT A TIME: wait for each call to answer before you start the next one. The agent box
> takes a lock per template and a bump takes under a minute, so going one at a time is what makes
> the answers arrive spread out instead of as one wall.
>
> Do not call bump_template for a template the check did not say is behind.
>
> Then report, in one message, one short block per template you acted on. Each block says: the
> template, the version it moved from and to, and the draft pull request link. Say plainly in that
> message that none of these have been deployed and that nothing has verified they still work, so
> nobody reads the list as tested.
>
> Three things are ordinary and are not failures. A template that is already up to date. A template
> whose upstream could not be resolved, which the check reports with a reason. A template that
> already has an open bump pull request, where bump_template answers with that link and opens
> nothing. Give each of those one line, not a paragraph, and do not retry them.
>
> If nothing is behind, say so in one sentence and stop.

Two things to know before you go looking for it:

- **`hermes cron list` does not show it while it is paused.** Use `hermes cron list --all`, and read
  `hermes cron status` as saying only whether the ticker is alive.
- `--deliver platform:C0C2THV4Y12` is the home channel, where a person reads. It is not
  `C0B0F6KQ4ES`, which is the channel `ask_for_review` pings and where only bots are listening.

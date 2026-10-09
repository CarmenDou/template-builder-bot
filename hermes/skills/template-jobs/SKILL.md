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
- Someone asks about templates in general, naming none: `check_template_upstream`. "Which templates
  are behind", "anything to update this week".
- **Someone names ONE template, however they word it: `bump_template`.** "Update n8n", "can n8n be
  updated", "is n8n behind", "what's n8n on" all go here. The test is whether a template was named,
  not how the sentence was phrased.

  **Do not answer with a version number, and do not ask whether to go ahead.** Naming a template is
  the request. Call `bump_template` and answer with what it returns, which is a pull request link.
  There is nothing to confirm first: what it opens is a pull request nobody has to merge, it
  opens nothing at all when a bump is already open, and it never deploys. Asking permission turns
  one message into three and is the experience this tool exists to replace.

## Starting

Use `start_template_job` for a repository and `continue_template_pr` for a PR number. Pass the
person's own words as `instructions`, then start following it straight away, in the same turn.

Your opening message is one line: what it has started on, that triage comes back first, and that it
takes 10 to 30 minutes. Do not spend it describing what you are about to do. The triage line a
minute later says what the repository turned out to be and which route it took, and a message whose
only content is that another message is coming is the repetition this skill exists to prevent.

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

**Every message you send carries a fact your last one did not: a new stage, a new command, a new
conclusion. A look that brought none is a look you say nothing about.** Check it before you send,
against your own previous message, and send nothing when it fails.

`said:` lines are the agent thinking out loud, they arrive the whole time, and they almost never
clear that bar. Relaying them turns a twenty minute job into forty messages that each amount to "it
is still going", and a person reading that still cannot tell how far along it is. Slack keeps every
line: Hermes cannot edit a post here the way it rewrites a line in a terminal, so a message that
added nothing is in the channel for good.

When you do speak, lead with the stage and its marker, then what changed:

    🔀 pr       opened https://github.com/InsForge/instacloud-oss/pull/231, CI is running now
    🧪 verify   reach ✓  enter ✓  round-trip ✓  survive ✗  the deck lost its edits across a restart

One marker per stage and always the same one, so somebody scrolling the channel finds the job's
place before reading a word:

    🔍 triage    📝 manifest    🔀 pr    🏗 build    🚀 deploy    🧪 verify    ⚠️ note

The marker names the stage, never how it went: a verify that failed is still `🧪 verify`, with the
✗ in the line. A green tick on a line about something broken is worse than no tick at all.

**When one command is the thing that happened, show that command rather than describing it.** A
person reading `insta compute logs twenty --since 10m` knows exactly what was done and can run it
themselves. A sentence about it is longer, and it is a claim the agent is making about its own
behaviour, which can be wrong where the command cannot. Put it in a code block on its own line:

    [deploy] the worker would not start, so it went to the logs
    ```
    insta compute logs twenty --since 10m
    ```

Describe instead of quoting when there is no single command to point at, and say the real thing
when you do: "it is reading how Twenty's image starts, to see whether the worker needs its own
image", never "it ran some commands".

Two limits. **Never paste the feed**: one command, the one that matters, not the six around it.
And **never show a command carrying a credential** (`--password`, a token, a connection string
with one in it): say what it did and leave the value out. A secret in a channel outlives the job.

If a stage has been running about five minutes, say in one sentence what it is waiting on, a CI run
or a deploy, so silence never looks like a dead job. That sentence is the exception to the rule
above: it is the one time nothing having happened is itself worth saying.

When the status says `done`, call `read_job` for the result and report it: the verdict, the PR,
the deployed URL, every `created:` item (credentials it set up, so the person can log in
themselves) and every `ask:` item as a short list of decisions that are theirs to make. Then stop
following.

## Asking, while it keeps working

The job cannot ask anyone anything. It runs detached on another machine with nobody listening, and
its own instructions tell it to build rather than stop for a question. So when it reaches a fork it
takes one side and says which, in the triage line or in a `note:`. You are the only one who can put
that choice to a person, and the job does not wait while you do.

Use `clarify` when the feed shows a choice a person might overturn: what the template is for,
whether it ships the worker, how a real limit gets described to somebody deciding whether to
deploy, which of two logos. Put the side the job already took first, so the tool labels it
`(Recommended)` and the quiet answer is the one already being built.

- They pick what the job chose, or nobody answers: say nothing more. Work carries on.
- They pick the other side: `steer_job` in their words, not your summary, and say in one line that
  you did.

Nobody has to answer. When the time limit passes `clarify` returns "use your best judgement and
proceed", and here that means the fork is already settled the way the job settled it.

**Never ask for permission.** "Shall I open the pull request", "shall I bump it", "want me to
re-run CI" are not forks, they are the job. A question you already have the answer to is the
going-in-circles this skill exists to stop.

Most jobs reach no fork worth a question. One route, taken, said out loud, is the normal shape.

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

## After a person has looked at the pull request

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
- The prompt above says "draft pull request" because it was written while bumps opened drafts. It
  is quoted as created, not as it should be. Recreate the cron with that word dropped before it is
  unpaused, or the weekly message will call ready-for-review pull requests drafts.
- `--deliver platform:C0C2THV4Y12` is the home channel, where a person reads. It is not
  `C0B0F6KQ4ES`, which is the channel `ask_for_review` pings and where only bots are listening.

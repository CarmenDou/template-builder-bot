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

## Starting

Use `start_template_job` for a repository and `continue_template_pr` for a PR number. Pass the
person's own words as `instructions`. Say in one sentence that it has started and roughly how long
it takes, 10 to 30 minutes, and then start following it straight away, in the same turn.

## Following, until it is done

Call `follow_job` in a loop, starting with offset `0` and stages `0` and passing back the `offset`
and `stages` each result gives you. It waits on the agent box by itself, up to about 45 seconds,
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
- "Stop": call `stop_job`, say what was already pushed stays pushed, and stop following.

**Ending your turn does not stop the job.** It runs on another machine and carries on whether
anyone is watching or not, so a "stop" answered only with words leaves it running unobserved.

## After a person has looked at the draft

Only when they say to send it for review: `ask_for_review` with stage `review` first. Only after
that comes back clean and they say so: stage `approve`. Never on your own because a job finished.

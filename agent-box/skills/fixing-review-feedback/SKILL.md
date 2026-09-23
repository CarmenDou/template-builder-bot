---
name: fixing-review-feedback
description: Use whenever you are changing a pull request because a reviewer, Codex, Claude or a person, asked for changes. How Carmen fixes review feedback, in order, for a template PR on instacloud-oss.
---

# Fixing review feedback

A review round is paid for twice when it is fixed badly: once now, and once when the reviewer finds
the next instance of the same mistake. These are the habits that avoid the second round.

## Before you change anything

1. **Read the whole review first, then use `receiving-code-review`.** Verify each finding against the
   code or by reproducing it, and note the file and line or the output that settles it. Do not agree
   because a reviewer said so, and do not fix something you have not confirmed. A finding that does
   not hold stays unfixed, and your RESULT says why.
2. **Find the repo's existing answer to the same problem.** Another template, a shared script or a
   lint rule has usually solved this class of thing already: do it the same way. Invent only when
   nothing exists, and say that you did.

## While fixing

3. **Fix the class, not the instance.** When one finding is real, sweep every file this PR touches
   for the same mistake and fix them all in this round. If the same flaw exists outside this PR, in
   other templates, do not widen the PR: record it as an `ask:` so a person decides.
4. **Ask what the fix can now break that the old code could not**, and test that too. A regression
   test has to be able to fail: check that it fails without the fix before trusting that it passes.
5. **After changing a line, grep for everything else that produces or reads it.** Assert on what the
   system actually produces, not on the value you expect it to produce.
6. Code style: comments are one short line; no function or field that only forwards to another; do
   not invent a new word for something that already has a name; do not add workarounds for a
   person's typo.

## Before you push

7. **Run the repo's own gates** (the templates lint and tests, `git diff --check`) and fix everything
   they report. Never pipe them into `tail` or `head`: a pipe reports the last command's exit code,
   so a failure reads as a pass.
8. **One commit for the round, on the same branch, in the same PR.** Never a second PR for the fix,
   never a force-push, never a push to the base branch. No `Co-Authored-By` trailer.
9. **Do not reply on the PR.** The fix is the commit; the explanation goes in the PR body and in your
   RESULT. Nobody asked for a comment thread.
10. **Update the PR body so it is still the spec**, with What / How / Verify and only claims you
    verified. Reviewers check the code against the body, and a claim that is wrong there becomes a
    false Critical in the next round. No em dashes and no semicolons in it.
11. **It stays a draft.** Never mark it ready and never merge, however clean the review.

## Reporting

In your RESULT, one line per finding: `fixed`, `not real` with the evidence, or `ask:` when it needs
a person, including anything where `receiving-code-review` says to discuss with your human partner:
there is no one to discuss with during a job, so write the question down instead of guessing.

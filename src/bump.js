// Moving one template forward, deterministically: patch it, commit it, push a branch, and read what
// happened.
//
// The edits are not repeated here. `check-upstreams.mjs --apply` in instacloud-oss resolves the
// upstream and writes the manifest and the Dockerfile together, or refuses and says why. This file
// builds the one shell script that runs it and then commits and pushes what it wrote, and reads the
// answer, and never second-guesses the patcher. `runBump` is the only function here that runs
// anything, and it runs the script exactly once.

import { inspect } from 'node:util';
import { posix } from 'node:path';
import { execInBox } from './agent.js';
import { readDrift } from './drift.js';
import { bumpDir, cloneForBumpScript } from './registry.js';

// Seconds to wait for another bump of the same template. The lock is taken before the clone, so the
// clone, the install, the patch, the commit and the push are all inside it, and inside the 28 second
// kill below (the channel cuts a command off at about 31 and drift.js kills at 28 too). Measured on
// the box against the real repository: clone 5 seconds, install 1, the patch 2.5 to 5.4 (n8n slowest,
// on its registry calls; the read only detector over all eleven templates takes 2). A run in front
// is about 9 to 11 seconds before its push, which 15 outlasts. A caller that waits the whole 15 has
// 13 left for a 5 second clone, a 1 second install, a patch and a push: tight, not impossible. The
// push to GitHub itself has not been timed.
const LOCK_WAIT_SECONDS = 15;

// Our own kill, in milliseconds, for the reason drift.js gives: it has to fire before the channel's.
const TIMEOUT_MS = 28000;

// What an error says of a failed push, and this lands in a chat reply.
const TAIL = 400;

/**
 * A reason off the patcher's row, made fit to put in a chat reply.
 *
 * One function for both `refused` and `unknown`, because they are the same thing: text the patcher
 * wrote about one template that a person reads. They were two lines that had drifted, and the one
 * that was never tightened printed `[object Object]` for a non-string and had no length at all.
 */
const reason = (said) => (typeof said === 'string' ? said : inspect(said)).slice(0, TAIL);

// The one sentence the script prints when another bump of the same template holds the lock.
const LOCKED = /^could not take the bump lock for \S+ in \d+ seconds, another bump is running$/m;

/**
 * What a version string may be, wherever one is handed on: characters no shell, branch name or
 * commit message treats specially. A newline is what would turn a subject into a body and a body
 * into a trailer, and the pattern is anchored so a trailing one does not slip past `$`.
 *
 * The patcher does not promise this. For a git-commit upstream `to` is whatever the GitHub API
 * returned, and `from` is whatever text the manifest pins.
 */
export const VERSION = /^[A-Za-z0-9._+-]+$/;

// What a level may be wherever one is handed on. The detector says major, minor or patch, or null
// for a move it cannot order, and the level goes into a public pull request and a chat reply.
export const LEVEL = /^[a-z]+$/;

/**
 * The branch a bump is pushed to: the template and the upstream version it moves to.
 *
 * The script spells the same name from the row it reads, so `runBump` compares what the box says it
 * pushed with this before it hands a branch on.
 */
export const bumpBranch = (code, applied) => `feat/${code}-${applied.upstream.to}`;

// How the reader says "there is an answer and nothing to push". Any other non-zero status is a fault.
const ANSWERED = 10;

// Prints `<from> <to>` for the one row that says it patched this template, and nothing else. A row
// about this template that says it is current, refused or unresolved is an answer, and so is a
// patch with a version or a level that is not safe, which also says why: exit ANSWERED. Everything
// else, no rows, two rows, another template's row, a row that says nothing, is a fault: exit 1. All
// four versions and the level are checked because the script is about to push, and readApply only
// sees them after: a level refused there would leave a pushed branch behind an error that says none.
const readVersions = (code) =>
  [
    'let rows = [];',
    'try { rows = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}',
    'const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;',
    `if (!row || row.code !== "${code}") process.exit(1);`,
    `if (row.unknown || row.refused || row.current) process.exit(${ANSWERED});`,
    'if (!row.applied) process.exit(1);',
    `const safe = (v) => typeof v === "string" && ${VERSION}.test(v);`,
    `if (![row.from, row.to, row.applied.from, row.applied.to].every(safe)) { console.error("the patcher gave a version that is not safe to name a branch after"); process.exit(${ANSWERED}); }`,
    `if (row.level != null && !(typeof row.level === "string" && ${LEVEL}.test(row.level))) { console.error("the patcher gave a level that is not safe to put in a pull request"); process.exit(${ANSWERED}); }`,
    'console.log(row.from + " " + row.to);',
  ].join(' ');

/**
 * Shell that takes the lock, clones a fresh tree, patches one template in it, and pushes the patch
 * as a branch.
 *
 * It exits 0 whenever it has a definite answer, and non-zero only for a fault. `execInBox` re-runs
 * the WHOLE script over ssh after any rejection, and a second run of this one is a second push, so
 * an answer must not look like a failure. Zero: the patch was pushed (the last line says
 * `PUSHED <branch>`), the template is current, refused or unresolved, the lock is held by another
 * bump, there is no such template, a version was not safe to push, and the remote turned the push
 * down (a `[rejected]` or `[remote rejected]` ref, which is what a lost lease looks like, and a
 * retry would win it against a clone taken a moment later and overwrite the winner). Non-zero:
 * flock itself failing, the clone or the install, the patcher's rows missing or not about this
 * template, a patch that changed nothing, any git step, and a push that failed without a ref being
 * turned down (no route, no credential). A retry of those repeats a read or a failed push. What no
 * exit status can cover is our own kill at 28 seconds, which is a rejection from out here.
 *
 * ONE script, because each exec is a separate shell: a lock taken in one would be released before
 * the next began, and `bumpDir` is one path per template, so two bumps of it would clone over each
 * other. The lock comes first and covers the clone, because `rm -rf` of a path that another bump is
 * in the middle of writing is the collision the lock exists for. The shell holds fd 9 until it
 * exits, so everything after the patcher runs under the same lock.
 *
 * The lock file sits beside the tree and not in it, because the tree is deleted on every run and a
 * lock deleted while held lets the next caller lock a new file and walk in.
 *
 * Whether to commit is decided in the shell, by `git diff --quiet -- templates/<code>`, together
 * with the patcher's own row saying it applied (that row is also where the version comes from). The
 * check is scoped to that directory because `npm install` can rewrite `templates/package-lock.json`
 * in every tree, including one where nothing was patched. For the same reason only that directory
 * is staged, never the tree.
 *
 * `checkout -B` and `--force-with-lease`, because a pull request that was closed leaves its branch
 * behind and that is the ordinary case. The lease still refuses when somebody moved the branch
 * after the clone.
 *
 * `gc.auto=0` on the commit because children inherit fd 9: an auto gc left running in the
 * background would keep the lock after the script has exited. `core.hooksPath=/dev/null` because a
 * global hooks directory on the box with a `prepare-commit-msg` in it puts a trailer into the
 * commit. No body and no trailer in the commit.
 *
 * Throws on anything that is not a template code, from `bumpDir`, before any text is built.
 */
export function bumpScript(code) {
  const dir = bumpDir(code);
  return [
    `mkdir -p ${posix.dirname(dir)}`,
    `exec 9>${dir}.lock`,
    // Status 1 is flock's own for a timeout, and that is an answer. Anything else is flock failing.
    `flock -w ${LOCK_WAIT_SECONDS} 9 || { [ $? -eq 1 ] && { echo 'could not take the bump lock for ${code} in ${LOCK_WAIT_SECONDS} seconds, another bump is running' >&2; exit 0; }; exit 1; }`,
    cloneForBumpScript(code),
    // `scripts` passes the code pattern and is a directory under templates/, but it is tooling. A
    // template is a directory with a manifest, which is what the patcher itself lists.
    `test -f ${dir}/templates/${code}/insta.template.yaml || { echo 'no such template: ${code}' >&2; exit 0; }`,
    // Nothing stops on the patcher's exit status: 1 means this template could not be resolved, and
    // its rows are the answer either way. They are printed again so the caller reads them.
    `out=$(node ${dir}/templates/scripts/check-upstreams.mjs --json --apply ${code})`,
    `printf '%s\\n' "$out"`,
    `versions=$(printf '%s\\n' "$out" | node -e '${readVersions(code)}') || { [ $? -eq ${ANSWERED} ] && exit 0; exit 1; }`,
    // Two words that passed VERSION, so cutting them apart needs no splitting and no globbing.
    'from=${versions% *}',
    'to=${versions#* }',
    `cd ${dir} || exit 1`,
    `git diff --quiet -- templates/${code} && { echo 'the patcher reported a patch, but templates/${code} is unchanged, so there is nothing to commit' >&2; exit 1; }`,
    `branch=feat/${code}-$to`,
    'git checkout -B "$branch" || exit 1',
    `git add -- templates/${code} || exit 1`,
    `git -c gc.auto=0 -c core.hooksPath=/dev/null -c user.name=template-builder -c user.email=carmen.dou@insforge.dev commit -m "${code} $from -> $to" || exit 1`,
    // A ref the remote turned down is an answer. Its status line is ` ! [rejected]` or
    // ` ! [remote rejected]`, and a hook's own words begin `remote:`, so they cannot pass for one.
    'push=$(git push --force-with-lease -u origin "$branch" 2>&1); status=$?',
    `printf '%s\\n' "$push" >&2`,
    `[ $status -eq 0 ] || { printf '%s\\n' "$push" | grep -Eq '^ ! \\[(remote )?rejected\\]' && exit 0; exit 1; }`,
    'echo "PUSHED $branch"',
  ].join('\n');
}

/**
 * What the patcher decided, out of whatever else shared the stream.
 *
 * `code` is the template that was asked for, and a row about another one is refused: it would
 * otherwise read as ours.
 *
 * A refusal is an answer and carries its reason, cut at TAIL. With `--apply <code>` the patcher looks only at
 * that template, so it exits 1 only when that one could not be resolved and 0 when it patched or
 * refused, and a caller must read the output whatever the exit code was.
 *
 * The version strings of a patch are refused unless they match VERSION. They reach a branch name
 * and a commit subject, and later a pull request, so this is the one place they are checked in JS.
 * The script checks the two it uses itself as well, because it acts on them before this runs. The
 * level is a string matching LEVEL or null, for the same public places, and the script checks it too.
 *
 * `cause` is what to say when there are no rows at all and the caller knows why, as `readDrift` takes.
 */
export function readApply(stdout, code, cause) {
  const { rows, error } = readDrift(stdout, cause);
  if (error) {
    // The box answered, it could not get the lock. That is not a box that failed to answer with json.
    const held = LOCKED.exec(String(stdout ?? ''));
    return { error: held ? held[0] : error };
  }
  // One code was asked for, so anything else means the patcher was not given the one we meant.
  if (rows.length !== 1) {
    return { error: `The patcher answered about ${rows.length} templates when asked about one, so the tree may hold edits nobody asked for.` };
  }
  const row = rows[0];
  if (row.code !== code) {
    return { error: `The patcher answered about ${inspect(row.code).slice(0, 60)} when asked about ${inspect(code).slice(0, 60)}, so this is not an answer about the template that was asked for.` };
  }
  // Before `current`: not being able to look is not the same as having nothing to do.
  if (row.unknown) return { error: `${row.code} could not be resolved: ${reason(row.unknown)}` };
  if (row.refused) return { refused: reason(row.refused), code: row.code };
  if (row.current) return { current: true, code: row.code };
  if (!row.applied) {
    // Only a row that names a move can be behind. An empty one says nothing at all.
    return {
      error: row.to
        ? `${row.code} is behind but the patcher wrote nothing, and gave no reason.`
        : `${row.code}: the patcher's answer says neither that it is current, nor that it patched or refused, nor why it could not look.`,
    };
  }
  const versions = {
    'upstream from': row.from,
    'upstream to': row.to,
    'template from': row.applied.from,
    'template to': row.applied.to,
  };
  for (const [what, v] of Object.entries(versions)) {
    if (typeof v !== 'string' || !VERSION.test(v)) {
      return { error: `${row.code}: the ${what} version ${inspect(v).slice(0, 60)} is not a plain version string, so it is not put in a branch name or a commit.` };
    }
  }
  const level = row.level ?? null;
  if (level !== null && (typeof level !== 'string' || !LEVEL.test(level))) {
    return { error: `${row.code}: the level ${inspect(level).slice(0, 60)} is not a plain word, so it is not put in a pull request.` };
  }
  return {
    applied: {
      code: row.code,
      kind: row.kind,
      level,
      upstream: { from: row.from, to: row.to },
      version: { from: row.applied.from, to: row.applied.to },
    },
  };
}

const wasKilled = (e) => Boolean(e.killed || e.signal);

/**
 * What ended the run, read off the error object. Its message is `Command failed:` plus the whole
 * argv, which here contains the entire script, so the message never shows the cause. The end of
 * stderr is where git says why, and stdout is not used: it holds the patcher's rows.
 */
function describeStop(e) {
  if (wasKilled(e)) {
    const by = e.signal ? ` by ${e.signal}` : '';
    return `the run was killed${by} before it finished, most likely at its ${TIMEOUT_MS / 1000} second limit`;
  }
  const said = String(e.stderr || '').trim();
  if (said) return said.slice(-TAIL);
  // No output at all: an exit code says more than the argv, and a spawn error says the most.
  return typeof e.code === 'number' ? `exit code ${e.code} with nothing on stderr` : String(e.message ?? e).slice(0, TAIL);
}

/**
 * Run the whole bump in the box, once, and say what came of it: `{ applied, branch }` when the
 * patch was pushed, `{ refused }` or `{ current }` when there was nothing to push and the patcher
 * said why, and `{ error }` for everything else, including a patch that was made and not pushed.
 *
 * The script exits 0 for an answer and non-zero for a fault (see `bumpScript`), and both are read.
 * A fault that came after the patcher ran still has its rows on stdout, and the lock message and
 * `no such template` are on stderr, so the rows are read out of both streams, as `checkUpstream`
 * does. The push itself is taken from stdout alone, from a line that says so, only on a clean
 * exit, and only when the branch it names is the one this process would have named.
 */
export async function runBump(config, code, deps = {}) {
  const { run = execInBox } = deps;
  let script;
  try {
    script = bumpScript(code);
  } catch (e) {
    return { error: `${e.message}. A code is a directory under templates/ in instacloud-oss.` };
  }
  let answer;
  let stopped = null;
  try {
    answer = await run(config, script, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    answer = e;
    stopped = e;
  }
  const said = [answer.stdout, answer.stderr].filter(Boolean).join('\n');
  // With output and nothing on stderr, readDrift shows the output, which says more than an exit code.
  const onlyStdout = stopped && !wasKilled(stopped) && !stopped.stderr && said.trim() !== '';
  const read = readApply(said, code, stopped && !onlyStdout ? describeStop(stopped) : undefined);
  if (!read.applied) return read;
  // Only a clean exit vouches for the marker: a line that says PUSHED on the way to a fault is not one.
  const pushed = stopped ? undefined : /^PUSHED (\S+)$/m.exec(String(answer.stdout ?? ''))?.[1];
  if (pushed === undefined) {
    // A run that was killed may have got as far as the push, so it cannot say the branch is absent.
    const maybe = stopped && wasKilled(stopped) ? ' The branch may have been pushed before that, so look at the repository before trying again.' : '';
    const said = String(answer.stderr || '').trim();
    const why = stopped ? describeStop(stopped) : said ? said.slice(-TAIL) : 'the run ended without pushing and without saying why';
    return { error: `The patch was made on the box, but no branch was pushed: ${why}.${maybe}` };
  }
  const branch = bumpBranch(code, read.applied);
  if (pushed !== branch) return { error: `The box says it pushed ${inspect(pushed).slice(0, 100)}, and this run would have named the branch ${branch}, so the branch is not handed on.` };
  return { applied: read.applied, branch };
}

// The CLI that opens pull requests, at the path review.js reads them through. It has a token on the
// box and nowhere else does.
const GH = '/data/home/bin/gh';
const REPO = 'InsForge/instacloud-oss';

// The same pattern as CODE in upstream.js, drift.js and registry.js, so a code those accept is accepted here.
const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The repository as a pattern. It is put into a regular expression below, and a `.` in a name would
// match any character there.
const REPO_PATTERN = REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PULL = `https://github\\.com/${REPO_PATTERN}/pull/\\d+`;

// A pull request of this repository on a line of its own, and nothing else. A link is handed to a
// person, so what gh printed beside it, or the url of some other repository, must not pass for one.
const PULL_URL = new RegExp(`^${PULL}$`, 'm');

// One line of `findOpenBumpScript`: the link, and the branch the pull request is from. The branch is
// always there in what that script prints and is optional here only so that a bare link still reads.
const OPEN_BUMP = new RegExp(`^(${PULL})(?: (\\S+))?$`, 'm');

/**
 * Shell that lists, one per line as `<link> <branch>`, the open pull requests whose branch is one
 * this tool would have pushed for this template.
 *
 * The branch is printed because a caller that has just pushed one needs to know whether the pull
 * request it was pointed at is on that branch or on an older one.
 *
 * Found by branch and never by title. A reviewer retypes a title, and a bump that stopped being
 * found would be opened a second time. The prefix is the one `bumpBranch` names, so a pull request
 * somebody else opened is not ours. A code that is the start of another (`a` and `a-b`) also
 * matches the other's branches, which errs toward pointing at a pull request that is not this
 * template's and never toward opening a second one.
 *
 * gh is the last command and not the head of a pipe, so its exit status is the script's. Piped
 * through `head`, a gh that failed would print nothing and exit 0, which reads as "none open". And
 * `--limit`, because gh lists thirty by default and an open bump beyond that would not be found.
 *
 * Throws on anything that is not a template code, before any text is built.
 */
export function findOpenBumpScript(code) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error(`${inspect(code)} is not a template code`);
  return `${GH} pr list --repo ${REPO} --state open --limit 100 --json url,headRefName --jq '.[] | select(.headRefName | startswith("feat/${code}-")) | "\\(.url) \\(.headRefName)"'`;
}

/**
 * Whether a bump pull request for this template is already open: `{ existing, head }` with its link
 * and the branch it is from, `{}` when there is none, and `{ error }` when gh could not say, which
 * is not the same as none. `head` is left out when the answer carried no branch.
 *
 * A caller that is about to push asks this first. `runBump` ends in a `--force-with-lease` push
 * whose lease is taken against a clone made seconds before, so against the branch of an open pull
 * request it is a force push, and it would rewrite that pull request's head.
 */
export async function findOpenBump(config, code, deps = {}) {
  const { run = execInBox } = deps;
  let script;
  try {
    script = findOpenBumpScript(code);
  } catch (e) {
    return { error: `${e.message}. A code is a directory under templates/ in instacloud-oss.` };
  }
  let answer;
  try {
    answer = await run(config, script, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    return { error: `Could not ask whether a bump is already open: ${describeStop(e)}.` };
  }
  const said = String(answer.stdout ?? '').trim();
  if (!said) return {};
  // The first one. Two open at once is rare, and either is a link to follow.
  const open = OPEN_BUMP.exec(said);
  if (!open) return { error: `gh answered with something that is not a pull request url, so it is not known whether a bump is open: ${said.slice(0, 200)}` };
  return open[2] ? { existing: open[1], head: open[2] } : { existing: open[1] };
}

/**
 * What a reviewer needs, and an honest account of what was not done.
 *
 * No trailer, because this repository's owner does not take them, and no "generated with" line,
 * because it would be false here: `template-builder` opens these on the agent box and the diff is
 * made by the registry's own patcher, which the body names. No password, because the box's rule is
 * that credentials never reach a pull request body.
 *
 * It names no file. The patcher's row says what moved and not which files it wrote (n8n has no
 * Dockerfile, for one), and the diff is right there in the pull request for anyone who wants the
 * list. For the same reason it says nothing about how the result deploys. It does say that the push
 * runs the image build, or the sentence about CI would read as everything CI does with the branch.
 * That build resolves which templates to rebuild from the pushed commit's base, and a new branch
 * has none, so the first push of every bump rebuilds all of them. Checked on the real workflow,
 * not assumed: `templates-build-images.yml` falls back to `buildable()` when `github.event.before`
 * does not resolve.
 *
 * The command is the one a person would type and names the template, because without it the line
 * tells a reviewer to patch every template in the registry. The `--json` the bump adds is for the
 * machine that reads the answer. It says no person or agent wrote the diff and stops short of
 * "deterministic": the patcher resolves the upstream over live APIs, so the same command later can
 * write a different patch.
 */
export function prBody(applied) {
  return [
    '## What',
    '',
    `${applied.code}'s upstream moved from ${applied.upstream.from} to ${applied.upstream.to}`
      + `${applied.level ? ` (${applied.level})` : ''}, so this moves the template's upstream pin to it`
      + ` and bumps the template's own version (${applied.version.from} -> ${applied.version.to}).`,
    '',
    '## How',
    '',
    `Every edit here was made by \`npm run check-upstreams -- --apply ${applied.code}\` in \`templates/\`, and no`
      + ' person or agent wrote any of it. The patcher is unit tested in this repository and refuses'
      + ' rather than half-editing when a file is not what it expected. It resolves the upstream over'
      + ' live APIs, so running it again later may pick a newer version.',
    '',
    '## Verify',
    '',
    '**This has not been deployed and nothing has verified that it still works.** The repository\'s own'
      + ' checks, `npm run lint` and `npm run version-guard`, run in CI on this pull request and are'
      + ' pending when it is opened. Pushing this branch also runs the repository\'s image build, which'
      + ' publishes container images to GHCR under tags for this branch and commit. A new branch has no'
      + ' base commit to compare against, so that first run rebuilds every template that ships its own'
      + ' image, not only this one.',
  ].join('\n');
}

/**
 * Shell that writes the body to a file and asks gh to open a pull request from `branch` into main.
 * Ready for review, not a draft: a draft is not what Codex picks up, and a bump nobody reviews is a
 * bump nobody merges.
 *
 * Throws unless the code, all four versions and the branch are what this tool would have named. They
 * are spliced into a shell command and a title, and this is exported and can be reached without
 * going through `readApply` or `runBump`, so they are checked here, at the use, as the branch and
 * the commit subject are in `bumpScript`. The template's own two versions go only into the body, but
 * the body is public.
 *
 * The body file is left in /tmp on purpose. It is one per code so two bumps cannot collide, about a
 * kilobyte, on a tmpfs that a restart clears.
 */
export function openPrScript(code, applied, branch) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error(`${inspect(code)} is not a template code`);
  if (applied?.code !== code) throw new Error(`the patch is for ${inspect(applied?.code).slice(0, 60)}, not for ${code}`);
  const versions = {
    'upstream from': applied.upstream?.from,
    'upstream to': applied.upstream?.to,
    'template from': applied.version?.from,
    'template to': applied.version?.to,
  };
  for (const [what, v] of Object.entries(versions)) {
    if (typeof v !== 'string' || !VERSION.test(v)) throw new Error(`the ${what} version ${inspect(v).slice(0, 60)} is not a plain version string, so it is not put in a pull request`);
  }
  // The level is in the public body too, and a hand-built patch has none or null.
  if (applied.level != null && (typeof applied.level !== 'string' || !LEVEL.test(applied.level))) {
    throw new Error(`the level ${inspect(applied.level).slice(0, 60)} is not a plain word, so it is not put in a pull request`);
  }
  if (branch !== bumpBranch(code, applied)) {
    throw new Error(`${inspect(branch).slice(0, 100)} is not the branch a bump of ${code} to ${applied.upstream.to} is pushed to`);
  }
  const title = `${code} ${applied.upstream.from} -> ${applied.upstream.to}`;
  // Base64 for the same reason the task prompts are: a body with quotes in it does not survive
  // being spliced into a shell command, and this one has backticks.
  const body64 = Buffer.from(prBody(applied), 'utf8').toString('base64');
  return [
    // The redirect truncates the file before anything is written to it, so a write that fails part
    // way has to stop here, or gh opens a real pull request on a public repository with half a body.
    `printf '%s' '${body64}' | base64 -d > /tmp/bump-${code}.md || exit 1`,
    `${GH} pr create --repo ${REPO} --base main --head ${branch} --title '${title}' --body-file /tmp/bump-${code}.md`,
  ].join('\n');
}

// What an open bump pull request means for the branch a caller has just pushed. `stranded` is that
// branch, and it is there unless the open pull request is known to be from it: the branch is on the
// remote with no pull request of its own, and a caller that says nothing was pushed would be wrong.
const alreadyOpen = (found, branch) => (found.head === branch ? { existing: found.existing } : { existing: found.existing, stranded: branch });

/**
 * Open the draft pull request for a branch that has been pushed, unless a bump for this template is
 * already open, and say what came of it: `{ url }`, `{ existing }` with the link of the one that is
 * open and nothing opened, or `{ error }`. `{ existing }` carries `stranded` when the branch handed
 * in has no pull request of its own, as `alreadyOpen` says.
 *
 * It asks whether one is open although its caller may have asked before pushing. That costs one
 * `gh pr list` and closes the gap between that question and this pull request. When it could not
 * ask, it opens nothing, and says the branch is pushed as every failure after a push here does.
 *
 * A create that failed is followed by one more look before it is called a failure. Over ssh
 * `execInBox` runs the whole script again after a rejection, so a create that succeeded and then
 * lost the connection runs twice, and the second is refused because a pull request for that branch
 * exists. Saying it was not opened would then be false, and would send a person to open it.
 *
 * What `openPrScript` refuses is the one error here that does NOT say the branch is pushed, and
 * the reason is that it cannot be reached with one pushed: through `bump_template` every value it
 * checks was already checked by the in-script reader and `readApply` before the push happened. It
 * is not that nothing has been sent yet, which is untrue by this point. A caller that pushed by
 * some other route and then came here would need that clause.
 */
export async function openBumpPr(config, code, applied, branch, deps = {}) {
  const { run = execInBox } = deps;
  let script;
  try {
    script = openPrScript(code, applied, branch);
  } catch (e) {
    return { error: e.message };
  }
  const open = await findOpenBump(config, code, deps);
  // Not being able to ask still comes after the push, so it says the branch is there like the rest.
  if (open.error) return { error: `The branch is pushed but the pull request was not opened: ${open.error}` };
  if (open.existing) return alreadyOpen(open, branch);

  // What to answer when the create did not give a link. The create's own error stays the answer
  // unless the look finds one open, and a look that fails is not allowed to replace it.
  const unopened = async (error) => {
    const again = await findOpenBump(config, code, deps);
    return again.existing ? alreadyOpen(again, branch) : { error };
  };

  let answer;
  try {
    answer = await run(config, script, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    // A run that was killed may have got as far as creating it, so it cannot say there is none.
    const maybe = wasKilled(e) ? ' The pull request may have been opened before that, so look at the repository before trying again.' : '';
    return unopened(`The branch is pushed but the pull request was not opened: ${describeStop(e)}.${maybe}`);
  }
  const said = String(answer.stdout ?? '').trim();
  // The line it is on, because gh may say other things on the way.
  const url = PULL_URL.exec(said);
  return url ? { url: url[0] } : unopened(`The branch is pushed but gh did not print a pull request url: ${said.slice(0, 200) || '(nothing)'}`);
}

// The one sentence that says what was not done to a patch, shared by every answer that has one.
const UNTESTED = 'It has NOT been deployed and no verification has run, so do not say it was tested.';

/**
 * What to tell the person, and never that the result was tested. The shapes: a pull request was
 * opened, one was already open before anything ran, and one appeared once the branch was pushed.
 *
 * `applied` is absent when nothing ran, so there is no move to name and nothing was pushed.
 * `stranded` is `openBumpPr`'s: a branch was pushed that the open pull request is not known to be from.
 */
export function describeBump({ applied, code, url, existing, stranded }) {
  // Named, not "this template": the weekly run puts one of these beside seven others in a single
  // message, and there "this template" points at nothing.
  const named = applied?.code ?? code;
  if (!applied) {
    return `A bump pull request for ${named ?? 'this template'} is already open: ${existing}\n\n`
      + 'Nothing was pushed and nothing was opened. This did not check whether it has been deployed or verified.';
  }
  const move = `${applied.code} ${applied.upstream.from} -> ${applied.upstream.to}`
    + `${applied.level ? ` (${applied.level})` : ''}, template ${applied.version.from} -> ${applied.version.to}`;
  if (url) {
    return `${move}\n\nPull request: ${url}\n\nThe diff was made by the registry's own patcher. ${UNTESTED}`
      + " CI runs the repository's lint and version guard on it.";
  }
  if (stranded) {
    return `${move}\n\nA bump pull request for ${applied.code} is already open: ${existing}\n\n`
      + `This bump pushed a branch anyway, ${stranded}, and that pull request is not known to be from it,`
      + ` so the branch is in the repository with no pull request of its own. Nothing was opened. ${UNTESTED}`;
  }
  return `${move}\n\nA bump pull request for ${applied.code} appeared while this bump was running: ${existing}\n\n`
    + `This bump pushed ${bumpBranch(applied.code, applied)}, which is that pull request's branch, so the patch`
    + ` is in it and no second pull request was opened. ${UNTESTED}`;
}

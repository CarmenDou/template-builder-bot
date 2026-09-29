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

// Seconds to wait for another bump of the same template. The channel cuts a command off at about 31
// seconds and drift.js kills at 28, so the wait and the work after it have to fit. Measured end to
// end against the real repository the patch takes 2.5 to 5.4 seconds (n8n slowest, on its registry
// calls), so 15 leaves 13 for it and the commit and push, and outlasts a whole run in front. The
// push to GitHub itself has not been timed.
const LOCK_WAIT_SECONDS = 15;

// Our own kill, in milliseconds, for the reason drift.js gives: it has to fire before the channel's.
const TIMEOUT_MS = 28000;

// What an error says of a failed push, and this lands in a chat reply.
const TAIL = 400;

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
// patch with a version that is not safe, which also says why: exit ANSWERED. Everything else, no
// rows, two rows, another template's row, a row that says nothing, is a fault: exit 1. All four
// versions are checked because the script is about to push, and readApply only sees them after.
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
 * A refusal is an answer and carries its reason. With `--apply <code>` the patcher looks only at
 * that template, so it exits 1 only when that one could not be resolved and 0 when it patched or
 * refused, and a caller must read the output whatever the exit code was.
 *
 * The version strings of a patch are refused unless they match VERSION. They reach a branch name
 * and a commit subject, and later a pull request, so this is the one place they are checked in JS.
 * The script checks the two it uses itself as well, because it acts on them before this runs.
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
  if (row.unknown) return { error: `${row.code} could not be resolved: ${row.unknown}` };
  if (row.refused) return { refused: row.refused, code: row.code };
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
  return {
    applied: {
      code: row.code,
      kind: row.kind,
      level: row.level ?? null,
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

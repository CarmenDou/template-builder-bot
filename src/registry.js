// Two checkouts of instacloud-oss on the box: one shared and read-only, kept current so the detector
// can be run against it, and one scratch checkout per template that a bump is free to write to.
//
// The shared one is shared on purpose, unlike the per-job clones: those are writable and two agents
// sharing one overwrite each other, while this one is only ever read. Shared still means serialized,
// because a reset landing while another check is reading hands that check a half-updated tree.

import { posix } from 'node:path';
import { inspect } from 'node:util';

const REPO = 'https://github.com/InsForge/instacloud-oss.git';

// The same pattern as CODE in upstream.js and drift.js, so a code those accept is accepted here.
const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Seconds to wait for the lock. Not 120: `insta compute exec` cuts a command off at about 31 seconds
// (measured, the platform default is 30) and boxCommand in agent.js does not pass `--timeout`, so a
// longer wait dies as an opaque HTTP 502 and never reaches the message below. 15 leaves 13 of the
// 28 seconds in drift.js for the work, about 3x the 4.4 second cold run, and outlasts four warm
// checks (2.5 to 3.6 seconds each) in front of it. Do not restore 120 without passing `--timeout`.
const LOCK_WAIT_SECONDS = 15;

/** Beside the jobs, never inside one: it outlives every job and belongs to none of them. */
export const REGISTRY_DIR = '/data/work/registry';

// Beside the directory it guards, not inside it, because a clone refuses a directory that is not empty.
const LOCK_FILE = `${REGISTRY_DIR}.lock`;

/**
 * A scratch checkout for one bump, outside the shared read-only one.
 *
 * The shared checkout is read by every check, under a lock, and is never written. A bump writes,
 * commits and pushes, so it gets its own tree, and one per template so bumps of two different
 * templates cannot collide in the filesystem. Nothing serializes two bumps of the SAME template
 * yet, so whoever runs this script has to hold a lock around it.
 *
 * Throws on anything that is not a template code, because the result is handed to `rm -rf` and
 * `../registry` would name the shared checkout.
 */
export function bumpDir(code) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error(`${inspect(code)} is not a template code`);
  return `/data/work/bump/${code}`;
}

/**
 * Shell that leaves `bumpDir(code)` holding a writable, current, FULL checkout of main.
 *
 * Full, not shallow: `version-guard.mjs` in that repository compares a changed template against a
 * base ref, and there is nothing to compare against in a depth-1 clone.
 *
 * Discarded and recloned rather than reset: a previous attempt may have left a commit, a branch, a
 * conflicted merge or an interrupted rebase, and the cost measured on the box is about a second.
 */
export function cloneForBumpScript(code) {
  const dir = bumpDir(code);
  return [
    `rm -rf ${dir}`,
    `mkdir -p ${posix.dirname(dir)}`,
    `git clone --branch main ${REPO} ${dir} || exit 1`,
    `npm --prefix ${dir}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund || exit 1`,
  ].join('\n');
}

/**
 * Shell that leaves the registry current, from either a cold box or a warm one.
 *
 * `reset --hard` rather than `pull`: the tree is never edited here, so there is nothing to
 * preserve, and a force push upstream would leave a merge stuck forever.
 *
 * The lock is held by the shell itself, not a nested sh process, so it covers anything appended
 * after this script exits.
 *
 * The `rm -f` of the index lock is safe only because the flock is already held: a `reset --hard` cut
 * off by our own kill leaves that file behind for good, and a git still running would be holding
 * this flock too, through the descriptor it inherited.
 *
 * `--ignore-scripts` because whatever is on origin/main gets installed here, on a box with a push
 * token, and the detector needs js-yaml's files and nothing an install script would produce.
 */
export function refreshScript() {
  return [
    `mkdir -p ${posix.dirname(REGISTRY_DIR)}`,
    `exec 9>${LOCK_FILE}`,
    `flock -w ${LOCK_WAIT_SECONDS} 9 || { echo 'could not take the registry lock in ${LOCK_WAIT_SECONDS} seconds, another check is still running' >&2; exit 1; }`,
    `rm -f ${REGISTRY_DIR}/.git/index.lock`,
    `if [ ! -d ${REGISTRY_DIR}/.git ]; then`,
    `  git clone --depth 1 --branch main ${REPO} ${REGISTRY_DIR} || exit 1`,
    `fi &&`,
    `git -C ${REGISTRY_DIR} fetch --depth 1 origin main &&`,
    `git -C ${REGISTRY_DIR} reset --hard origin/main &&`,
    `npm --prefix ${REGISTRY_DIR}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund || exit 1`,
  ].join('\n');
}

// A read-only checkout of instacloud-oss, kept current so the detector can be run against it.
//
// Shared on purpose, unlike the per-job clones: those are writable and two agents sharing one
// overwrite each other, while this one is only ever read. Shared still means serialized, because
// a reset landing while another check is reading hands that check a half-updated tree.

import { posix } from 'node:path';

const REPO = 'https://github.com/InsForge/instacloud-oss.git';

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

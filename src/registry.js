// A read-only checkout of instacloud-oss, kept current so the detector can be run against it.
//
// Shared on purpose, unlike the per-job clones: those are writable and two agents sharing one
// overwrite each other, while this one is only ever read. Shared still means serialized, because
// a reset landing while another check is reading hands that check a half-updated tree.

const REPO = 'https://github.com/InsForge/instacloud-oss.git';

/** Beside the jobs, never inside one: it outlives every job and belongs to none of them. */
export const REGISTRY_DIR = '/data/work/registry';

/**
 * Shell that leaves the registry current, from either a cold box or a warm one.
 *
 * `reset --hard` rather than `pull`: the tree is never edited here, so there is nothing to
 * preserve, and a force push upstream would leave a merge stuck forever.
 *
 * The lock is held by the shell itself, not a nested sh process, so it covers anything appended
 * after this script exits.
 */
export function refreshScript() {
  return [
    `mkdir -p /data/work`,
    `exec 9>/data/work/registry.lock`,
    `flock -w 120 9 || exit 1`,
    `if [ ! -d ${REGISTRY_DIR}/.git ]; then`,
    `  git clone --depth 1 --branch main ${REPO} ${REGISTRY_DIR} || exit 1`,
    `fi &&`,
    `git -C ${REGISTRY_DIR} fetch --depth 1 origin main &&`,
    `git -C ${REGISTRY_DIR} reset --hard origin/main &&`,
    `npm --prefix ${REGISTRY_DIR}/templates install --omit=dev --loglevel=error --no-audit --no-fund || exit 1`,
  ].join('\n');
}

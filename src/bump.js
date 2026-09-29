// Moving one template forward, deterministically, and reading what the patcher decided.
//
// The edits are not repeated here. `check-upstreams.mjs --apply` in instacloud-oss resolves the
// upstream and writes the manifest and the Dockerfile together, or refuses and says why. This file
// builds the shell that runs it and reads the answer, and never second-guesses either. Nothing
// here runs anything: the script is handed to a caller that does.

import { posix } from 'node:path';
import { readDrift } from './drift.js';
import { bumpDir, cloneForBumpScript } from './registry.js';

// Seconds to wait for another bump of the same template. The channel cuts a command off at about 31
// seconds and drift.js kills at 28, so the wait and the work after it have to fit. Measured end to
// end against the real repository the script takes 2.5 to 5.4 seconds (n8n slowest, on its registry
// calls), so 15 leaves 13 for it and outlasts a whole run in front.
const LOCK_WAIT_SECONDS = 15;

/**
 * Shell that takes the lock, clones a fresh tree, and patches one template in it.
 *
 * The lock comes first and covers the clone, because `rm -rf` of a path that another bump is in the
 * middle of writing is the collision the lock exists for. The shell holds fd 9 until it exits, so
 * anything appended after the patcher runs under the same lock.
 *
 * The lock file sits beside the tree and not in it, because the tree is deleted on every run and a
 * lock deleted while held lets the next caller lock a new file and walk in.
 *
 * Throws on anything that is not a template code, from `bumpDir`, before any text is built.
 */
export function bumpScript(code) {
  const dir = bumpDir(code);
  return [
    `mkdir -p ${posix.dirname(dir)}`,
    `exec 9>${dir}.lock`,
    `flock -w ${LOCK_WAIT_SECONDS} 9 || { echo 'could not take the bump lock for ${code} in ${LOCK_WAIT_SECONDS} seconds, another bump is running' >&2; exit 1; }`,
    cloneForBumpScript(code),
    // `scripts` passes the code pattern and is a directory under templates/, but it is tooling. A
    // template is a directory with a manifest, which is what the patcher itself lists.
    `test -f ${dir}/templates/${code}/insta.template.yaml || { echo 'no such template: ${code}' >&2; exit 1; }`,
    `node ${dir}/templates/scripts/check-upstreams.mjs --json --apply ${code}`,
  ].join('\n');
}

/**
 * What the patcher decided, out of whatever else shared the stream.
 *
 * A refusal is an answer and carries its reason. The patcher also exits 1 whenever ANY template
 * could not be resolved, so a caller must read the output whatever the exit code was.
 */
export function readApply(stdout) {
  const { rows, error } = readDrift(stdout);
  if (error) return { error };
  // One code was asked for, so anything else means the patcher was not given the one we meant.
  if (rows.length !== 1) {
    return { error: `The patcher answered about ${rows.length} templates when asked about one, so the tree may hold edits nobody asked for.` };
  }
  const row = rows[0];
  // Before `current`: not being able to look is not the same as having nothing to do.
  if (row.unknown) return { error: `${row.code} could not be resolved: ${row.unknown}` };
  if (row.refused) return { refused: row.refused, code: row.code };
  if (row.current) return { current: true, code: row.code };
  if (!row.applied) return { error: `${row.code} is behind but the patcher wrote nothing, and gave no reason.` };
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

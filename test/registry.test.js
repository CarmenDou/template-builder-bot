import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { REGISTRY_DIR, refreshScript } from '../src/registry.js';

test('the first call clones, later ones fetch, and neither races the other', () => {
  const s = refreshScript();

  // The script must have valid shell syntax.
  assert.doesNotThrow(() => {
    execFileSync('sh', ['-n'], { input: s });
  }, 'the script has valid shell syntax');

  // The lock is taken using file descriptor form, not nested sh -c.
  // Use anchored line match to prevent matching a comment or partial string.
  assert.match(s, /^exec 9>/m, 'the lock is held by the shell via file descriptor');
  // 15 and not 120: the channel cuts a command off at about 31 seconds, and the wait has to end first.
  const lock = /^flock -w (\d+) 9 \|\| \{ echo '([^']+)' >&2; exit 1; \}$/m.exec(s);
  assert.ok(lock, 'the lock wait is bounded and says so on stderr when it gives up');
  assert.equal(lock[1], '15', 'the lock wait ends well before the 31 second channel cutoff');
  assert.equal(lock[2], 'could not take the registry lock in 15 seconds, another check is still running');
  assert.ok(!s.includes('sh -c'), 'no nested shell quote wrapping');

  // The lock is taken before any work: exec 9> and flock must come before git operations.
  const execIndex = s.indexOf('exec 9>');
  const flockIndex = s.indexOf('flock -w');
  const cloneIndex = s.indexOf('git clone');
  const fetchIndex = s.indexOf('fetch');
  const resetIndex = s.indexOf('reset --hard');
  const npmIndex = s.indexOf('npm');

  assert.ok(execIndex < flockIndex, 'exec 9> comes before flock');
  assert.ok(flockIndex < cloneIndex, 'lock is taken before clone');
  assert.ok(flockIndex < fetchIndex, 'lock is taken before fetch');
  assert.ok(flockIndex < resetIndex, 'lock is taken before reset');
  assert.ok(flockIndex < npmIndex, 'lock is taken before npm');

  // Cold box: clone shallow, with branch specified, and exits on failure.
  assert.match(s, /git clone --depth 1 --branch main .* \|\| exit 1/, 'clone fails cleanly on error');

  // Warm box: fetch and hard reset, so a force push upstream cannot leave it stuck.
  assert.match(s, /fetch --depth 1 origin main/);
  assert.match(s, /reset --hard origin\/main/);

  // The refresh chain must exit non-zero if any step fails, so the detector does not run on stale data.
  assert.match(s, /npm[^\n]*install[^\n]*\|\| exit 1$/, 'npm install failure exits the script');

  // Errors are visible: npm uses --loglevel=error, not --silent.
  assert.match(s, /--loglevel=error/, 'npm errors are not hidden');

  // Everything happens in the registry directory.
  assert.ok(s.includes(REGISTRY_DIR), 'all work is in the registry directory');
});

test('the registry lives beside the jobs, not inside one', () => {
  // A job's clone is its own, because two agents sharing one overwrite each other. This one is
  // read only and shared on purpose, so it must not sit under a job id.
  assert.match(REGISTRY_DIR, /^\/data\/work\//);
  assert.ok(!REGISTRY_DIR.includes('/jobs/') && !REGISTRY_DIR.includes('/data/work/jobs'), 'not inside the per-job tree');
});

test('the lock is one fixed file beside the directory it protects', () => {
  // This is the only line that makes two callers wait for each other. `exec 9>/data/work/lock-$$`
  // locks a different file in every process, so nothing is ever serialised and every other
  // assertion about the lock still holds. Inside the directory is no better: a clone refuses a
  // directory that is not empty, so the lock would have to be gone before the first run.
  const s = refreshScript();
  const held = /^exec 9>(\S+)$/m.exec(s);
  assert.ok(held, 'the lock file is opened on descriptor 9');
  assert.equal(held[1], `${REGISTRY_DIR}.lock`, 'the lock file is the registry directory plus .lock, the same in every process');
  assert.equal(posix.dirname(held[1]), posix.dirname(REGISTRY_DIR), 'beside the directory, not inside it');
  // Opening a file in a directory that does not exist fails, and on a cold box nothing else has made it.
  const made = /^mkdir -p (\S+)$/m.exec(s);
  assert.ok(made, 'the directory is made before the lock is opened');
  assert.equal(made[1], posix.dirname(held[1]), 'the directory made is the one the lock file is in');
  assert.ok(s.indexOf('mkdir -p') < s.indexOf('exec 9>'), 'mkdir comes before the lock is opened');
});

test('a stale index lock is cleared, but only once the flock is ours and before anything runs', () => {
  // Our own kill can cut a `reset --hard` off, and the tool never clears the file that leaves behind.
  const lines = refreshScript().split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const rm = at(/^rm -f /);
  assert.equal(lines[rm], `rm -f ${REGISTRY_DIR}/.git/index.lock`, 'the index lock of the registry checkout, and nothing else');
  assert.equal(lines.filter((l) => /\brm\b/.test(l)).length, 1, 'that is the only thing this script removes');
  // Before the flock it could delete the lock of a run that is in the middle of its reset right now.
  assert.ok(at(/^flock -w /) < rm, 'cleared after the flock is taken');
  for (const [what, re] of [['clone', /clone --depth/], ['fetch', /fetch --depth/], ['reset', /reset --hard/], ['npm', /^npm /]]) {
    assert.ok(rm < at(re), `cleared before ${what}`);
  }
});

test('the install runs no lifecycle script, whatever origin/main says', () => {
  // Every install script of every dependency, and the root package's own, would otherwise run here
  // on a box holding a push token, from whatever the default branch is at that moment.
  const npm = refreshScript()
    .split('\n')
    .filter((l) => /(^|\s)npm\s/.test(l));
  assert.equal(npm.length, 1, 'one npm command, so the assertion below covers all of them');
  const scripts = npm[0].split(/\s+/).filter((flag) => flag.includes('scripts'));
  assert.deepEqual(scripts, ['--ignore-scripts'], 'the flag is given as it is, not negated or set to false');
});

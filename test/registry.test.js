import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { REGISTRY_DIR, bumpDir, cloneForBumpScript, refreshScript } from '../src/registry.js';

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

test('a bump gets its own writable checkout, never the shared read-only one', () => {
  const dir = bumpDir('n8n');
  assert.ok(dir.startsWith('/data/work/'), 'beside the jobs and the registry');
  assert.ok(!dir.startsWith(`${REGISTRY_DIR}/`) && dir !== REGISTRY_DIR, 'not inside the shared checkout');
  assert.match(dir, /n8n/, 'one directory per template, so two templates cannot collide');
  assert.notEqual(bumpDir('n8n'), bumpDir('claude-code'), 'the path comes from the code, not from a constant');
});

test('bumpDir feeds rm -rf, so it refuses anything that is not a template code', () => {
  // '../registry' is the one that matters: it resolves to the shared checkout, and so does
  // 'claude-code/../../registry' once the claude-code scratch tree exists. A non-string is
  // refused too, because a one-element array or a number would otherwise pass the pattern as text.
  const refused = [
    '../registry', 'claude-code/../../registry', '..', '', '/etc', 'a/b', 'n8n; rm -rf /', 'n8n\n', 'N8N',
    '-rf', 'a-', '-a', 'a--a', 42, null, undefined, ['n8n'],
  ];
  for (const bad of refused) {
    assert.throws(() => bumpDir(bad), /is not a template code/, `bumpDir(${JSON.stringify(bad)}) throws`);
    assert.throws(() => cloneForBumpScript(bad), /is not a template code/, `no script is built for ${JSON.stringify(bad)}`);
  }
  for (const good of ['n8n', 'claude-code', 'whisper-turbo', '9router']) {
    assert.equal(bumpDir(good), `/data/work/bump/${good}`);
    assert.doesNotThrow(() => cloneForBumpScript(good));
  }
});

test('the character classes are pinned by sweep, because a list of examples cannot pin them', () => {
  // Loosening a class by one character passes every named case above and reopens the traversal:
  // `(-[a-z0-9./]+)*` admits 'claude-code/../../registry'. So every code unit is tried, and the
  // named cases stay because a failure there names the attack and this one names a number.
  const alnum = new Set('abcdefghijklmnopqrstuvwxyz0123456789');
  const refused = (s) => {
    try {
      bumpDir(s);
      return false;
    } catch (e) {
      return e instanceof Error && /is not a template code/.test(e.message);
    }
  };
  const accepted = (s) => {
    try {
      return bumpDir(s) === `/data/work/bump/${s}`;
    } catch {
      return false;
    }
  };

  const leaked = [];
  // Every refusal builds an Error, and capturing the stack is three quarters of the cost of 390,000 of them.
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    for (let u = 0; u <= 0xffff; u++) {
      const c = String.fromCharCode(u);
      if (alnum.has(c)) continue;
      // After a letter, before one, after a hyphen segment, right after a hyphen, and alone.
      const shapes = [`a${c}`, `${c}a`, `a-a${c}`, `a-${c}a`, c];
      // Between two letters, where a separator other than the hyphen would sit. A hyphen there is a code.
      if (c !== '-') shapes.push(`a${c}a`);
      for (const s of shapes) {
        if (!refused(s)) leaked.push(`code unit ${u} in ${JSON.stringify(s)}`);
      }
    }
  } finally {
    Error.stackTraceLimit = stackLimit;
  }
  assert.equal(leaked.length, 0, `${leaked.length} strings were accepted, the first: ${leaked.slice(0, 3).join(', ')}`);

  // The other direction: a letter or digit dropped from either class would refuse a real code.
  const dropped = [];
  for (const c of alnum) {
    for (const s of [`a-${c}`, `${c}-a`, c]) if (!accepted(s)) dropped.push(JSON.stringify(s));
  }
  // Two hyphens, which a pattern that allows at most one refuses.
  if (!accepted('a-b-c')) dropped.push('"a-b-c"');
  assert.equal(dropped.length, 0, `${dropped.length} valid codes were refused, the first: ${dropped.slice(0, 5).join(', ')}`);
});

test('the clone is full, current and its own', () => {
  const s = cloneForBumpScript('n8n');
  const lines = s.split('\n');
  // Not --depth 1: version-guard compares against a base ref and a shallow clone has no history.
  assert.doesNotMatch(s, /--depth/, 'a bump needs history that version-guard can compare against');
  assert.match(s, /clone/);
  assert.match(s, /--branch main/, 'the same branch the clone, fetch and reset all name');
  // The whole line, so a dropped `|| exit 1` or an added --shallow-since is a failure and not a pass.
  const clone = `git clone --branch main https://github.com/InsForge/instacloud-oss.git ${bumpDir('n8n')} || exit 1`;
  assert.ok(lines.includes(clone), 'the clone line is exactly this, and a failed clone stops the script');
  // The same for the install, which is the line that runs npm on a box holding a push token.
  const install = `npm --prefix ${bumpDir('n8n')}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund || exit 1`;
  assert.ok(lines.includes(install), 'the install line is exactly this, into templates/ of this checkout, and a failed install stops the script');
  assert.ok(lines.indexOf(clone) < lines.indexOf(install), 'installed after the clone, into the tree it made');
  // Left over from a previous attempt is the normal case, not the exception.
  assert.match(s, new RegExp(`rm -rf ${bumpDir('n8n')}`), 'a stale scratch tree is discarded first');
  assert.ok(s.indexOf('rm -rf') < s.indexOf('clone'), 'discarded before the clone, not after');
  assert.deepEqual(lines.filter((l) => /\brm\b/.test(l)), [`rm -rf ${bumpDir('n8n')}`], 'the only thing removed is this template\'s own tree');
  assert.match(s, /install/, 'the patcher needs js-yaml');
  assert.match(s, /--ignore-scripts/, 'lifecycle scripts do not run on a box holding a push token');
  assert.ok(!s.includes(REGISTRY_DIR), 'the shared checkout appears nowhere in the script, in any form');
  const other = cloneForBumpScript('claude-code');
  assert.ok(other.includes(bumpDir('claude-code')) && !other.includes(bumpDir('n8n')), 'the script is for the code it was given');
});

test('the bump install runs no lifecycle script either', () => {
  const npm = cloneForBumpScript('n8n')
    .split('\n')
    .filter((l) => /(^|\s)npm\s/.test(l));
  assert.equal(npm.length, 1, 'one npm command, so the assertion below covers all of them');
  const scripts = npm[0].split(/\s+/).filter((flag) => flag.includes('scripts'));
  assert.deepEqual(scripts, ['--ignore-scripts'], 'the flag is given as it is, not negated or set to false');
});

test('the produced shell parses', () => {
  execFileSync('sh', ['-n'], { input: cloneForBumpScript('claude-code') });
});

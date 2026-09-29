import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { REGISTRY_DIR, bumpDir, cloneForBumpScript } from '../src/registry.js';
import { bumpScript, readApply } from '../src/bump.js';

// What the patcher printed for a real run of `--json --apply n8n`, kept whole: the extra fields are
// part of the shape, and a reader that leaked them or leaned on them would otherwise pass.
const N8N = {
  code: 'n8n',
  kind: 'docker-tag',
  from: '2.36.5',
  to: '2.42.0',
  comparable: true,
  level: 'minor',
  digest: 'sha256:862c954d784885f0406b19d9ee8f6a2ec9f93e976e2a6580ad85dedd58463bb1',
  applied: { from: '1.3.2', to: '1.4.0' },
};
const LAYA = {
  code: 'laya',
  kind: 'git-commit',
  from: 'c9dcaab6da74ce5c34a66ef84f2503c77e4e619a',
  to: 'd113dca2512fb3eaca313534bc54c7162d87c1d4',
  comparable: false,
  level: null,
  applied: { from: '0.2.0', to: '0.2.1' },
};
const OPENCLAW = { code: 'openclaw', kind: 'docker-digest', unknown: 'a tag pinned by digest needs a registry token to re-resolve' };
const printed = (...rows) => JSON.stringify(rows, null, 2);

// ---- the script, as text ------------------------------------------------------------------------

test('the lock is taken first, on a file that belongs to this template alone', () => {
  const dir = bumpDir('n8n');
  const lines = bumpScript('n8n').split('\n');
  // Nothing but the preparation of the lock may come before it, or that work is not covered by it.
  assert.deepEqual(lines.slice(0, 2), [`mkdir -p ${posix.dirname(dir)}`, `exec 9>${dir}.lock`]);
  const lock = /^flock -w (\d+) 9 \|\| \{ echo '([^']+)' >&2; exit 1; \}$/.exec(lines[2]);
  assert.ok(lock, 'a bounded wait on the same descriptor, that says so on stderr when it gives up');
  // 15 and not 120: the channel cuts a command off at about 31 seconds and the wait has to end first.
  assert.equal(lock[1], '15', 'the wait ends well before the 31 second channel cutoff');
  assert.equal(lock[2], 'could not take the bump lock for n8n in 15 seconds, another bump is running');
});

test('the lock is one fixed file per template, beside its tree and never the registry lock', () => {
  const held = (code) => /^exec 9>(\S+)$/m.exec(bumpScript(code))[1];
  assert.equal(held('n8n'), held('n8n'), 'the same in every call, so two callers meet on one file');
  assert.equal(bumpScript('n8n'), bumpScript('n8n'), 'nothing in the text differs between two calls');
  assert.notEqual(held('n8n'), held('claude-code'), 'keyed on the template, so two templates do not queue');
  assert.equal(held('claude-code'), `${bumpDir('claude-code')}.lock`);
  // A tree is deleted on every run, and a lock inside it would go with it while held.
  assert.ok(!held('n8n').startsWith(`${bumpDir('n8n')}/`), 'not inside the tree it guards');
  assert.equal(posix.dirname(held('n8n')), posix.dirname(bumpDir('n8n')), 'beside it');
  // Sharing the registry's would make a bump wait for a read only check, and the reverse.
  assert.notEqual(held('n8n'), `${REGISTRY_DIR}.lock`, 'not the lock the read only checks take');
});

test('after the lock: the clone whole, the check that it is a template, then the patcher', () => {
  const dir = bumpDir('n8n');
  const rest = bumpScript('n8n').split('\n').slice(3);
  const clone = cloneForBumpScript('n8n').split('\n');
  assert.deepEqual(rest.slice(0, clone.length), clone, 'the clone script goes in as tested, and a failure in it stops the run');
  assert.deepEqual(rest.slice(clone.length), [
    `test -f ${dir}/templates/n8n/insta.template.yaml || { echo 'no such template: n8n' >&2; exit 1; }`,
    // The whole line: the flags decide what gets written, and there is no other argument.
    `node ${dir}/templates/scripts/check-upstreams.mjs --json --apply n8n`,
  ]);
  const other = bumpScript('claude-code');
  assert.ok(other.includes(bumpDir('claude-code')) && !other.includes(bumpDir('n8n')), 'the script is for the code it was given');
});

test('it never touches the shared checkout, and removes only its own tree', () => {
  const s = bumpScript('n8n');
  assert.ok(!s.includes(REGISTRY_DIR), 'the shared checkout appears nowhere in the script, in any form');
  assert.deepEqual(s.split('\n').filter((l) => /\brm\b/.test(l)), [`rm -rf ${bumpDir('n8n')}`]);
  assert.equal(s.match(/--apply/g).length, 1, 'one patch, of one template');
});

test('a code reaches a shell and a path, so anything but a template code is refused before text is built', () => {
  // Each is `--apply` or a traversal or an injection, and bumpDir is what answers for all of them.
  for (const bad of ['--apply', '-x', '', '../registry', 'claude-code/../../registry', 'n8n; rm -rf /', 'n8n\n--apply', "a'b", '$(id)', 'N8N', null, undefined, ['n8n'], 42]) {
    assert.throws(() => bumpScript(bad), /is not a template code/, JSON.stringify(bad));
  }
  // `scripts` has the shape of a code and is a real directory that is not a template. Only the
  // clone can say so, which is what the check in the script is for.
  assert.doesNotThrow(() => bumpScript('scripts'));
});

test('the produced shell parses', () => {
  for (const code of ['n8n', 'claude-code', 'scripts']) {
    const r = spawnSync('sh', ['-n'], { input: bumpScript(code), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

// ---- the script, run ----------------------------------------------------------------------------
//
// The same text under a real sh, with `/data/work` moved into a temp dir and the four commands that
// need a network or a box stood in for. Each stand-in records how it was called, and whether
// descriptor 9 was open in it, by writing to that descriptor: what it wrote lands in the lock file
// only if the descriptor is open and is that file.

const FIXTURE = {
  'templates/n8n/insta.template.yaml': 'version: 1.3.2\n',
  'templates/claude-code/insta.template.yaml': 'version: 1.0.0\n',
  'templates/scripts/check-upstreams.mjs': '// stands in for the patcher\n',
  'templates/scripts/lint.mjs': '// tooling in a directory, not a template\n',
};

const PREAMBLE = [
  'name=$(basename "$0")',
  'if { echo "$name" >&9; } 2>/dev/null; then state=held; else state=free; fi',
  'log() { echo "$name $* [$state]" >> "$STUB_LOG"; }',
].join('\n');

const STUBS = {
  flock: ['log "$@"', 'exit "${STUB_FLOCK_EXIT:-0}"'],
  npm: ['log "$@"', 'echo "added 2 packages in 248ms"', 'exit "${STUB_NPM_EXIT:-0}"'],
  // A clone refuses a directory that is not empty, and copies the fixture into one that is.
  git: [
    'log "$@"',
    'for dest; do :; done',
    'if [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then echo "fatal: destination path \'$dest\' already exists and is not an empty directory." >&2; exit 128; fi',
    'if [ "${STUB_CLONE_EXIT:-0}" != 0 ]; then echo "fatal: unable to access the remote" >&2; exit "$STUB_CLONE_EXIT"; fi',
    'mkdir -p "$dest" && cp -R "$STUB_FIXTURE/." "$dest"',
  ],
  node: [
    'if [ -f "$1" ]; then state="$state script-present"; else state="$state script-absent"; fi',
    'log "$@"',
    'printf "%s\\n" "$STUB_PATCHER_OUT"',
    'if [ -n "$STUB_PATCHER_ERR" ]; then echo "$STUB_PATCHER_ERR" >&2; fi',
    'exit "${STUB_PATCHER_STATUS:-0}"',
  ],
};

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'bump-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, body, mode) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, { mode });
  };
  for (const [file, body] of Object.entries(FIXTURE)) await put(join(root, 'fixture', file), body);
  for (const [name, lines] of Object.entries(STUBS)) await put(join(root, 'bin', name), `#!/bin/sh\n${PREAMBLE}\n${lines.join('\n')}\n`, 0o755);
  return { root, work: join(root, 'work'), tree: (code) => join(root, 'work/bump', code), lock: (code) => join(root, 'work/bump', `${code}.lock`) };
}

/** Runs the script for `code` and returns what happened, without throwing on a non-zero exit. */
async function run(sb, code, env = {}) {
  const script = bumpScript(code).replaceAll('/data/work', sb.work);
  // Nothing that runs here may reach outside the temp dir, whatever a mutation does to the text.
  assert.ok(!script.includes('/data'), 'nothing in the script reaches outside the sandbox');
  for (const line of script.split('\n')) {
    if (/\brm\b/.test(line)) assert.ok(line.includes(sb.root), `an rm outside the sandbox: ${line}`);
  }
  const log = join(sb.root, 'log');
  const r = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: `${join(sb.root, 'bin')}:/usr/bin:/bin`, STUB_LOG: log, STUB_FIXTURE: join(sb.root, 'fixture'), ...env },
  });
  const read = (file) => readFile(file, 'utf8').catch(() => '');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: (await read(log)).split('\n').filter(Boolean),
    // What the stand-ins wrote to descriptor 9: one line for each that had it open.
    heldBy: (await read(sb.lock(code))).split('\n').filter(Boolean),
  };
}

test('run for real: it locks, clones, installs and patches, in that order, all under the lock', async (t) => {
  for (const code of ['n8n', 'claude-code']) {
    const sb = await sandbox(t);
    const tree = sb.tree(code);
    const cold = await run(sb, code, { STUB_PATCHER_OUT: printed({ ...N8N, code }), STUB_PATCHER_STATUS: '1' });
    // The patcher exits 1 when ANY template is unresolved, and here it also wrote a patch.
    assert.deepEqual(cold.calls, [
      'flock -w 15 9 [held]',
      `git clone --branch main https://github.com/InsForge/instacloud-oss.git ${tree} [held]`,
      `npm --prefix ${tree}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund [held]`,
      `node ${tree}/templates/scripts/check-upstreams.mjs --json --apply ${code} [held script-present]`,
    ]);
    // Each of those wrote to descriptor 9, so the descriptor was the code's own lock file throughout.
    assert.deepEqual(cold.heldBy, ['flock', 'git', 'npm', 'node']);
    // The rows come back on stdout with an npm line in front of them, and a non-zero exit does not hide them.
    assert.equal(cold.status, 1);
    assert.equal(readApply(cold.stdout).applied.code, code);
    assert.equal(await readFile(join(tree, 'templates', code, 'insta.template.yaml'), 'utf8'), FIXTURE[`templates/${code}/insta.template.yaml`]);
  }
});

test('run for real: whatever an earlier attempt left is discarded first, and only for this template', async (t) => {
  const sb = await sandbox(t);
  // A killed run leaves a tree that looks like a valid checkout, and nothing marks it unfinished.
  await mkdir(join(sb.tree('n8n'), '.git'), { recursive: true });
  await writeFile(join(sb.tree('n8n'), 'templates-edited-by-a-killed-run'), 'half written');
  await mkdir(sb.tree('claude-code'), { recursive: true });
  await writeFile(join(sb.tree('claude-code'), 'keep'), 'another template, another bump');
  await writeFile(sb.lock('claude-code'), 'not ours');
  const out = await run(sb, 'n8n', { STUB_PATCHER_OUT: printed(N8N), STUB_PATCHER_STATUS: '1' });
  assert.equal(readApply(out.stdout).applied.code, 'n8n', out.stderr);
  const left = await readFile(join(sb.tree('n8n'), 'templates-edited-by-a-killed-run'), 'utf8').catch(() => null);
  assert.equal(left, null, 'nothing of the earlier tree survives into this one');
  assert.equal(await readFile(join(sb.tree('claude-code'), 'keep'), 'utf8'), 'another template, another bump');
  assert.equal(await readFile(sb.lock('claude-code'), 'utf8'), 'not ours', 'another template\'s lock is not touched');
});

test('run for real: when the lock cannot be had, nothing else happens and it says so', async (t) => {
  const sb = await sandbox(t);
  // The tree a running bump is in the middle of writing. Deleting it is what the lock is for.
  await mkdir(sb.tree('n8n'), { recursive: true });
  await writeFile(join(sb.tree('n8n'), 'being-written-by-the-other-bump'), 'x');
  const out = await run(sb, 'n8n', { STUB_FLOCK_EXIT: '1' });
  assert.equal(out.status, 1);
  assert.equal(out.stderr, 'could not take the bump lock for n8n in 15 seconds, another bump is running\n');
  assert.deepEqual(out.calls, ['flock -w 15 9 [held]'], 'not a clone, an install or a patch');
  assert.equal(await readFile(join(sb.tree('n8n'), 'being-written-by-the-other-bump'), 'utf8'), 'x', 'and the tree is not removed');
  // What the reader makes of it is a sentence with the reason, not a parse failure.
  assert.match(readApply(out.stderr).error, /another bump is running/);
  assert.equal(readApply(out.stderr).applied, undefined);
});

test('run for real: a failed clone or install stops the run where it failed', async (t) => {
  const clone = (sb) => `git clone --branch main https://github.com/InsForge/instacloud-oss.git ${sb.tree('n8n')} [held]`;
  const install = (sb) => `npm --prefix ${sb.tree('n8n')}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund [held]`;
  // The patcher would answer happily if it were reached, so reaching it is what these look for.
  const patcher = { STUB_PATCHER_OUT: printed(N8N), STUB_PATCHER_STATUS: '0' };

  // A failed clone leaves no tree, and running on would end in "no such template" for a template
  // that exists. So it has to stop at the clone, and the reason the person reads is the clone's.
  const noClone = await sandbox(t);
  const a = await run(noClone, 'n8n', { STUB_CLONE_EXIT: '128', ...patcher });
  assert.notEqual(a.status, 0);
  assert.deepEqual(a.calls, ['flock -w 15 9 [held]', clone(noClone)], 'nothing after the clone');
  assert.doesNotMatch(a.stderr, /no such template/);
  assert.match(readApply(a.stderr).error, /did not answer with json: fatal: unable to access the remote/);

  const noInstall = await sandbox(t);
  const b = await run(noInstall, 'n8n', { STUB_NPM_EXIT: '1', ...patcher });
  assert.notEqual(b.status, 0);
  assert.deepEqual(b.calls, ['flock -w 15 9 [held]', clone(noInstall), install(noInstall)], 'no patcher after a failed install');
  assert.equal(readApply(b.stdout).applied, undefined, 'and nothing reads as applied');
});

test('run for real: a directory that is not a template is said so, and the patcher never runs', async (t) => {
  // `scripts` is a directory of tooling under templates/ with the shape of a code.
  const sb = await sandbox(t);
  const out = await run(sb, 'scripts', { STUB_PATCHER_OUT: printed(N8N), STUB_PATCHER_STATUS: '0' });
  assert.equal(out.status, 1);
  assert.equal(out.stderr, 'no such template: scripts\n');
  assert.ok(!out.calls.some((c) => c.startsWith('node ')), 'the patcher was not asked about it');
  assert.equal(readApply(out.stderr).error, 'There is no template called scripts.');
  // A code that is not in the clone at all is the same answer.
  const gone = await run(await sandbox(t), 'whisper-turbo', { STUB_PATCHER_OUT: printed(N8N) });
  assert.equal(gone.stderr, 'no such template: whisper-turbo\n');
  assert.ok(!gone.calls.some((c) => c.startsWith('node ')));
});

// ---- reading the answer -------------------------------------------------------------------------

test('a patched template reports what moved, upstream and ours, each the right way round', () => {
  assert.deepEqual(readApply(printed(N8N)), {
    applied: {
      code: 'n8n',
      kind: 'docker-tag',
      level: 'minor',
      upstream: { from: '2.36.5', to: '2.42.0' },
      version: { from: '1.3.2', to: '1.4.0' },
    },
  });
  // A commit has no level, and that is null and not a missing field.
  const laya = readApply(printed(LAYA)).applied;
  assert.equal(laya.level, null);
  assert.equal(laya.kind, 'git-commit');
  assert.deepEqual(laya.upstream, { from: LAYA.from, to: LAYA.to });
  assert.deepEqual(laya.version, { from: '0.2.0', to: '0.2.1' });
  // And when the field is absent altogether, which is the same answer.
  assert.equal(readApply(printed({ ...LAYA, level: undefined })).applied.level, null);
});

test('a refusal is an answer, with its whole reason, and nothing was patched', () => {
  // The patcher refuses rather than half-editing whenever a file is not what the drift was read
  // from. Four rounds of review in the oss repository paid for that, and it must reach the person
  // who asked instead of reading as a crash. The row still carries the move it declined.
  const reason = "the Dockerfile does not hold 'c9dcaab6da74ce5c34a66ef84f2503c77e4e619a' in a build arg, so there is nothing here this can move confidently";
  const out = readApply(printed({ ...LAYA, applied: undefined, refused: reason }));
  assert.deepEqual(out, { refused: reason, code: 'laya' });
});

test('a template that is already current is neither a failure nor a patch', () => {
  assert.deepEqual(readApply(printed({ code: 'pi', kind: 'npm', current: true })), { current: true, code: 'pi' });
});

test('an unresolved template is an error with its reason, and is not read as current', () => {
  // openclaw is pinned by digest and cannot be resolved without a registry token. Reading that as
  // "nothing to do" would be a confident wrong answer.
  const out = readApply(printed(OPENCLAW));
  assert.equal(out.error, `openclaw could not be resolved: ${OPENCLAW.unknown}`);
  assert.equal(out.current, undefined);
  assert.equal(out.applied, undefined);
  assert.equal(out.refused, undefined);
});

test('a template that is behind and was neither patched nor refused is an error, as when --apply is lost', () => {
  const out = readApply(printed({ ...N8N, applied: undefined }));
  assert.equal(out.error, 'n8n is behind but the patcher wrote nothing, and gave no reason.');
  assert.equal(out.applied, undefined);
  assert.equal(out.current, undefined);
});

test('an answer about anything but one template is not read as an answer about ours', () => {
  const two = readApply(printed(N8N, LAYA));
  assert.match(two.error, /2 templates when asked about one/);
  assert.equal(two.applied, undefined, 'the first row is not taken as if it were the only one');
  assert.match(readApply('[]').error, /no templates at all/);
  assert.equal(readApply('[]').current, undefined);
});

test('noise around the rows does not break the read, whatever brackets it carries', () => {
  // What a clone, an install and a later commit and push print. A commit says `[branch sha]`.
  const noise = [
    "Cloning into '/data/work/bump/n8n'...",
    'added 2 packages in 248ms',
    '[skip ci]',
    '[feat/n8n-2.42.0 1a2b3c4] n8n 2.36.5 -> 2.42.0',
  ].join('\n');
  for (const text of [`${noise}\n${printed(N8N)}\n`, `${printed(N8N)}\n${noise}\n`, `${noise}\n${printed(N8N)}\n${noise}\n`]) {
    assert.equal(readApply(text).applied.code, 'n8n');
    assert.equal(readApply(text).applied.upstream.to, '2.42.0');
  }
});

test('no json, or nothing at all, is an error that says what was said', () => {
  assert.match(readApply('sh: 1: node: not found\n').error, /did not answer with json: sh: 1: node: not found/i);
  assert.match(readApply('').error, /did not answer with json: \(nothing\)/i);
  assert.match(readApply(undefined).error, /did not answer with json: \(nothing\)/i);
  assert.match(readApply('[skip ci]\n').error, /did not answer with json/i);
  // A failed clone can print a page, and this lands in a chat reply.
  assert.ok(readApply('x'.repeat(5000)).error.length < 300);
  // Rows that are not objects are not rows.
  assert.match(readApply('[null]').error, /did not answer with json/i);
  assert.match(readApply('[1, 2]').error, /did not answer with json/i);
});

test('the words the script itself prints are read as answers', () => {
  assert.match(readApply('could not take the bump lock for n8n in 15 seconds, another bump is running\n').error, /another bump is running/);
  assert.equal(readApply('no such template: scripts\n').error, 'There is no template called scripts.');
});

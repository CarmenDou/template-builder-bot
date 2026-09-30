import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import vm from 'node:vm';
import { execInBox } from '../src/agent.js';
import { REGISTRY_DIR, bumpDir, cloneForBumpScript } from '../src/registry.js';
import { VERSION, bumpBranch, bumpScript, readApply, runBump } from '../src/bump.js';

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

const IDENTITY = 'template-builder <carmen.dou@insforge.dev>';
const SUBJECT = 'n8n 2.36.5 -> 2.42.0';
const PUSHED = 'feat/n8n-2.42.0';

// ---- the script, as text ------------------------------------------------------------------------

test('the lock is taken first, on a file that belongs to this template alone', () => {
  const dir = bumpDir('n8n');
  const lines = bumpScript('n8n').split('\n');
  // Nothing but the preparation of the lock may come before it, or that work is not covered by it.
  assert.deepEqual(lines.slice(0, 2), [`mkdir -p ${posix.dirname(dir)}`, `exec 9>${dir}.lock`]);
  // Status 1 is flock's own for a timeout and that is an answer, so it says so on stderr and exits 0.
  // Any other status is flock failing, which says nothing and is a fault.
  const lock = /^flock -w (\d+) 9 \|\| \{ \[ \$\? -eq 1 \] && \{ echo '([^']+)' >&2; exit 0; \}; exit 1; \}$/.exec(lines[2]);
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

// What follows the existence check, spelled out here and not built from the source's own pieces.
// The one line holding the version reader is checked on its own, further down.
const AFTER_THE_CHECK = (code) => {
  const dir = `/data/work/bump/${code}`;
  return [
    `out=$(node ${dir}/templates/scripts/check-upstreams.mjs --json --apply ${code})`,
    `printf '%s\\n' "$out"`,
    'READER',
    'from=${versions% *}',
    'to=${versions#* }',
    `cd ${dir} || exit 1`,
    `git diff --quiet -- templates/${code} && { echo 'the patcher reported a patch, but templates/${code} is unchanged, so there is nothing to commit' >&2; exit 1; }`,
    `branch=feat/${code}-$to`,
    'git checkout -B "$branch" || exit 1',
    `git add -- templates/${code} || exit 1`,
    `git -c gc.auto=0 -c core.hooksPath=/dev/null -c user.name=template-builder -c user.email=carmen.dou@insforge.dev commit -m "${code} $from -> $to" || exit 1`,
    'push=$(git push --force-with-lease -u origin "$branch" 2>&1); status=$?',
    `printf '%s\\n' "$push" >&2`,
    `[ $status -eq 0 ] || { printf '%s\\n' "$push" | grep -Eq '^ ! \\[(remote )?rejected\\]' && exit 0; exit 1; }`,
    'echo "PUSHED $branch"',
  ];
};

test('after the lock: the clone whole, the check that it is a template, the patcher, then the commit and the push', () => {
  for (const code of ['n8n', 'claude-code']) {
    const dir = bumpDir(code);
    const rest = bumpScript(code).split('\n').slice(3);
    const clone = cloneForBumpScript(code).split('\n');
    assert.deepEqual(rest.slice(0, clone.length), clone, 'the clone script goes in as tested, and a failure in it stops the run');
    const after = rest.slice(clone.length);
    assert.equal(after[0], `test -f ${dir}/templates/${code}/insta.template.yaml || { echo 'no such template: ${code}' >&2; exit 0; }`);
    // The reader is one line, matched here by its shape and run further down. Every other line is
    // compared whole below, the patcher's included: its flags decide what gets written.
    const reader =after.findIndex((l) => l.startsWith('versions='));
    assert.match(after[reader], /^versions=\$\(printf '%s\\n' "\$out" \| node -e '[^']+'\) \|\| \{ \[ \$\? -eq 10 \] && exit 0; exit 1; \}$/);
    const expected = AFTER_THE_CHECK(code).map((l) => (l === 'READER' ? after[reader] : l));
    assert.deepEqual(after.slice(1), expected);
  }
  const other = bumpScript('claude-code');
  assert.ok(other.includes(bumpDir('claude-code')) && !other.includes(bumpDir('n8n')), 'the script is for the code it was given');
});

test('it is ONE script under ONE lock, and the push is inside it', () => {
  // A second script would have a second lock, and the lock would be released between the two.
  const s = bumpScript('n8n');
  const lines = s.split('\n');
  const lock = lines.findIndex((l) => l.startsWith('flock '));
  assert.equal(s.match(/\bflock\b/g).length, 1, 'one flock');
  assert.equal(lines.filter((l) => l.startsWith('exec 9>')).length, 1);
  for (const cmd of ['git clone', 'npm --prefix', 'check-upstreams.mjs', 'git diff --quiet', 'git checkout', 'git add', ' commit -m', 'git push']) {
    const at = lines.findIndex((l) => l.includes(cmd) && !l.startsWith('flock '));
    assert.ok(at > lock, `${cmd} comes after the lock is taken`);
  }
  assert.ok(!/fd 9|9>&-|exec 9</.test(lines.slice(lock + 1).join('\n')), 'nothing lets the descriptor go before the end');
});

test('it never touches the shared checkout, and removes only its own tree', () => {
  const s = bumpScript('n8n');
  assert.ok(!s.includes(REGISTRY_DIR), 'the shared checkout appears nowhere in the script, in any form');
  assert.deepEqual(s.split('\n').filter((l) => /\brm\b/.test(l)), [`rm -rf ${bumpDir('n8n')}`]);
  assert.equal(s.match(/--apply/g).length, 1, 'one patch, of one template');
});

test('the commit stages one template directory, has a subject and nothing else, and no trailer of any kind', () => {
  const s = bumpScript('n8n');
  const adds = s.split('\n').filter((l) => /\bgit add\b/.test(l));
  assert.deepEqual(adds, ['git add -- templates/n8n || exit 1'], 'the one directory the patcher writes to, and nothing wider');
  assert.doesNotMatch(s, /\badd (-A|--all|-u|\.|-\S*A)/, 'the tree also holds node_modules and a lockfile npm rewrote');
  assert.doesNotMatch(s, /commit\s.*(-a\b|-am|--all|--amend|--allow-empty)/, 'nothing but what was staged');
  const commit = s.split('\n').filter((l) => /^git .* commit /.test(l));
  assert.equal(commit.length, 1);
  assert.equal(commit[0].match(/ -m /g).length, 1, 'one -m is one paragraph, a second is a body');
  assert.doesNotMatch(commit[0], / -F | --file|--template|--signoff| -s |--trailer|--cleanup/);
  assert.doesNotMatch(s, /Co-Authored-By|Signed-off-by|Generated with|Reviewed-by/i);
  assert.equal(s.match(/\bgit push\b/g).length, 1);
});

test('the refs: a branch is reset and not created, and the push says what it expects', () => {
  const s = bumpScript('n8n');
  assert.ok(s.includes('git checkout -B "$branch" || exit 1'), 'a branch left by a closed pull request must not wedge the next attempt');
  assert.ok(s.includes('push=$(git push --force-with-lease -u origin "$branch" 2>&1); status=$?'));
  assert.doesNotMatch(s.replace('--force-with-lease', ''), /--force|push -f|push .*\+/, 'never a plain force');
  assert.ok(s.includes('branch=feat/n8n-$to'));
  assert.equal(bumpBranch('n8n', { upstream: { to: '2.42.0' } }), 'feat/n8n-2.42.0', 'the name this process expects is the one the script spells');
});

test('the commit is made with the gc and the hooks off, and the identity the box has always committed as', () => {
  const [commit] = bumpScript('n8n').split('\n').filter((l) => /^git .* commit /.test(l));
  assert.match(commit, /^git -c gc\.auto=0 -c core\.hooksPath=\/dev\/null -c user\.name=template-builder -c user\.email=carmen\.dou@insforge\.dev commit -m "n8n \$from -> \$to" \|\| exit 1$/);
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

// ---- the version reader inside the script -------------------------------------------------------
//
// The script names a branch and writes a commit from the patcher's row before anything in this
// process has read it, so it checks the versions itself. This is the text of that reader, run: for
// real under node a few times, and in a vm with node's `-e` surroundings stood in for the many cases.

const readerText = (code = 'n8n') => /node -e '([^']+)'/.exec(bumpScript(code))[1];

function reader(input, code = 'n8n') {
  const out = { status: 0, stdout: '', stderr: '' };
  const done = Symbol('process.exit');
  const surroundings = {
    require: (name) => {
      assert.equal(name, 'fs', 'the reader needs nothing but fs');
      return { readFileSync: (fd) => (assert.equal(fd, 0, 'and reads stdin'), input) };
    },
    process: { exit: (status) => { out.status = status; throw done; } },
    console: { log: (...words) => { out.stdout += `${words.join(' ')}\n`; }, error: (...words) => { out.stderr += `${words.join(' ')}\n`; } },
  };
  try {
    vm.runInNewContext(readerText(code), surroundings);
  } catch (e) {
    if (e !== done) throw e;
  }
  return out;
}

// How the reader tells the script what it found: 0 with the versions, 10 for an answer with nothing
// to push, 1 for a fault.
const ANSWER = 10;
const FIELDS = ['from', 'to', 'applied.from', 'applied.to'];
const withField = (field, value) => {
  const row = structuredClone(N8N);
  if (field.startsWith('applied.')) row.applied[field.slice('applied.'.length)] = value;
  else row[field] = value;
  return row;
};
const UNSAFE = 'the patcher gave a version that is not safe to name a branch after\n';

test('the reader, under real node, prints the two versions of the row that patched this template', () => {
  const real = (input, code = 'n8n') => {
    const r = spawnSync(process.execPath, ['-e', readerText(code)], { input, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  assert.deepEqual(real(printed(N8N)), { status: 0, stdout: '2.36.5 2.42.0\n', stderr: '' });
  assert.deepEqual(real(printed(LAYA), 'laya'), { status: 0, stdout: `${LAYA.from} ${LAYA.to}\n`, stderr: '' });
  // And under real node an answer is what the vm says it is: 10 and silent, or 10 with the one reason.
  // Nothing at all is a fault, which is 1.
  assert.deepEqual(real(printed({ code: 'n8n', current: true })), { status: ANSWER, stdout: '', stderr: '' });
  assert.deepEqual(real(''), { status: 1, stdout: '', stderr: '' });
  assert.deepEqual(real(printed({ ...N8N, to: '2.42.0\n\nCo-Authored-By: x' })), { status: ANSWER, stdout: '', stderr: UNSAFE });
  assert.deepEqual(reader(printed(N8N)), real(printed(N8N)), 'the vm and node agree');
});

test('the reader prints the two versions of the one row that patched this template, and nothing else', () => {
  assert.deepEqual(reader(printed(N8N)), { status: 0, stdout: '2.36.5 2.42.0\n', stderr: '' });
  assert.equal(reader(printed(LAYA), 'laya').stdout, `${LAYA.from} ${LAYA.to}\n`);
  // Compact json, and a hyphen, a plus and a leading v, are all ordinary versions.
  assert.equal(reader(JSON.stringify([{ ...N8N, from: 'v1.0.0-rc.1+build.5', to: '2.1.235' }])).stdout, 'v1.0.0-rc.1+build.5 2.1.235\n');
});

test('the reader says silently that a row about this template is an answer, and that anything else is a fault', () => {
  const answer = { status: ANSWER, stdout: '', stderr: '' };
  const fault = { status: 1, stdout: '', stderr: '' };
  // Answers: the patcher looked, and said what it found.
  assert.deepEqual(reader(printed({ code: 'n8n', kind: 'docker-tag', current: true })), answer, 'current');
  // A refusal carries the move it declined, from and to and all, and that is not a patch.
  assert.deepEqual(reader(printed({ ...N8N, applied: undefined, refused: 'the Dockerfile does not hold it' })), answer, 'refused');
  assert.deepEqual(reader(printed({ ...OPENCLAW, code: 'n8n' })), answer, 'unresolved');
  // readApply reads unknown, then refused, then current, then applied, and so does this.
  assert.deepEqual(reader(printed({ ...N8N, refused: 'no' })), answer, 'refused beats applied');
  assert.deepEqual(reader(printed({ ...N8N, unknown: 'no route' })), answer, 'unresolved beats applied');
  assert.deepEqual(reader(printed({ ...N8N, current: true })), answer, 'current beats applied');
  // Faults: there is nothing the tool can say about them but that they happened.
  assert.deepEqual(reader(printed({ ...N8N, applied: undefined })), fault, 'behind and not applied');
  assert.deepEqual(reader(printed({ code: 'n8n' })), fault, 'a row that says nothing');
  assert.deepEqual(reader(printed({ ...N8N, code: 'pi' })), fault, 'a row about another template');
  assert.deepEqual(reader(printed({ code: 'pi', current: true })), fault, 'an answer about another template');
  assert.deepEqual(reader(printed(N8N, N8N)), fault, 'two rows');
  assert.deepEqual(reader(printed(N8N, LAYA)), fault, 'two rows, the first of them ours');
  assert.deepEqual(reader('[]'), fault);
  for (const junk of ['', 'not json', 'null', '{}', '"x"', '[null]', '[1]', '[[]]', `${printed(N8N)}\nPUSHED feat/n8n-2.42.0`, `PUSHED feat/n8n-2.42.0\n${printed(N8N)}`]) {
    assert.deepEqual(reader(junk), fault, JSON.stringify(junk));
  }
});

test('the reader refuses a version that is not a plain one, in any of the four, and says so as an answer', () => {
  const hostile = [
    '2.42.0\n\nCo-Authored-By: Someone <s@example.com>', // a body, and then a trailer
    '2.42.0\n',
    '1.0 2.0',
    '1.0;touch x',
    '$(id)',
    '`id`',
    '"; id; "',
    "1.0'",
    '1.0/../../x',
    '../x',
    '1.0\\n',
    '1.0|x',
    '1.0&x',
    '1.0>x',
    '*',
    '',
    ' ',
    'ｖ1.0',
    'é',
    `1.0${String.fromCharCode(0x2028)}`,
  ];
  for (const bad of hostile) {
    for (const field of FIELDS) {
      const r = reader(JSON.stringify([withField(field, bad)]));
      assert.equal(r.status, ANSWER, `${field} ${JSON.stringify(bad)}`);
      assert.equal(r.stdout, '', 'nothing is printed for the script to use');
      assert.equal(r.stderr, UNSAFE);
    }
  }
  for (const notAString of [2, 2.5, null, true, ['1.0'], { a: 1 }]) {
    for (const field of FIELDS) {
      const r = reader(JSON.stringify([withField(field, notAString)]));
      assert.equal(r.status, ANSWER, `${field} ${JSON.stringify(notAString)}`);
      assert.equal(r.stdout, '');
    }
  }
  for (const field of FIELDS) assert.equal(reader(JSON.stringify([withField(field, undefined)])).status, ANSWER, `no ${field}`);
  // An `applied` that is not even an object has no versions to check.
  assert.equal(reader(JSON.stringify([{ ...N8N, applied: true }])).status, ANSWER);
  // And the ordinary version passes in every one of the four.
  for (const field of FIELDS) assert.deepEqual(reader(JSON.stringify([withField(field, '1.0.0-rc.1+build.5')])).status, 0, field);
});

test('the reader accepts exactly the characters VERSION does, in each position, over all of ASCII and the line breaks', () => {
  const shapes = (ch) => [ch, `1${ch}`, `${ch}1`, `1${ch}1`];
  const chars = [...Array(128).keys(), 0x85, 0xa0, 0x2028, 0x2029, 0xfeff, 0xe9, 0xff56].map((c) => String.fromCharCode(c));
  for (const ch of chars) {
    for (const shape of shapes(ch)) {
      const want = VERSION.test(shape);
      // Each of the four in turn: the sweep is of the pattern, and which fields use it is above.
      for (const field of FIELDS) {
        const r = reader(JSON.stringify([withField(field, shape)]));
        assert.equal(r.status, want ? 0 : ANSWER, `${field} ${JSON.stringify(shape)}`);
        if (want && field === 'to') assert.equal(r.stdout, `2.36.5 ${shape}\n`);
      }
    }
  }
});

// ---- the script, run ----------------------------------------------------------------------------
//
// The same text under a real sh, with `/data/work` moved into a temp dir, and `flock` and `npm` and
// the patcher stood in for. git is REAL, against a bare repository in the temp dir that stands in
// for GitHub (an `insteadOf` rewrite points the script's own URL at it), so what a commit and a push
// do is not assumed. Each stand-in records how it was called, and whether descriptor 9 was open in
// it, by writing to that descriptor: what it wrote lands in the lock file only if the descriptor is
// open and is that file.

const FIXTURE = {
  'templates/n8n/insta.template.yaml': 'version: 1.3.2\n',
  'templates/n8n/Dockerfile': 'FROM n8nio/n8n:2.36.5\n',
  'templates/claude-code/insta.template.yaml': 'version: 1.0.0\n',
  'templates/claude-code/Dockerfile': 'FROM node:24\n',
  'templates/laya/insta.template.yaml': 'version: 0.2.0\n',
  'templates/laya/Dockerfile': 'ARG LAYA_REF=c9dcaab6da74ce5c34a66ef84f2503c77e4e619a\n',
  'templates/package-lock.json': '{}\n',
  'templates/scripts/check-upstreams.mjs': '// stands in for the patcher\n',
  'templates/scripts/lint.mjs': '// tooling in a directory, not a template\n',
};

// Three files whose blobs all start `17`, so a fresh clone holds three loose objects in the one
// object directory that `gc --auto` counts. Found by search, once.
const padding = () => {
  const out = {};
  for (let n = 0, found = 0; found < 3; n++) {
    const body = `padding ${n}\n`;
    const id = createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    if (id.startsWith('17')) out[`padding/${found++}`] = body;
  }
  return out;
};

const PREAMBLE = [
  'name=$(basename "$0")',
  'if { echo "$name" >&9; } 2>/dev/null; then state=held; else state=free; fi',
  'log() { echo "$name $* [$state]" >> "$STUB_LOG"; }',
].join('\n');

const STUBS = {
  flock: ['log "$@"', 'exit "${STUB_FLOCK_EXIT:-0}"'],
  // What npm does to a tree, when told to: rewrite the lockfile, and leave node_modules untracked.
  npm: [
    'log "$@"',
    'echo "added 2 packages in 248ms"',
    'if [ -n "$STUB_NPM_CHURN" ]; then echo "\\"churn\\": true" >> "$2/package-lock.json"; mkdir -p "$2/node_modules/left-pad" && echo x > "$2/node_modules/left-pad/index.js"; fi',
    'exit "${STUB_NPM_EXIT:-0}"',
  ],
  // The real git, after saying how it was called. A clone can be made to fail, the way a network
  // does, and so can any one step after it.
  git: [
    'log "$@"',
    'if [ "$1" = clone ] && [ "${STUB_CLONE_EXIT:-0}" != 0 ]; then echo "fatal: unable to access the remote" >&2; exit "$STUB_CLONE_EXIT"; fi',
    'for word; do case "$word" in checkout|add|commit|push) step=$word; break;; esac; done',
    'if [ -n "$STUB_GIT_FAIL" ] && [ "$step" = "$STUB_GIT_FAIL" ]; then echo "fatal: injected failure of $step $STUB_GIT_FAIL_SAYS" >&2; exit 128; fi',
    'exec "$REAL_GIT" "$@"',
  ],
  // `node -e` is the script's own reader and runs for real. Anything else is the patcher.
  node: [
    'if [ "$1" = -e ]; then log -e; exec "$REAL_NODE" "$@"; fi',
    'if [ -f "$1" ]; then state="$state script-present"; else state="$state script-absent"; fi',
    'log "$@"',
    // What the patcher does to the tree, when told to: append to files under templates/.
    'templates=$(dirname "$(dirname "$1")")',
    'for f in $STUB_PATCHER_TOUCH; do echo "edited by the stand-in patcher" >> "$templates/$f"; done',
    // Somebody else moving the branch on the remote while this bump is between its clone and its push.
    'if [ -n "$STUB_RACE_BRANCH" ]; then "$REAL_GIT" --git-dir="$STUB_REMOTE" update-ref "refs/heads/$STUB_RACE_BRANCH" "$STUB_RACE_TO"; fi',
    'printf "%s\\n" "$STUB_PATCHER_OUT"',
    'if [ -n "$STUB_PATCHER_ERR" ]; then echo "$STUB_PATCHER_ERR" >&2; fi',
    'exit "${STUB_PATCHER_STATUS:-0}"',
  ],
};

let gitPath;
const realGit = () => (gitPath ??= spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim());

const put = async (file, body, mode) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body, { mode });
};

// Nothing of the developer's own git configuration, and no identity unless a command brings one.
const isolated = (root) => ({
  HOME: join(root, 'home'),
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});
const GLOBAL_CONFIG = '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n';

// The repository every sandbox starts from, built once and copied: bare, holding the fixture on
// main, standing in for GitHub.
let seeded;
after(async () => {
  if (seeded) await rm(dirname(await seeded), { recursive: true, force: true });
});
function seedRemote() {
  seeded ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bump-seed-'));
    const env = { PATH: process.env.PATH, ...isolated(dir) };
    await mkdir(env.HOME, { recursive: true });
    await writeFile(env.GIT_CONFIG_GLOBAL, GLOBAL_CONFIG);
    const git = (cwd, ...args) => execFileSync(realGit(), args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const work = join(dir, 'fixture');
    for (const [file, body] of Object.entries({ ...FIXTURE, ...padding() })) await put(join(work, file), body);
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'the repository before any bump');
    git(dir, 'clone', '-q', '--bare', work, 'remote.git');
    return join(dir, 'remote.git');
  })();
  return seeded;
}

let rewriteChecked = false;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'bump-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const remote = join(root, 'remote.git');
  await cp(await seedRemote(), remote, { recursive: true });
  // The script's own URL is rewritten to the bare repository, so the script is the one that ships.
  const gitEnv = {
    ...isolated(root),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/InsForge/instacloud-oss.git',
  };
  await mkdir(gitEnv.HOME, { recursive: true });
  await writeFile(gitEnv.GIT_CONFIG_GLOBAL, GLOBAL_CONFIG);
  const env = { PATH: process.env.PATH, ...gitEnv };
  const git = (cwd, ...args) => execFileSync(realGit(), args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // git before 2.31 ignores GIT_CONFIG_COUNT, and then the script's clone would go to github.com.
  if (!rewriteChecked) {
    const resolved = git(root, 'ls-remote', '--get-url', 'https://github.com/InsForge/instacloud-oss.git').trim();
    assert.equal(resolved, remote, 'the URL the script clones is rewritten to the sandbox remote, so this git is new enough');
    rewriteChecked = true;
  }
  for (const [name, lines] of Object.entries(STUBS)) await put(join(root, 'bin', name), `#!/bin/sh\n${PREAMBLE}\n${lines.join('\n')}\n`, 0o755);
  return {
    root,
    work: join(root, 'work'),
    remote,
    tree: (code) => join(root, 'work/bump', code),
    lock: (code) => join(root, 'work/bump', `${code}.lock`),
    gitEnv,
    // Ask the remote a question, whole and then trimmed.
    raw: (...args) => git(root, '--git-dir', remote, ...args),
    ask: (...args) => git(root, '--git-dir', remote, ...args).trim(),
    // Put a branch on the remote the way an earlier attempt would have left it.
    async leave(branch, file = 'templates/n8n/insta.template.yaml') {
      const w = join(root, 'earlier-attempt');
      git(root, 'clone', '-q', remote, w);
      git(w, 'checkout', '-q', '-b', branch);
      await appendFile(join(w, file), 'left by an earlier attempt\n');
      git(w, '-c', 'user.name=earlier', '-c', 'user.email=earlier@example.com', 'commit', '-q', '-a', '-m', 'an earlier attempt');
      git(w, 'push', '-q', 'origin', branch);
      await rm(w, { recursive: true, force: true });
    },
    git,
  };
}

/** Runs `script` under sh, with `/data/work` moved, and returns what happened without throwing. */
async function exec(sb, script, env = {}) {
  const moved = script.replaceAll('/data/work', sb.work);
  // Nothing that runs here may reach outside the temp dir, whatever a mutation does to the text.
  assert.ok(!moved.includes('/data'), 'nothing in the script reaches outside the sandbox');
  for (const line of moved.split('\n')) {
    if (/\brm\b/.test(line)) assert.ok(line.includes(sb.root), `an rm outside the sandbox: ${line}`);
  }
  const log = join(sb.root, 'log');
  await rm(log, { force: true });
  // Only to end a hang, so it is far above anything healthy rather than near it. One outcome waits
  // out the real 15 second lock, and a loaded machine stretches every spawn here: at 20 seconds this
  // fired on runs that were fine, and reported it as `status: null`, which names neither the test
  // nor the cause. A hang does not finish at all, so a generous bound costs a healthy run nothing.
  const r = spawnSync('sh', ['-c', moved], { encoding: 'utf8', timeout: 120000, env: boxEnv(sb, env) });
  // spawnSync reports a timeout or a failure to spawn HERE, not in the status, which is then null.
  if (r.error) throw new Error(`the sandbox script did not finish: ${r.error.message}`);
  const read = (file) => readFile(file, 'utf8').catch(() => '');
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: (await read(log)).split('\n').filter(Boolean) };
}

/** What the box's shell has in its environment: the stand-ins first on the path, and where they log. */
const boxEnv = (sb, env = {}) => ({
  PATH: `${join(sb.root, 'bin')}:/usr/bin:/bin`,
  STUB_LOG: join(sb.root, 'log'),
  STUB_REMOTE: sb.remote,
  REAL_GIT: realGit(),
  REAL_NODE: process.execPath,
  ...sb.gitEnv,
  ...env,
});

const quoted = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * A stand-in for the `insta` binary, so the real `execInBox` can be pointed at the sandbox: it takes
 * the argv that `boxCommand` builds for `insta compute exec <service> -- sh -c <script>` and runs the
 * script under sh the way `exec` does, with the same refusals.
 */
async function instaStandIn(sb, env = {}) {
  const file = join(sb.root, 'insta');
  const vars = Object.entries(boxEnv(sb, env)).map(([k, v]) => `export ${k}=${quoted(v)}`);
  await put(
    file,
    [
      '#!/bin/sh',
      '[ "$1 $2 $4 $5 $6" = "compute exec -- sh -c" ] || { echo "unexpected argv: $*" >&2; exit 64; }',
      ...vars,
      `moved=$(printf '%s' "$7" | sed ${quoted(`s#/data/work#${sb.work}#g`)})`,
      'case "$moved" in */data*) echo "reaches outside the sandbox" >&2; exit 65;; esac',
      `printf '%s\\n' "$moved" | grep -E '\\brm\\b' | grep -v ${quoted(sb.root)} && { echo "an rm outside the sandbox" >&2; exit 66; }`,
      'exec sh -c "$moved"',
    ].join('\n'),
    0o755,
  );
  return file;
}

/** Runs the script for `code`, and adds what the stand-ins wrote to descriptor 9. */
async function run(sb, code, env = {}) {
  const out = await exec(sb, bumpScript(code), env);
  const read = (file) => readFile(file, 'utf8').catch(() => '');
  return { ...out, heldBy: (await read(sb.lock(code))).split('\n').filter(Boolean) };
}

/** `runBump` against the sandbox: a non-zero exit rejects, as it does from the real thing. */
const boxFor = (sb, env = {}, seen = []) => async (config, script, opts) => {
  const r = await exec(sb, script, env);
  seen.push({ config, opts, ran: r });
  if (r.status === 0) return { stdout: r.stdout, stderr: r.stderr };
  throw Object.assign(new Error('Command failed: sh -c ...'), { code: r.status, stdout: r.stdout, stderr: r.stderr, killed: false });
};

const bump = (sb, code, env, seen) => runBump({ box: 'config' }, code, { run: boxFor(sb, env, seen) });

/** What runBump said, and what the script under it did: `[answer, ran]`, `ran` with status, streams and calls. */
const both = async (sb, code, env) => {
  const seen = [];
  const answer = await bump(sb, code, env, seen);
  assert.equal(seen.length, 1, 'one exec');
  return [answer, seen[0].ran];
};

const PATCH = { STUB_PATCHER_OUT: printed(N8N), STUB_PATCHER_TOUCH: 'n8n/insta.template.yaml n8n/Dockerfile' };
const branches = (sb) => sb.ask('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
/** The message of a commit, whole, from the object itself: everything after its headers. */
const messageOf = (sb, ref) => {
  const object = sb.raw('cat-file', 'commit', ref);
  return object.slice(object.indexOf('\n\n') + 2);
};
const filesOf = (sb, ref) => sb.ask('diff-tree', '--no-commit-id', '--name-only', '-r', ref).split('\n').sort();

test('run for real: it locks, clones, installs, patches, commits and pushes, in that order, all under the lock', async (t) => {
  // A tag, a second template, and a git commit whose versions are forty characters each.
  const moves = [
    { code: 'n8n', row: N8N },
    { code: 'claude-code', row: { ...N8N, code: 'claude-code' } },
    { code: 'laya', row: LAYA },
  ];
  for (const { code, row } of moves) {
    const sb = await sandbox(t);
    const tree = sb.tree(code);
    const main = sb.ask('rev-parse', 'main');
    const touch = `${code}/insta.template.yaml ${code}/Dockerfile`;
    const cold = await run(sb, code, { STUB_PATCHER_OUT: printed(row), STUB_PATCHER_TOUCH: touch });
    const branch = `feat/${code}-${row.to}`;
    const subject = `${code} ${row.from} -> ${row.to}`;
    assert.deepEqual(cold.calls, [
      'flock -w 15 9 [held]',
      `git clone --branch main https://github.com/InsForge/instacloud-oss.git ${tree} [held]`,
      `npm --prefix ${tree}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund [held]`,
      `node ${tree}/templates/scripts/check-upstreams.mjs --json --apply ${code} [held script-present]`,
      'node -e [held]',
      `git diff --quiet -- templates/${code} [held]`,
      `git checkout -B ${branch} [held]`,
      `git add -- templates/${code} [held]`,
      `git -c gc.auto=0 -c core.hooksPath=/dev/null -c user.name=template-builder -c user.email=carmen.dou@insforge.dev commit -m ${subject} [held]`,
      `git push --force-with-lease -u origin ${branch} [held]`,
    ]);
    // Each of those wrote to descriptor 9, so the descriptor was the code's own lock file throughout.
    assert.deepEqual(cold.heldBy, ['flock', 'git', 'npm', 'node', 'node', 'git', 'git', 'git', 'git', 'git']);
    assert.equal(cold.status, 0);
    assert.equal(cold.stdout.trimEnd().split('\n').at(-1), `PUSHED ${branch}`, 'the last thing it says');
    // What landed on the remote: one commit on top of main, on the branch, and main untouched.
    assert.deepEqual(branches(sb), [branch, 'main']);
    assert.equal(sb.ask('rev-parse', 'main'), main, 'main is not moved');
    assert.equal(sb.ask('rev-parse', `${branch}^`), main, 'one commit, on top of main');
    assert.equal(sb.ask('rev-list', '--count', `main..${branch}`), '1');
    assert.equal(messageOf(sb, branch), `${subject}\n`, 'a subject, no body, no trailer');
    assert.equal(sb.ask('log', '-1', '--format=%an <%ae>|%cn <%ce>', branch), `${IDENTITY}|${IDENTITY}`);
    assert.deepEqual(filesOf(sb, branch), [`templates/${code}/Dockerfile`, `templates/${code}/insta.template.yaml`]);
    assert.match(await readFile(join(tree, 'templates', code, 'insta.template.yaml'), 'utf8'), /edited by the stand-in patcher/);
  }
});

test('run for real: runBump hands on what was applied and the branch that is on the remote', async (t) => {
  const sb = await sandbox(t);
  const seen = [];
  const out = await bump(sb, 'n8n', PATCH, seen);
  assert.deepEqual(out, {
    applied: {
      code: 'n8n',
      kind: 'docker-tag',
      level: 'minor',
      upstream: { from: '2.36.5', to: '2.42.0' },
      version: { from: '1.3.2', to: '1.4.0' },
    },
    branch: PUSHED,
  });
  assert.ok(branches(sb).includes(out.branch), 'the branch it names is on the remote');
  assert.equal(out.branch, bumpBranch('n8n', out.applied));
  assert.deepEqual(seen.map(({ config, opts }) => ({ config, opts })), [{ config: { box: 'config' }, opts: { timeoutMs: 28000 } }], 'one exec, with the box config and our own kill');
});

test('run for real: only templates/<code> is committed, whatever else the tree holds', async (t) => {
  const sb = await sandbox(t);
  // npm left the lockfile changed and node_modules untracked, as it does through a symlinked path,
  // and the patcher also wrote a file of another template.
  const out = await bump(sb, 'n8n', { ...PATCH, STUB_NPM_CHURN: '1', STUB_PATCHER_TOUCH: 'n8n/insta.template.yaml n8n/Dockerfile claude-code/Dockerfile' });
  assert.equal(out.branch, PUSHED);
  assert.deepEqual(filesOf(sb, PUSHED), ['templates/n8n/Dockerfile', 'templates/n8n/insta.template.yaml']);
  const tree = sb.tree('n8n');
  assert.match(await readFile(join(tree, 'templates/package-lock.json'), 'utf8'), /churn/, 'the lockfile really was changed in the tree');
  assert.deepEqual(await readdir(join(tree, 'templates/node_modules')), ['left-pad'], 'and node_modules really was there');
  assert.equal(sb.ask('show', `${PUSHED}:templates/package-lock.json`), '{}', 'and neither went to the remote');
});

test('run for real: nothing is committed when the patcher patched nothing, however dirty the tree', async (t) => {
  const churn = { STUB_NPM_CHURN: '1' };
  // Current, refused, unresolved and crashed. The lockfile is changed in each, so a check on the
  // whole tree sees a change and a check that stops at the row does not.
  // All three are answers, so the script exits 0 for each. The crash below is a fault, and does not.
  const cases = [
    ['current', { STUB_PATCHER_OUT: printed({ code: 'n8n', kind: 'docker-tag', current: true }) }, { current: true, code: 'n8n' }],
    ['refused', { STUB_PATCHER_OUT: printed({ ...N8N, applied: undefined, refused: 'the Dockerfile does not hold it' }) }, { refused: 'the Dockerfile does not hold it', code: 'n8n' }],
    ['unresolved', { STUB_PATCHER_OUT: printed({ ...OPENCLAW, code: 'n8n' }), STUB_PATCHER_STATUS: '1' }, { error: `n8n could not be resolved: ${OPENCLAW.unknown}` }],
  ];
  for (const [what, env, expected] of cases) {
    const sb = await sandbox(t);
    const [out, ran] = await both(sb, 'n8n', { ...churn, ...env });
    assert.deepEqual(out, expected, what);
    assert.equal(ran.status, 0, `${what}: an answer exits 0`);
    assert.deepEqual(branches(sb), ['main'], `${what}: nothing was pushed`);
    assert.ok(!ran.calls.some((c) => /^git (checkout|add|commit|push)/.test(c)), `${what}: not so much as a checkout`);
    assert.equal(ran.calls.at(-1), 'node -e [held]', `${what}: it stops at the reader`);
    assert.doesNotMatch(ran.stdout, /PUSHED/);
  }
  // The patcher died after writing a file, and printed nothing. Half a patch is not committed.
  const sb = await sandbox(t);
  const crash = { ...churn, STUB_PATCHER_TOUCH: 'n8n/insta.template.yaml', STUB_PATCHER_OUT: '', STUB_PATCHER_ERR: 'TypeError: boom', STUB_PATCHER_STATUS: '1' };
  const [out, ran] = await both(sb, 'n8n', crash);
  assert.equal(ran.status, 1, 'a crash is a fault');
  assert.ok(!ran.calls.some((c) => /^git (checkout|add|commit|push)/.test(c)));
  assert.match(out.error, /did not answer with json:[\s\S]*TypeError: boom/);
  assert.match(await readFile(join(sb.tree('n8n'), 'templates/n8n/insta.template.yaml'), 'utf8'), /edited by the stand-in/, 'control: the tree really was left edited');
  assert.deepEqual(branches(sb), ['main']);
});

test('run for real: a file the patcher left changed is not committed when its row says it refused', async (t) => {
  // The row is the patcher's own account, and a tree that disagrees with it is not evidence of a patch.
  const sb = await sandbox(t);
  const refused = { ...N8N, applied: undefined, refused: 'the Dockerfile does not hold it' };
  const out = await bump(sb, 'n8n', { STUB_PATCHER_OUT: printed(refused), STUB_PATCHER_TOUCH: 'n8n/insta.template.yaml' });
  assert.deepEqual(out, { refused: 'the Dockerfile does not hold it', code: 'n8n' });
  assert.deepEqual(branches(sb), ['main']);
});

test('run for real: a patch that changed nothing under the template is not committed, and says so', async (t) => {
  // The row says applied, and only the lockfile is dirty: the case a whole-tree check gets wrong.
  const sb = await sandbox(t);
  const [out, r] = await both(sb, 'n8n', { STUB_PATCHER_OUT: printed(N8N), STUB_NPM_CHURN: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^the patcher reported a patch, but templates\/n8n is unchanged, so there is nothing to commit$/m);
  assert.deepEqual(r.calls.slice(-2), ['node -e [held]', 'git diff --quiet -- templates/n8n [held]'], 'and nothing follows');
  assert.deepEqual(Object.keys(out), ['error'], 'a patch that was not pushed is not reported as one');
  assert.match(out.error, /^The patch was made on the box, but no branch was pushed: [\s\S]*templates\/n8n is unchanged/);
  assert.deepEqual(branches(sb), ['main']);
});

test('run for real: a version that is not a plain one never reaches a branch, a commit or a shell', async (t) => {
  // Nothing is ever pushed here, so one sandbox serves every case and the remote stays as it was.
  const sb = await sandbox(t);
  const pwned = join(sb.root, 'pwned');
  const hostile = [
    '2.42.0\n\nCo-Authored-By: Someone <s@example.com>',
    `1.0;touch ${pwned}`,
    `$(touch ${pwned})`,
    '',
  ];
  // All four, because the script pushes before the JS sees the row: a template version that is not
  // safe used to get a branch pushed and then be reported as never having been.
  for (const field of FIELDS) {
    for (const bad of hostile) {
      const env = { STUB_PATCHER_OUT: printed(withField(field, bad)), STUB_PATCHER_TOUCH: 'n8n/insta.template.yaml' };
      const label = `${field} ${JSON.stringify(bad)}`;
      const [out, r] = await both(sb, 'n8n', env);
      assert.equal(r.status, 0, `${label}: the refusal is an answer`);
      assert.ok(!r.calls.some((c) => /^git (checkout|add|commit|push)/.test(c)), `${label}: nothing was committed or pushed`);
      assert.equal(r.calls.at(-1), 'node -e [held]', `${label}: it stops at the reader`);
      assert.match(r.stderr, /not safe to name a branch after/, label);
      assert.deepEqual(Object.keys(out), ['error'], label);
      assert.match(out.error, /not a plain version string/, label);
    }
  }
  assert.deepEqual(branches(sb), ['main']);
  assert.deepEqual((await readdir(sb.root)).filter((n) => n === 'pwned'), [], 'nothing in any of them ran');
});

test('run for real: a branch an earlier attempt left is replaced, and a plain push would have been refused', async (t) => {
  // A pull request that was closed leaves its branch behind. That is the ordinary case.
  const sb = await sandbox(t);
  await sb.leave(PUSHED);
  const left = sb.ask('rev-parse', PUSHED);
  const main = sb.ask('rev-parse', 'main');
  // The control: an ordinary push of a new commit on main to that name is refused, so a script that
  // pushed plainly would end here and this test would not have been about the lease.
  const w = join(sb.root, 'control');
  sb.git(sb.root, 'clone', '-q', sb.remote, w);
  sb.git(w, 'checkout', '-q', '-B', PUSHED, 'main');
  await appendFile(join(w, 'templates/n8n/insta.template.yaml'), 'a new attempt\n');
  sb.git(w, '-c', 'user.name=c', '-c', 'user.email=c@example.com', 'commit', '-q', '-a', '-m', 'a new attempt');
  assert.throws(() => sb.git(w, 'push', '-q', 'origin', PUSHED), /rejected/);
  assert.equal(sb.ask('rev-parse', PUSHED), left, 'and the control left the branch alone');

  const out = await bump(sb, 'n8n', PATCH);
  assert.equal(out.branch, PUSHED);
  assert.notEqual(sb.ask('rev-parse', PUSHED), left, 'the branch moved');
  assert.equal(sb.ask('rev-parse', `${PUSHED}^`), main, 'to a single commit on main, not on top of the old attempt');
  assert.equal(sb.ask('rev-list', '--count', `main..${PUSHED}`), '1');
  assert.equal(messageOf(sb, PUSHED), `${SUBJECT}\n`);
  assert.deepEqual(branches(sb), [PUSHED, 'main']);
});

test('run for real: the lease refuses when somebody moved the branch after the clone, and it is not overwritten', async (t) => {
  // Somebody else pushes while this bump is between its clone and its push. Two shapes of it: the
  // branch was there at the clone and was moved, and it was not there and was created.
  for (const leftover of [true, false]) {
    const sb = await sandbox(t);
    if (leftover) await sb.leave(PUSHED);
    const racer = sb.ask('rev-parse', 'main');
    const env = { ...PATCH, STUB_RACE_BRANCH: PUSHED, STUB_RACE_TO: racer };
    const [out, ran] = await both(sb, 'n8n', env);
    assert.equal(ran.status, 0, `a lost lease is an answer, so it exits 0 and a retry never gets to win it, leftover ${leftover}`);
    assert.doesNotMatch(ran.stdout, /PUSHED/);
    assert.equal(out.branch, undefined, `leftover ${leftover}`);
    assert.equal(out.applied, undefined, 'a patch that was not pushed is not reported as one');
    assert.match(out.error, /no branch was pushed:[\s\S]*\[rejected\]/, `the reason is git's own, leftover ${leftover}`);
    assert.equal(sb.ask('rev-parse', PUSHED), racer, "the other person's branch is exactly as they left it");
  }
});

test('run for real: a push the remote refuses is an error with its reason, and no branch is claimed', async (t) => {
  const sb = await sandbox(t);
  await writeFile(join(sb.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "the remote says no" >&2\nexit 1\n', { mode: 0o755 });
  const [out, r] = await both(sb, 'n8n', PATCH);
  assert.deepEqual(Object.keys(out), ['error']);
  assert.match(out.error, /^The patch was made on the box, but no branch was pushed: [\s\S]*pre-receive hook declined/);
  assert.deepEqual(branches(sb), ['main']);
  assert.equal(r.status, 0, 'a ref the remote turned down is an answer, so it exits 0, and says no PUSHED');
  assert.doesNotMatch(r.stdout, /PUSHED/);
  assert.match(r.stderr, /^ ! \[remote rejected\]/m, 'and git\'s own status line is on stderr');
});

test('run for real: each step that fails stops the run there, and a push that failed is never reported as one', async (t) => {
  // Injected into git itself, since none of these fails on its own in a tree that is in order. The
  // steps are in the order the script takes them, and the last is the one that must not say PUSHED.
  const sb = await sandbox(t);
  const steps = ['checkout', 'add', 'commit', 'push'];
  for (const [i, step] of steps.entries()) {
    const [out, r] = await both(sb, 'n8n', { ...PATCH, STUB_GIT_FAIL: step });
    assert.notEqual(r.status, 0, step);
    assert.equal(r.calls.length, 7 + i, `${step}: nothing runs after the step that failed`);
    assert.match(r.calls.at(-1), new RegExp(`\\b${step}\\b`), step);
    assert.doesNotMatch(r.stdout, /PUSHED/, step);
    assert.match(r.stderr, new RegExp(`injected failure of ${step}`));
    assert.deepEqual(Object.keys(out), ['error'], step);
    assert.match(out.error, new RegExp(`^The patch was made on the box, but no branch was pushed: [\\s\\S]*injected failure of ${step}`), step);
  }
  assert.deepEqual(branches(sb), ['main'], 'and none of them left anything on the remote');
});

test('run for real: the commit leaves the repository alone, so no gc is left holding the lock', async (t) => {
  // `gc --auto` after a commit would keep the lock in a background process that inherited it. Armed
  // here: three loose objects in the directory it counts, a threshold of one, and no detaching so it
  // is finished by the time anything looks. The control is a commit without the flag.
  const armed = async (sb) => {
    await appendFile(sb.gitEnv.GIT_CONFIG_GLOBAL, '[gc]\n\tauto = 1\n\tautoDetach = false\n');
    const w = join(sb.root, 'control');
    sb.git(sb.root, 'clone', '-q', sb.remote, w);
    const loose = () => readdir(join(w, '.git/objects/17')).catch(() => []);
    assert.ok((await loose()).length >= 3, 'the trap is set: loose objects to pack');
    await appendFile(join(w, 'padding/0'), 'changed\n');
    sb.git(w, '-c', 'user.name=c', '-c', 'user.email=c@example.com', 'commit', '-q', '-a', '-m', 'control');
    assert.equal((await loose()).length, 0, 'control: an ordinary commit here does run gc');
  };
  const sb = await sandbox(t);
  await armed(sb);
  const out = await bump(sb, 'n8n', PATCH);
  assert.equal(out.branch, PUSHED);
  const left = await readdir(join(sb.tree('n8n'), '.git/objects/17'));
  assert.ok(left.length >= 3, 'the loose objects are still loose: gc did not run');
});

test('run for real: whatever an earlier attempt left is discarded first, and only for this template', async (t) => {
  const sb = await sandbox(t);
  // A killed run leaves a tree that looks like a valid checkout, and nothing marks it unfinished.
  await mkdir(join(sb.tree('n8n'), '.git'), { recursive: true });
  await writeFile(join(sb.tree('n8n'), 'templates-edited-by-a-killed-run'), 'half written');
  await mkdir(sb.tree('claude-code'), { recursive: true });
  await writeFile(join(sb.tree('claude-code'), 'keep'), 'another template, another bump');
  await writeFile(sb.lock('claude-code'), 'not ours');
  const out = await bump(sb, 'n8n', PATCH);
  assert.equal(out.applied?.code, 'n8n', JSON.stringify(out));
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
  const [said, out] = await both(sb, 'n8n', { ...PATCH, STUB_FLOCK_EXIT: '1' });
  assert.equal(out.status, 0, 'the lock being held is an answer');
  assert.equal(out.stderr, 'could not take the bump lock for n8n in 15 seconds, another bump is running\n');
  assert.deepEqual(out.calls, ['flock -w 15 9 [held]'], 'not a clone, an install, a patch, a commit or a push');
  assert.equal(await readFile(join(sb.tree('n8n'), 'being-written-by-the-other-bump'), 'utf8'), 'x', 'and the tree is not removed');
  assert.deepEqual(branches(sb), ['main']);
  // What the reader makes of it is a sentence with the reason, not a parse failure.
  assert.match(readApply(out.stderr, 'n8n').error, /another bump is running/);
  // The box answered, so the reply is its sentence and not "did not answer with json".
  assert.deepEqual(said, { error: 'could not take the bump lock for n8n in 15 seconds, another bump is running' });
  // flock failing any other way is a fault: it is not said to be another bump, and it exits non-zero.
  const broken = await both(await sandbox(t), 'n8n', { ...PATCH, STUB_FLOCK_EXIT: '127' });
  assert.equal(broken[1].status, 1);
  assert.equal(broken[1].stderr, '');
  assert.deepEqual(broken[1].calls, ['flock -w 15 9 [held]']);
  assert.doesNotMatch(broken[0].error, /another bump/);
});

test('run for real: a failed clone or install stops the run where it failed', async (t) => {
  const clone = (sb) => `git clone --branch main https://github.com/InsForge/instacloud-oss.git ${sb.tree('n8n')} [held]`;
  const install = (sb) => `npm --prefix ${sb.tree('n8n')}/templates install --omit=dev --ignore-scripts --loglevel=error --no-audit --no-fund [held]`;
  // The patcher would answer happily if it were reached, so reaching it is what these look for.
  const patcher = { ...PATCH, STUB_PATCHER_STATUS: '0' };

  // A failed clone leaves no tree, and running on would end in "no such template" for a template
  // that exists. So it has to stop at the clone, and the reason the person reads is the clone's.
  const noClone = await sandbox(t);
  const [said, a] = await both(noClone, 'n8n', { STUB_CLONE_EXIT: '128', ...patcher });
  assert.notEqual(a.status, 0);
  assert.deepEqual(a.calls, ['flock -w 15 9 [held]', clone(noClone)], 'nothing after the clone');
  assert.doesNotMatch(a.stderr, /no such template/);
  assert.match(readApply(a.stderr, 'n8n').error, /did not answer with json: fatal: unable to access the remote/);
  assert.match(said.error, /fatal: unable to access the remote/);

  const noInstall = await sandbox(t);
  const [answer, b] = await both(noInstall, 'n8n', { STUB_NPM_EXIT: '1', ...patcher });
  assert.notEqual(b.status, 0);
  assert.deepEqual(b.calls, ['flock -w 15 9 [held]', clone(noInstall), install(noInstall)], 'no patcher after a failed install');
  assert.equal(readApply(b.stdout, 'n8n').applied, undefined, 'and nothing reads as applied');
  assert.deepEqual(Object.keys(answer), ['error']);
  assert.deepEqual(branches(noInstall), ['main']);
});

test('run for real: a directory that is not a template is said so, and the patcher never runs', async (t) => {
  // `scripts` is a directory of tooling under templates/ with the shape of a code.
  const sb = await sandbox(t);
  const [said, out] = await both(sb, 'scripts', { STUB_PATCHER_OUT: printed(N8N), STUB_PATCHER_STATUS: '0' });
  assert.equal(out.status, 0, 'there being no such template is an answer');
  // What a clone says of itself comes first, and the sentence is the last thing on stderr.
  assert.ok(out.stderr.endsWith('\nno such template: scripts\n'), out.stderr);
  assert.ok(!out.calls.some((c) => c.startsWith('node ')), 'the patcher was not asked about it');
  assert.ok(!out.calls.some((c) => /^git (checkout|add|commit|push)/.test(c)));
  assert.deepEqual(said, { error: 'There is no template called scripts.' });
  // A code that is not in the clone at all is the same answer.
  const [gone, ran] = await both(await sandbox(t), 'whisper-turbo', { STUB_PATCHER_OUT: printed(N8N) });
  assert.equal(ran.status, 0);
  assert.ok(ran.stderr.endsWith('\nno such template: whisper-turbo\n'));
  assert.ok(!ran.calls.some((c) => c.startsWith('node ')));
  assert.deepEqual(gone, { error: 'There is no template called whisper-turbo.' });
});

test('run for real: through the real execInBox, with nothing injected but the insta binary', async (t) => {
  // The default exec: the argv it builds, the rejection a non-zero exit gives, and what runBump
  // makes of each. The error object here is execFile's own, not one written for this test.
  const via = async (sb, env) => ({ instaBin: await instaStandIn(sb, env), agentService: 'claude-code', agentProjectId: 'a-project' });

  const sb = await sandbox(t);
  assert.deepEqual(await runBump(await via(sb, PATCH), 'n8n'), {
    applied: { code: 'n8n', kind: 'docker-tag', level: 'minor', upstream: { from: '2.36.5', to: '2.42.0' }, version: { from: '1.3.2', to: '1.4.0' } },
    branch: PUSHED,
  });
  assert.deepEqual(branches(sb), [PUSHED, 'main']);

  const refused = { ...N8N, applied: undefined, refused: 'the Dockerfile does not hold it' };
  assert.deepEqual(await runBump(await via(await sandbox(t), { STUB_PATCHER_OUT: printed(refused) }), 'n8n'), { refused: 'the Dockerfile does not hold it', code: 'n8n' });

  const locked = await sandbox(t);
  assert.match((await runBump(await via(locked, { STUB_FLOCK_EXIT: '1' }), 'n8n')).error, /another bump is running/);

  const declined = await sandbox(t);
  await writeFile(join(declined.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const out = await runBump(await via(declined, PATCH), 'n8n');
  assert.match(out.error, /^The patch was made on the box, but no branch was pushed: [\s\S]*pre-receive hook declined/);
  assert.deepEqual(branches(declined), ['main']);

  const gone = await sandbox(t);
  assert.deepEqual(await runBump(await via(gone, PATCH), 'scripts'), { error: 'There is no template called scripts.' });
});

// Every outcome the script can have, with the exit status it must give: 0 for an answer, 1 for a fault.
// `execInBox` re-runs the whole script after any rejection when there is an ssh config, so an answer
// that exited non-zero would be run twice, and for a lost lease the second run wins.
const BAD = '2.42.0\n\nCo-Authored-By: x';
const only = (row) => ({ STUB_PATCHER_OUT: printed(row) });
const OUTCOMES = [
  { what: 'pushed', status: 0, keys: ['applied', 'branch'], env: () => PATCH },
  { what: 'current', status: 0, keys: ['code', 'current'], env: () => only({ code: 'n8n', current: true }) },
  { what: 'refused', status: 0, keys: ['code', 'refused'], env: () => only({ ...N8N, applied: undefined, refused: 'no' }) },
  { what: 'unresolved', status: 0, keys: ['error'], env: () => ({ ...only({ ...OPENCLAW, code: 'n8n' }), STUB_PATCHER_STATUS: '1' }) },
  { what: 'the lock held by another bump', status: 0, keys: ['error'], env: () => ({ ...PATCH, STUB_FLOCK_EXIT: '1' }) },
  { what: 'no such template', status: 0, keys: ['error'], code: 'scripts', env: () => PATCH },
  ...FIELDS.map((f) => ({ what: `a ${f} that is not safe`, status: 0, keys: ['error'], env: () => ({ ...only(withField(f, BAD)), STUB_PATCHER_TOUCH: PATCH.STUB_PATCHER_TOUCH }) })),
  {
    what: 'a lost lease',
    status: 0,
    keys: ['error'],
    env: (sb) => ({ ...PATCH, STUB_RACE_BRANCH: PUSHED, STUB_RACE_TO: sb.ask('rev-parse', 'main') }),
  },
  {
    what: 'the remote declining the push',
    status: 0,
    keys: ['error'],
    setup: (sb) => writeFile(join(sb.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }),
    env: () => PATCH,
  },
  { what: 'flock failing', status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_FLOCK_EXIT: '127' }) },
  { what: 'the clone failing', status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_CLONE_EXIT: '128' }) },
  { what: 'the install failing', status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_NPM_EXIT: '1' }) },
  { what: 'the patcher crashing', status: 1, keys: ['error'], env: () => ({ STUB_PATCHER_OUT: '', STUB_PATCHER_ERR: 'TypeError: boom', STUB_PATCHER_STATUS: '1' }) },
  { what: 'rows with another line in them', status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_PATCHER_OUT: `${printed(N8N)}\nPUSHED ${PUSHED}` }) },
  { what: 'a row about another template', status: 1, keys: ['error'], env: () => only({ ...N8N, code: 'pi' }) },
  { what: 'a row that says nothing', status: 1, keys: ['error'], env: () => only({ code: 'n8n' }) },
  { what: 'a patch that changed nothing', status: 1, keys: ['error'], env: () => only(N8N) },
  // Words a remote hook might print, that look like a status line to anyone who matches loosely.
  { what: 'git push failing with a hook\'s words that mention a rejection', status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_GIT_FAIL: 'push', STUB_GIT_FAIL_SAYS: 'remote: policy says ! [rejected] and ! [remote rejected]' }) },
  ...['checkout', 'add', 'commit', 'push'].map((step) => ({ what: `git ${step} failing`, status: 1, keys: ['error'], env: () => ({ ...PATCH, STUB_GIT_FAIL: step }) })),
];

test('run for real: an answer exits 0 and a fault exits 1, and over ssh only a fault is run again', async (t) => {
  // execInBox renews the certificate and runs the WHOLE script again after any rejection, when there
  // is an ssh config. So this goes through it, counting the runs and the renewals.
  for (const o of OUTCOMES) {
    const sb = await sandbox(t);
    if (o.setup) await o.setup(sb);
    const code = o.code ?? 'n8n';
    const env = o.env(sb);
    const runs = [];
    let renewals = 0;
    const spawnStandIn = async (file, args) => {
      assert.equal(file, 'ssh');
      assert.equal(args.at(-1), bumpScript(code), 'the script that is run over ssh is this one');
      const r = await exec(sb, args.at(-1), env);
      runs.push(r);
      if (r.status === 0) return { stdout: r.stdout, stderr: r.stderr };
      throw Object.assign(new Error('Command failed: ssh'), { code: r.status, stdout: r.stdout, stderr: r.stderr, killed: false });
    };
    const via = (c, script, opts) => execInBox(c, script, opts, { run: spawnStandIn, renew: async () => { renewals += 1; } });
    const out = await runBump({ sshConfig: '/nonexistent/ssh_config', sshAlias: 'box' }, code, { run: via });

    assert.equal(runs[0].status, o.status, `${o.what}: the status of the script`);
    assert.deepEqual(Object.keys(out).sort(), o.keys, `${o.what}: what runBump says`);
    assert.equal(runs.length, o.status === 0 ? 1 : 2, `${o.what}: how many times the script was run`);
    assert.equal(renewals, runs.length - 1, `${o.what}: a certificate is renewed only for a run that is repeated`);
    if (o.what === 'pushed') assert.deepEqual(branches(sb), [PUSHED, 'main']);
    // The lease that was lost stays lost: nobody's branch was overwritten by a run that came after.
    if (o.what === 'a lost lease') assert.equal(sb.ask('rev-parse', PUSHED), env.STUB_RACE_TO, "the other person's branch is exactly as they left it");
    // The repeat of a fault is not a second push either: none of the faults got as far as one.
    if (o.what !== 'pushed' && o.what !== 'a lost lease') assert.ok(!branches(sb).includes(PUSHED), `${o.what}: no branch of ours on the remote, from either run`);
  }
});

test('run for real: a global hooks directory cannot put a trailer, or anything else, in the commit', async (t) => {
  // A core.hooksPath on the box with a prepare-commit-msg in it would write a Co-Authored-By into the
  // pushed commit, past every check on the script's text. Armed: the four commit hooks, each of which
  // logs its own name, and prepare-commit-msg and commit-msg both add a trailer.
  const sb = await sandbox(t);
  const hooks = join(sb.root, 'global-hooks');
  const log = join(sb.root, 'hooks.log');
  const hook = (name, extra = '') => put(join(hooks, name), `#!/bin/sh\necho ${name} >> '${log}'\n${extra}`, 0o755);
  await hook('pre-commit');
  await hook('prepare-commit-msg', 'printf "\\nCo-Authored-By: Prepare Hook <prepare@example.com>\\n" >> "$1"\n');
  await hook('commit-msg', 'printf "Signed-off-by: Commit Hook <commit@example.com>\\n" >> "$1"\n');
  await hook('post-commit');
  await appendFile(sb.gitEnv.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${hooks}\n`);

  // The control: an ordinary commit here runs all four and carries both trailers.
  const w = join(sb.root, 'control');
  sb.git(sb.root, 'clone', '-q', sb.remote, w);
  await appendFile(join(w, 'padding/0'), 'changed\n');
  sb.git(w, '-c', 'user.name=c', '-c', 'user.email=c@example.com', 'commit', '-q', '-a', '-m', 'control');
  assert.deepEqual((await readFile(log, 'utf8')).split('\n').filter(Boolean), ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']);
  assert.match(sb.git(w, 'log', '-1', '--format=%B'), /Co-Authored-By: Prepare Hook[\s\S]*Signed-off-by: Commit Hook/, 'control: the hooks do write trailers here');
  await rm(log);

  const out = await bump(sb, 'n8n', PATCH);
  assert.equal(out.branch, PUSHED);
  assert.equal(messageOf(sb, PUSHED), `${SUBJECT}\n`, 'the pushed commit is its subject and nothing else');
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '', 'and no commit hook ran');
});

// ---- runBump, with the exec stood in for --------------------------------------------------------

const rejected = (stdout, stderr = '', extra = {}) => Object.assign(new Error('Command failed: sh -c #!/bin/sh a whole script'), { code: 1, stdout, stderr, ...extra });
const answering = (result) => async () => {
  if (result instanceof Error) throw result;
  return result;
};
const pushedRun = `${printed(N8N)}\n[${PUSHED} 1a2b3c4] ${SUBJECT}\n 2 files changed, 2 insertions(+)\nbranch '${PUSHED}' set up to track 'origin/${PUSHED}'.\nPUSHED ${PUSHED}\n`;

test('runBump: one exec of the script for the code asked, with the config and our own kill', async () => {
  const calls = [];
  const out = await runBump({ the: 'config' }, 'n8n', {
    run: async (...args) => {
      calls.push(args);
      return { stdout: pushedRun, stderr: '' };
    },
  });
  assert.equal(calls.length, 1, 'once: a second exec would be a second shell, and the lock would be gone');
  assert.deepEqual(calls[0], [{ the: 'config' }, bumpScript('n8n'), { timeoutMs: 28000 }]);
  assert.equal(out.branch, PUSHED);
  assert.equal(out.applied.upstream.to, '2.42.0');
});

test('runBump: a code that is not a template code runs nothing and says so', async () => {
  for (const bad of ['--apply', 'n8n; id', '', null, undefined, '../registry']) {
    let ran = false;
    const out = await runBump({}, bad, { run: async () => { ran = true; return { stdout: '' }; } });
    assert.match(out.error, /is not a template code\. A code is a directory under templates\//, JSON.stringify(bad));
    assert.equal(ran, false, 'nothing was sent to the box');
    assert.deepEqual(Object.keys(out), ['error']);
  }
});

test('runBump: a push is the marker line on stdout, for the branch this process would have named', async () => {
  // The marker is the only thing that says a push happened, so each of these is not one.
  const applied = printed(N8N);
  for (const [why, result] of [
    ['no marker at all, and a clean exit', { stdout: `${applied}\n`, stderr: '' }],
    ['the marker in the middle of a line', { stdout: `${applied}\nnot PUSHED ${PUSHED}\n`, stderr: '' }],
    ['the marker indented', { stdout: `${applied}\n PUSHED ${PUSHED}\n`, stderr: '' }],
    ['the marker on stderr, where git speaks', { stdout: `${applied}\n`, stderr: `PUSHED ${PUSHED}\n` }],
    ['the marker, lowercase', { stdout: `${applied}\npushed ${PUSHED}\n`, stderr: '' }],
    ['the marker with no branch', { stdout: `${applied}\nPUSHED \n`, stderr: '' }],
    ['the marker with more said after the branch', { stdout: `${applied}\nPUSHED ${PUSHED} and then some\n`, stderr: '' }],
  ]) {
    const out = await runBump({}, 'n8n', { run: answering(result) });
    assert.equal(out.branch, undefined, why);
    assert.equal(out.applied, undefined, why);
    assert.match(out.error, /^The patch was made on the box, but no branch was pushed/, why);
  }
  // Only a clean exit vouches for the marker. The same line on the way to a fault, or a kill, is not a push.
  for (const extra of [{}, { code: 255 }, { killed: true, signal: 'SIGTERM', code: null }]) {
    const out = await runBump({}, 'n8n', { run: answering(rejected(`${applied}\nPUSHED ${PUSHED}\n`, 'fatal: boom', extra)) });
    assert.deepEqual(Object.keys(out), ['error'], JSON.stringify(extra));
    assert.match(out.error, /^The patch was made on the box, but no branch was pushed/, JSON.stringify(extra));
  }
  // A push the remote turned down exits 0 with git's status line on stderr, and that is what is said.
  const turned = ` ! [rejected]        ${PUSHED} -> ${PUSHED} (stale info)\nerror: failed to push some refs to 'https://github.com/InsForge/instacloud-oss.git'\n`;
  const lost = await runBump({}, 'n8n', { run: answering({ stdout: `${applied}\n`, stderr: turned }) });
  assert.deepEqual(Object.keys(lost), ['error']);
  assert.match(lost.error, /^The patch was made on the box, but no branch was pushed: [\s\S]*\[rejected\][\s\S]*\(stale info\)[\s\S]*failed to push some refs[\s\S]*\.$/);
  // A clean exit that pushed nothing has nothing else to say, and says so.
  const quiet = await runBump({}, 'n8n', { run: answering({ stdout: `${applied}\n`, stderr: '' }) });
  assert.equal(quiet.error, 'The patch was made on the box, but no branch was pushed: the run ended without pushing and without saying why.');
  // A marker for some other branch is not handed on: what reaches a pull request is what is named here.
  for (const named of ['feat/n8n-9.9.9', 'feat/pi-2.42.0', 'main', `${PUSHED}x`, `x${PUSHED}`, `${PUSHED};id`]) {
    const out = await runBump({}, 'n8n', { run: answering({ stdout: `${applied}\nPUSHED ${named}\n`, stderr: '' }) });
    assert.equal(out.branch, undefined, named);
    assert.match(out.error, /this run would have named the branch feat\/n8n-2\.42\.0/, named);
  }
  // And the marker is read from stdout where the rows are, wherever in it the marker is.
  const early = await runBump({}, 'n8n', { run: answering({ stdout: `PUSHED ${PUSHED}\n${applied}\n`, stderr: '' }) });
  assert.equal(early.branch, PUSHED);
});

test('runBump: the marker inside something the patcher printed is not a push', async () => {
  // JSON puts a newline in a string as `\n`, so no line of the rows can begin with the marker.
  const said = { ...N8N, kind: `x\nPUSHED ${PUSHED}`, digest: `PUSHED ${PUSHED}` };
  for (const text of [printed(said), JSON.stringify([said])]) {
    const out = await runBump({}, 'n8n', { run: answering({ stdout: `${text}\n`, stderr: '' }) });
    assert.deepEqual(Object.keys(out), ['error'], text);
    assert.match(out.error, /^The patch was made on the box, but no branch was pushed/);
  }
  // And a refusal that quotes it is still a refusal.
  const refused = printed({ ...N8N, applied: undefined, refused: `x\nPUSHED ${PUSHED}` });
  assert.deepEqual(await runBump({}, 'n8n', { run: answering(rejected(refused)) }), { refused: `x\nPUSHED ${PUSHED}`, code: 'n8n' });
});

test('runBump: the rows are read from both streams, whatever the exit', async () => {
  // The script exits 0 for these answers, and a fault after the patcher ran still has its rows, so
  // they are read off a rejection as well.
  const refused = await runBump({}, 'laya', { run: answering(rejected(printed({ ...LAYA, applied: undefined, refused: 'the Dockerfile does not hold it' }))) });
  assert.deepEqual(refused, { refused: 'the Dockerfile does not hold it', code: 'laya' });
  const current = await runBump({}, 'pi', { run: answering(rejected(printed({ code: 'pi', kind: 'npm', current: true }))) });
  assert.deepEqual(current, { current: true, code: 'pi' });
  // The rows on stderr, and the marker on stdout: both streams are read, and neither alone is enough.
  const split = await runBump({}, 'n8n', { run: answering({ stdout: `PUSHED ${PUSHED}\n`, stderr: printed(N8N) }) });
  assert.equal(split.branch, PUSHED);
  // The lock message and `no such template` are on stderr, with nothing on stdout.
  const sentence = 'could not take the bump lock for n8n in 15 seconds, another bump is running';
  const locked = await runBump({}, 'n8n', { run: answering(rejected('', `${sentence}\n`)) });
  assert.deepEqual(locked, { error: sentence }, 'the box answered, so it is not a box that failed to answer with json');
  assert.deepEqual(await runBump({}, 'n8n', { run: answering({ stdout: '', stderr: `${sentence}\n` }) }), { error: sentence });
  const nothing = await runBump({}, 'scripts', { run: answering(rejected('', 'no such template: scripts\n')) });
  assert.equal(nothing.error, 'There is no template called scripts.');
  const unresolved = await runBump({}, 'openclaw', { run: answering(rejected(printed(OPENCLAW))) });
  assert.equal(unresolved.error, `openclaw could not be resolved: ${OPENCLAW.unknown}`);
  // And the same answers on a clean exit, which is how the script now gives them.
  const clean = (stdout, stderr = '') => answering({ stdout, stderr });
  assert.deepEqual(await runBump({}, 'laya', { run: clean(printed({ ...LAYA, applied: undefined, refused: 'the Dockerfile does not hold it' })) }), refused);
  assert.deepEqual(await runBump({}, 'pi', { run: clean(printed({ code: 'pi', kind: 'npm', current: true })) }), current);
  assert.equal((await runBump({}, 'openclaw', { run: clean(printed(OPENCLAW)) })).error, unresolved.error);
  assert.equal((await runBump({}, 'scripts', { run: clean('', "Cloning into 'x'...\ndone.\nno such template: scripts\n") })).error, 'There is no template called scripts.');
});

test('runBump: a patch that was made and not pushed is an error with git\'s reason, never applied and never a branch', async () => {
  const reason = ` ! [rejected]        ${PUSHED} -> ${PUSHED} (stale info)\nerror: failed to push some refs to 'https://github.com/InsForge/instacloud-oss.git'\n`;
  const out = await runBump({}, 'n8n', { run: answering(rejected(`${printed(N8N)}\n[${PUSHED} 1a2b3c4] ${SUBJECT}\n`, reason)) });
  assert.deepEqual(Object.keys(out), ['error']);
  assert.match(out.error, /^The patch was made on the box, but no branch was pushed: /);
  assert.ok(out.error.includes('(stale info)') && out.error.includes('failed to push some refs'));
  // A failed push prints a page, and this lands in a chat reply.
  const page = await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), `${'x'.repeat(5000)}\nthe end\n`)) });
  assert.ok(page.error.length < 500);
  assert.ok(page.error.endsWith('the end.'), 'the end of it, which is where git says why');
  // A run that wrote nothing at all says how it ended, and when the box could not be reached, why.
  assert.equal((await runBump({}, 'n8n', { run: answering(rejected('', '', { code: 255 })) })).error, 'The box did not answer with json: exit code 255 with nothing on stderr');
  assert.equal((await runBump({}, 'n8n', { run: answering(rejected('', '', { code: 'ENOENT', message: 'spawn ssh ENOENT' })) })).error, 'The box did not answer with json: spawn ssh ENOENT');
  // A run that wrote only to stdout, and not rows, says what it said and not an exit code.
  const quiet = await runBump({}, 'n8n', { run: answering(rejected('the patcher printed this and nothing else', '')) });
  assert.match(quiet.error, /did not answer with json: the patcher printed this and nothing else/);
  // With something on stderr it is the end of that which is said, whatever else was printed.
  const long = await runBump({}, 'n8n', { run: answering(rejected('Cloning into x...', `${'x'.repeat(5000)}\nthe end\n`)) });
  assert.match(long.error, /^The box did not answer with json: x+\nthe end$/);
  assert.ok(long.error.length < 500);
  // With rows there, stdout is the patcher's and is never what the person is told about the push.
  const rows = await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', { code: 3 })) });
  assert.match(rows.error, /no branch was pushed: exit code 3 with nothing on stderr\.$/);
  assert.doesNotMatch(rows.error, /"code"|"kind"/);
  // No output at all, and a spawn error with no exit code.
  assert.match((await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', { code: 128 })) })).error, /exit code 128 with nothing on stderr/);
  assert.match((await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', { code: 'ENOENT', message: 'spawn ssh ENOENT' })) })).error, /spawn ssh ENOENT/);
});

test('runBump: a run that was killed says so, and when a patch had been made says the branch may exist', async () => {
  const killed = { killed: true, signal: 'SIGTERM', code: null };
  // Killed before the patcher finished: nothing was pushed, and no branch is in doubt.
  const early = await runBump({}, 'n8n', { run: answering(rejected('', '', killed)) });
  assert.match(early.error, /the run was killed by SIGTERM before it finished, most likely at its 28 second limit/);
  assert.doesNotMatch(early.error, /may have been pushed/);
  // A kill is said as a kill whatever else the run had printed by then.
  assert.match((await runBump({}, 'n8n', { run: answering(rejected("Cloning into 'x'...", '', killed)) })).error, /^The box did not answer with json: the run was killed by SIGTERM before it finished/);
  // Killed after it had printed its rows: the push may or may not have got through.
  const late = await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', killed)) });
  assert.match(late.error, /^The patch was made on the box, but no branch was pushed: the run was killed by SIGTERM before it finished/);
  assert.match(late.error, /The branch may have been pushed before that, so look at the repository before trying again\.$/);
  assert.equal(late.branch, undefined);
  // A kill that carries only a flag, or only a signal, and a failure that is not a kill, say different things.
  assert.match((await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', { killed: true })) })).error, /was killed before it finished/);
  const signalled = await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), '', { killed: false, signal: 'SIGKILL', code: null })) });
  assert.match(signalled.error, /^The patch was made on the box, but no branch was pushed: the run was killed by SIGKILL before it finished/);
  assert.match(signalled.error, /may have been pushed before that/);
  assert.doesNotMatch((await runBump({}, 'n8n', { run: answering(rejected(printed(N8N), 'fatal: x', { killed: false })) })).error, /killed|may have been pushed/);
});

test('runBump: a version that is not a plain one is an error even if the box says it pushed', async () => {
  const bad = printed({ ...N8N, to: '2.42.0\n\nCo-Authored-By: x' });
  const out = await runBump({}, 'n8n', { run: answering({ stdout: `${bad}\nPUSHED feat/n8n-2.42.0\n`, stderr: '' }) });
  assert.match(out.error, /not a plain version string/);
  assert.equal(out.branch, undefined);
  assert.equal(out.applied, undefined);
});

test('runBump: an answer about another template is not read as ours', async () => {
  const out = await runBump({}, 'pi', { run: answering({ stdout: `${printed(N8N)}\nPUSHED ${PUSHED}\n`, stderr: '' }) });
  assert.match(out.error, /answered about 'n8n' when asked about 'pi'/);
  assert.equal(out.branch, undefined);
});

// ---- reading the answer -------------------------------------------------------------------------

test('a patched template reports what moved, upstream and ours, each the right way round', () => {
  assert.deepEqual(readApply(printed(N8N), 'n8n'), {
    applied: {
      code: 'n8n',
      kind: 'docker-tag',
      level: 'minor',
      upstream: { from: '2.36.5', to: '2.42.0' },
      version: { from: '1.3.2', to: '1.4.0' },
    },
  });
  // A commit has no level, and that is null and not a missing field.
  const laya = readApply(printed(LAYA), 'laya').applied;
  assert.equal(laya.level, null);
  assert.equal(laya.kind, 'git-commit');
  assert.deepEqual(laya.upstream, { from: LAYA.from, to: LAYA.to });
  assert.deepEqual(laya.version, { from: '0.2.0', to: '0.2.1' });
  // And when the field is absent altogether, which is the same answer.
  assert.equal(readApply(printed({ ...LAYA, level: undefined }), 'laya').applied.level, null);
});

test('a refusal is an answer, with its whole reason, and nothing was patched', () => {
  // The patcher refuses rather than half-editing whenever a file is not what the drift was read
  // from. Four rounds of review in the oss repository paid for that, and it must reach the person
  // who asked instead of reading as a crash. The row still carries the move it declined.
  const reason = "the Dockerfile does not hold 'c9dcaab6da74ce5c34a66ef84f2503c77e4e619a' in a build arg, so there is nothing here this can move confidently";
  const out = readApply(printed({ ...LAYA, applied: undefined, refused: reason }), 'laya');
  assert.deepEqual(out, { refused: reason, code: 'laya' });
});

test('a template that is already current is neither a failure nor a patch', () => {
  assert.deepEqual(readApply(printed({ code: 'pi', kind: 'npm', current: true }), 'pi'), { current: true, code: 'pi' });
});

test('a row that says nothing is an error, and is not read as current', () => {
  // The patcher always says one of these four things, so a row with none of them is not an answer.
  // Two ways of widening what counts as current get past everything else without this.
  for (const row of [{ code: 'pi' }, { code: 'pi', kind: 'npm' }, { code: 'pi', current: false }, { code: 'pi', current: 0 }, { code: 'pi', current: null }, { code: 'pi', applied: null }]) {
    const out = readApply(printed(row), 'pi');
    assert.equal(out.error, "pi: the patcher's answer says neither that it is current, nor that it patched or refused, nor why it could not look.", JSON.stringify(row));
    assert.deepEqual(Object.keys(out), ['error'], JSON.stringify(row));
  }
});

test('an unresolved template is an error with its reason, and is not read as current', () => {
  // openclaw is pinned by digest and cannot be resolved without a registry token. Reading that as
  // "nothing to do" would be a confident wrong answer.
  const out = readApply(printed(OPENCLAW), 'openclaw');
  assert.equal(out.error, `openclaw could not be resolved: ${OPENCLAW.unknown}`);
  assert.equal(out.current, undefined);
  assert.equal(out.applied, undefined);
  assert.equal(out.refused, undefined);
  // The patcher never prints two of these on one row, so the order is what a future row that did
  // would be read by: could not look, then declined, then nothing to do.
  assert.equal(readApply(printed({ code: 'pi', unknown: 'no route', current: true }), 'pi').error, 'pi could not be resolved: no route');
  assert.equal(readApply(printed({ code: 'pi', unknown: 'no route', refused: 'no' }), 'pi').error, 'pi could not be resolved: no route');
  assert.deepEqual(readApply(printed({ code: 'pi', refused: 'no', current: true }), 'pi'), { refused: 'no', code: 'pi' });
});

test('a template that is behind and was neither patched nor refused is an error, as when --apply is lost', () => {
  const out = readApply(printed({ ...N8N, applied: undefined }), 'n8n');
  assert.equal(out.error, 'n8n is behind but the patcher wrote nothing, and gave no reason.');
  assert.equal(out.applied, undefined);
  assert.equal(out.current, undefined);
});

test('a row about another template is not an answer about the one that was asked for', () => {
  // Whatever the row says, patch or refusal or current or unresolved: it is somebody else's.
  for (const row of [N8N, { ...LAYA, applied: undefined, refused: 'no' }, { code: 'n8n', current: true }, { ...OPENCLAW, code: 'n8n' }]) {
    const out = readApply(printed(row), 'pi');
    assert.match(out.error, new RegExp(`answered about '${row.code}' when asked about 'pi'`));
    assert.deepEqual(Object.keys(out), ['error']);
  }
  // No code asked for is not a match for whatever came back.
  for (const none of [undefined, null, '', 'N8N', 'n8n ']) assert.match(readApply(printed(N8N), none).error, /when asked about/, String(none));
  assert.ok(readApply(printed(N8N), 'n8n').applied, 'control: the same row read for the code it is about');
});

test('an answer about anything but one template is not read as an answer about ours', () => {
  const two = readApply(printed(N8N, LAYA), 'n8n');
  assert.match(two.error, /2 templates when asked about one/);
  assert.equal(two.applied, undefined, 'the first row is not taken as if it were the only one');
  assert.match(readApply('[]', 'n8n').error, /no templates at all/);
  assert.equal(readApply('[]', 'n8n').current, undefined);
});

test('a version that is not a plain one is refused whichever of the four it is', () => {
  const at = { 'upstream from': (v) => ({ ...N8N, from: v }), 'upstream to': (v) => ({ ...N8N, to: v }), 'template from': (v) => ({ ...N8N, applied: { from: v, to: '1.4.0' } }), 'template to': (v) => ({ ...N8N, applied: { from: '1.3.2', to: v } }) };
  const hostile = ['2.0\n\nCo-Authored-By: x', '2.0\n', '1;id', '$(id)', '`id`', "1'", '1 2', '', '../x', 'a/b', '*', '2.0 ', ' 2.0'];
  for (const [what, make] of Object.entries(at)) {
    for (const bad of hostile) {
      const out = readApply(printed(make(bad)), 'n8n');
      assert.match(out.error, new RegExp(`^n8n: the ${what} version .* is not a plain version string`), `${what} ${JSON.stringify(bad)}`);
      assert.deepEqual(Object.keys(out), ['error']);
    }
    for (const notAString of [2, 2.5, null, true, false, ['2.0'], { a: 1 }]) {
      assert.match(readApply(printed(make(notAString)), 'n8n').error ?? '', /not a plain version string/, `${what} ${JSON.stringify(notAString)}`);
    }
    assert.ok(readApply(printed(make('1.0.0-rc.1+build.5')), 'n8n').applied, `${what}: an ordinary version passes`);
  }
  const gone = { ...N8N };
  delete gone.to;
  assert.match(readApply(printed(gone), 'n8n').error, /upstream to version undefined is not a plain version string/, 'a missing one is not a version either');
  const noFrom = { ...N8N };
  delete noFrom.from;
  assert.match(readApply(printed(noFrom), 'n8n').error, /upstream from version undefined is not a plain version string/);
  // Only the four a patch hands on are read. A refusal and a current row hand on none.
  assert.equal(readApply(printed({ ...LAYA, applied: undefined, refused: 'no', to: '1\n2' }), 'laya').refused, 'no');
});

test('VERSION is exactly letters, digits, dot, underscore, plus and hyphen, all of them, and nothing else', () => {
  const allowed = /[A-Za-z0-9._+-]/;
  for (let c = 0; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    const ok = allowed.test(ch);
    // On its own, and in each position a pattern that lost an anchor would let a bad one through.
    for (const shape of [ch, `1${ch}`, `${ch}1`, `1${ch}1`]) {
      const want = shape.split('').every((x) => allowed.test(x));
      if (VERSION.test(shape) !== want) assert.fail(`U+${c.toString(16)} in ${JSON.stringify(shape)}: expected ${want}`);
    }
    if (ok !== VERSION.test(ch)) assert.fail(`U+${c.toString(16)}`);
  }
  assert.ok(!VERSION.test(''), 'not empty');
  assert.ok(VERSION.test('2.36.5') && VERSION.test('v1.0.0-rc.1+build.5') && VERSION.test('d113dca2512fb3eaca313534bc54c7162d87c1d4'));
  assert.ok(!VERSION.test('1.0\n'), 'a trailing newline does not slip past the anchor');
  assert.equal(VERSION.global || VERSION.sticky || VERSION.multiline, false, 'no flag that would make test() remember or match a line');
});

test('the version guard in readApply is the one the script uses, over every code unit', () => {
  // Through readApply, where the guard is wired: the four fields, every code unit, one shape each.
  const good = /^[A-Za-z0-9._+-]$/;
  for (let c = 0; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    const rows = JSON.stringify([{ ...N8N, to: `1${ch}` }]);
    const got = readApply(rows, 'n8n');
    if (Boolean(got.applied) !== good.test(ch)) assert.fail(`U+${c.toString(16)}: applied is ${Boolean(got.applied)}`);
  }
});

test('noise around the rows does not break the read, whatever brackets it carries', () => {
  // What a clone, an install and a later commit and push print. A commit says `[branch sha]`.
  const noise = [
    "Cloning into '/data/work/bump/n8n'...",
    'added 2 packages in 248ms',
    '[skip ci]',
    '[feat/n8n-2.42.0 1a2b3c4] n8n 2.36.5 -> 2.42.0',
    " * [new branch]      feat/n8n-2.42.0 -> feat/n8n-2.42.0",
  ].join('\n');
  for (const text of [`${noise}\n${printed(N8N)}\n`, `${printed(N8N)}\n${noise}\n`, `${noise}\n${printed(N8N)}\n${noise}\n`]) {
    assert.equal(readApply(text, 'n8n').applied.code, 'n8n');
    assert.equal(readApply(text, 'n8n').applied.upstream.to, '2.42.0');
  }
});

test('no json, or nothing at all, is an error that says what was said', () => {
  assert.match(readApply('sh: 1: node: not found\n', 'n8n').error, /did not answer with json: sh: 1: node: not found/i);
  assert.match(readApply('', 'n8n').error, /did not answer with json: \(nothing\)/i);
  assert.match(readApply(undefined, 'n8n').error, /did not answer with json: \(nothing\)/i);
  assert.match(readApply('[skip ci]\n', 'n8n').error, /did not answer with json/i);
  // A failed clone can print a page, and this lands in a chat reply.
  assert.ok(readApply('x'.repeat(5000), 'n8n').error.length < 300);
  // Rows that are not objects are not rows.
  assert.match(readApply('[null]', 'n8n').error, /did not answer with json/i);
  assert.match(readApply('[1, 2]', 'n8n').error, /did not answer with json/i);
  // A cause the caller knows is what it says, when there are no rows to read.
  assert.match(readApply('', 'n8n', 'the run was killed').error, /did not answer with json: the run was killed/);
});

test('the words the script itself prints are read as answers', () => {
  const sentence = 'could not take the bump lock for n8n in 15 seconds, another bump is running';
  assert.deepEqual(readApply(`${sentence}\n`, 'n8n'), { error: sentence });
  assert.deepEqual(readApply(`Cloning into 'x'...\ndone.\n${sentence}\n`, 'n8n', 'the run was killed'), { error: sentence }, 'not prefixed with a claim that the box did not answer');
  assert.match(readApply(`x ${sentence}\n`, 'n8n').error, /did not answer with json/, 'and only when it is a line of its own');
  assert.match(readApply(`${sentence} and more\n`, 'n8n').error, /did not answer with json/, 'the whole line');
  assert.equal(readApply('no such template: scripts\n', 'scripts').error, 'There is no template called scripts.');
});

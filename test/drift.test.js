// test/drift.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execInBox } from '../src/agent.js';
import { REGISTRY_DIR, refreshScript } from '../src/registry.js';
import { checkScript, readDrift, describeDrift, checkUpstream } from '../src/drift.js';

// What the detector prints for `--json`, trimmed from a real run: one row per template, pretty
// printed, with the one pinned by digest unresolved and a commit pin that has no level.
const ROWS = [
  { code: 'n8n', kind: 'docker-tag', from: '2.36.5', to: '2.41.3', comparable: true, level: 'minor' },
  { code: 'laya', kind: 'git-commit', from: 'c9dcaab', to: 'd113dca', comparable: false, level: null },
  { code: 'openclaw', kind: 'docker-digest', unknown: 'a tag pinned by digest needs a registry token' },
  { code: 'whisper-turbo', kind: 'git-commit', current: true },
];
const PRINTED = JSON.stringify(ROWS, null, 2);

test('it asks the detector for json, for one template or for all of them', () => {
  assert.match(checkScript([]), /check-upstreams\.mjs --json$/);
  assert.match(checkScript(['n8n']), /check-upstreams\.mjs --json n8n$/);
  assert.match(checkScript(['n8n', 'pi']), /check-upstreams\.mjs --json n8n pi$/);
  // A code is a directory name in a public repository, and it lands in a shell.
  assert.throws(() => checkScript(['n8n; rm -rf /']), /not a template code/);
  assert.throws(() => checkScript(['../../etc']), /not a template code/);
});

test('only a plain directory name is a template code, because the string lands in a shell', () => {
  // That shell is on a box holding a GitHub token with push rights and a platform key for a whole
  // organization, and the detector's --apply flag writes files. So `--apply` must never pass.
  for (const good of ['n8n', '9router', 'claude-code', 'whisper-turbo', 'a']) {
    assert.doesNotThrow(() => checkScript([good]), good);
  }
  const bad = [
    '--apply', '--json', '-x', '-', 'n8n-', '-n8n', 'a--b', 'N8N', '',
    'a.b', 'a_b', 'a~b', 'a=b', 'a b', ' n8n', 'n8n ', 'a/b', '../../etc',
    'n8n\n', 'a\nb', 'n8n\n--apply', 'n8n; rm -rf /', '$(id)', '`id`', "a'b", 'a"b', 'a|b', 'a&b', 'a>b',
  ];
  for (const c of bad) {
    assert.throws(() => checkScript([c]), /not a template code/, JSON.stringify(c));
    assert.throws(() => checkScript(['n8n', c]), /not a template code/, `after a good one: ${JSON.stringify(c)}`);
  }
  // Not text at all: `join` drops a null, and no code at all means every template.
  for (const c of [null, undefined, 0, {}, ['n8n']]) {
    assert.throws(() => checkScript([c]), /not a template code/, String(c));
  }
});

test('a bad code is refused before anything is sent to the box', async () => {
  // checkScript is not the only door: checkUpstream has to go through it, or the guard is decoration.
  for (const bad of ['--apply', '-x', 'n8n; rm -rf /', 'n8n\n--apply', null]) {
    for (const codes of [[bad], ['n8n', bad]]) {
      let called = 0;
      const out = await checkUpstream({}, codes, { run: async () => { called += 1; return { stdout: '[]' }; } });
      assert.equal(called, 0, `sent ${JSON.stringify(codes)} to the box`);
      assert.match(out.error, /not a template code/);
      assert.equal(out.rows, undefined);
    }
  }
});

test('what goes to the box, and what comes back when the box simply answers', async () => {
  // Nothing in these tests makes `run` resolve otherwise, and the plain path is the common one.
  const config = { agentService: 'box' };
  const calls = [];
  const run = async (c, script, opts) => {
    calls.push({ c, script, opts });
    return { stdout: PRINTED, stderr: '' };
  };
  const out = await checkUpstream(config, ['n8n', 'pi'], { run });
  assert.deepEqual(out.rows, ROWS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].c, config);
  // insta compute exec cuts a command off at about 31 seconds and boxCommand passes no --timeout, so
  // our kill has to land under that or it never fires. 170000 was the unmeasured number.
  assert.equal(calls[0].opts.timeoutMs, 28000, 'our kill lands just under the measured 31 second cutoff');
  // The lock gives up before that kill, with room left for twice the measured 4.4 second cold run.
  const wait = /^flock -w (\d+) 9 /m.exec(calls[0].script);
  assert.ok(wait, 'the script takes the lock with a bounded wait');
  const room = calls[0].opts.timeoutMs - Number(wait[1]) * 1000;
  assert.ok(room >= 2 * 4400, `a ${wait[1]} second lock wait leaves ${room} ms to work, under twice the cold run`);
  // The refresh comes first and its own line ends it, so the detector never sees a stale tree.
  assert.ok(calls[0].script.startsWith(`${refreshScript()}\n`), 'the refresh runs first');
  assert.equal(
    calls[0].script.split('\n').at(-1),
    `node ${REGISTRY_DIR}/templates/scripts/check-upstreams.mjs --json n8n pi`,
  );

  await checkUpstream(config, [], { run });
  assert.match(calls[1].script, /check-upstreams\.mjs --json$/);
});

test('a template nobody could resolve is an answer, not a failure', () => {
  // openclaw does this on every real run: the detector exits 1 and still prints every row.
  const out = readDrift(PRINTED);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.rows, ROWS);
  assert.equal(out.rows[2].unknown, 'a tag pinned by digest needs a registry token');
});

test('noise on the way back does not break the read', () => {
  // The CLI prints its own upgrade banner and a shell can add a warning. Both land on the same
  // stream as the json, and neither is a reason to tell the caller nothing came back.
  const noisy = `WARN something\n${JSON.stringify([{ code: 'pi', current: true }])}\n`;
  assert.equal(readDrift(noisy).rows[0].code, 'pi');
});

test('noise with brackets in it does not break the read either', () => {
  // git reset --hard prints `HEAD is now at <sha> <subject>` on stdout, and the first commit whose
  // subject says [skip ci] would otherwise turn every check into "did not answer with json".
  const before = 'HEAD is now at 1234567 [skip ci] something\n';
  const after = '[0.0.71]\n';
  assert.deepEqual(readDrift(`${before}${PRINTED}\n${after}`).rows, ROWS);
  assert.deepEqual(readDrift(`${before}${PRINTED}\n`).rows, ROWS);
  assert.deepEqual(readDrift(`${PRINTED}\n${after}`).rows, ROWS);
  // Lines that open a bracket themselves, one of them a valid array that is not rows.
  assert.deepEqual(readDrift(`[skip ci] x\n[2026]\n${PRINTED}\n[0.0.71]\n[9]\n`).rows, ROWS);
  // Compact json, and a row that has an array of its own, whose closing bracket is not the end.
  assert.deepEqual(readDrift(`[skip ci]\n${JSON.stringify(ROWS)}\n[1]\n`).rows, ROWS);
  const nested = [{ code: 'pi', tags: ['a', 'b'] }, { code: 'n8n', current: true }];
  assert.deepEqual(readDrift(`[x]\n${JSON.stringify(nested, null, 2)}\n[y]\n`).rows, nested);
  // Windows line endings do not hide the closing bracket.
  assert.deepEqual(readDrift(`${PRINTED.replaceAll('\n', '\r\n')}\r\n`).rows, ROWS);
  // Nor does a different indent, and an opener that is only noise does not swallow the real one.
  assert.deepEqual(readDrift(`${JSON.stringify(ROWS, null, '\t')}\n`).rows, ROWS);
  assert.deepEqual(readDrift(`${JSON.stringify(ROWS, null, 4)}\n`).rows, ROWS);
  assert.deepEqual(readDrift(`[\nsome warning\n${PRINTED}\n`).rows, ROWS);
});

test('a flood of bracketed noise is read in linear time, not cubic', () => {
  // This runs in the Slack bot's own process, so a slow scan is the bot deaf to everything else for
  // as long as it takes. Trying every opening line against every closing line was cubic: 0.45 s at
  // 500 lines, 17 s at 2000, and about a minute at the 3000 used here. Every noise line here both
  // opens and closes a bracket, half of them are not json and half are json that is not rows, and
  // the real answer comes last with a banner after it. Linear is a few milliseconds.
  const noise = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `[${i}]` : `[skip ci ${i}]`));
  const text = `${noise.join('\n')}\n${PRINTED}\n[0.0.71]\n`;
  const started = performance.now();
  const out = readDrift(text);
  const took = performance.now() - started;
  assert.deepEqual(out.rows, ROWS);
  assert.ok(took < 1000, `reading 3000 noise lines took ${Math.round(took)} ms`);

  // The other shape that grows: a lot of `[` alone on a line, each of which could start a pretty
  // printed array. Each one's indented run has to be its own, or every opener rescans the rest.
  //
  // The size is what makes this a guard. At 30000 lines a cheap quadratic scan (a slice, a forward
  // scan, an indexOf per opener) takes only 20 to 280 ms and would pass, so the large stage is
  // 500000 lines: linear takes 14 ms there and the cheapest quadratic takes over 5 s, against a
  // budget of 2 s. The small stage goes first so that a catastrophic regression, which takes 20 s at
  // 30000, fails there and not after many minutes at 500000.
  for (const [lines, budgetMs] of [[30000, 1000], [500000, 2000]]) {
    const openers = `${Array(lines).fill('[').join('\n')}\n${PRINTED}\n`;
    const openersStarted = performance.now();
    const openersOut = readDrift(openers);
    const openersTook = performance.now() - openersStarted;
    assert.deepEqual(openersOut.rows, ROWS);
    assert.ok(openersTook < budgetMs, `reading ${lines} openers took ${Math.round(openersTook)} ms`);
  }
});

test('every character of the output is parsed at most once', () => {
  // A timing needs a big input to see a scan that parses the same text twice, and it depends on the
  // machine, so this counts instead and needs neither: the characters handed to JSON.parse can never
  // exceed the output's own length, however much bracketed noise is in it. It is blind to a scan
  // that reads without parsing, which is what the timing above is for, so it adds to it.
  const noise = Array.from({ length: 500 }, (_, i) => [`[skip ci ${i}]`, `[${i}]`, '[\n  junk\n]', '[', 'plain'][i % 5]);
  const text = `${noise.join('\n')}\n${PRINTED}\n[0.0.71]\n`;
  const realParse = JSON.parse;
  let parsed = 0;
  JSON.parse = (s, ...rest) => {
    parsed += String(s).length;
    return realParse(s, ...rest);
  };
  let out;
  try {
    out = readDrift(text);
  } finally {
    JSON.parse = realParse;
  }
  assert.deepEqual(out.rows, ROWS);
  assert.ok(parsed > 0, 'nothing was parsed, so this counted nothing');
  assert.ok(parsed <= text.length, `parsed ${parsed} characters out of ${text.length}`);
});

test('brackets with no json in them are not an answer', () => {
  const noise = ['[skip ci] only noise\n', '[2026]\n', '[1, 2]\n', '[[1, 2]]\n', '[null]\n', '[]x\n', 'HEAD is now at 1 [skip ci]\n[0.0.71]\n'];
  // Output that stops inside an indented run, with no closing line and no newline after it.
  noise.push('[\n  x', '[\n  x\n', '[\n');
  for (const said of noise) {
    const out = readDrift(said);
    assert.match(out.error, /did not answer with json/i, said);
    assert.equal(out.rows, undefined, said);
  }
});

test('an answer with no json in it says so rather than throwing', () => {
  const out = readDrift('sh: 1: node: not found\n');
  assert.match(out.error, /did not answer with json/i);
  assert.match(out.error, /node: not found/);
  assert.equal(out.rows, undefined);
  // Nothing at all, and nothing that is even a string.
  assert.match(readDrift('').error, /\(nothing\)/);
  assert.match(readDrift(undefined).error, /\(nothing\)/);
  assert.match(readDrift(null).error, /\(nothing\)/);
});

test('what an unreadable answer echoes back is bounded', () => {
  // A failed install prints a page, and this ends up in a chat reply.
  const out = readDrift('x'.repeat(500));
  assert.equal(out.error, `The box did not answer with json: ${'x'.repeat(200)}`);
  // The start of it, which is what the run said first, and not the end.
  assert.equal(
    readDrift(`${'h'.repeat(200)}${'t'.repeat(300)}`).error,
    `The box did not answer with json: ${'h'.repeat(200)}`,
  );
});

test('an empty list is not a clean registry, it is a registry nobody managed to read', async () => {
  // A checkout that is empty, or broken so the detector finds no template directories, prints `[]`
  // and exits 0. Reading that as rows would end in "Nothing is behind", which is confident, wrong
  // and indistinguishable from a good day.
  for (const said of ['[]\n', 'HEAD is now at 1234567 [skip ci] x\n[]\n[0.0.71]\n', '[\n]\n']) {
    const out = readDrift(said);
    assert.match(out.error, /found no templates/, JSON.stringify(said));
    assert.doesNotMatch(out.error, /nothing is behind/i);
    assert.equal(out.rows, undefined, JSON.stringify(said));
  }
  // Through the whole path, where the answer is a resolved run and not an error.
  const out = await checkUpstream({}, [], { run: async () => ({ stdout: '[]\n', stderr: '' }) });
  assert.match(out.error, /found no templates/);
  assert.equal(out.rows, undefined);
  // And when the run was rejected, which is how a non-zero exit arrives: the same answer, whichever
  // way the run ended.
  const thrown = Object.assign(new Error('Command failed'), { code: 1, stdout: '[]\n', stderr: '' });
  const rejected = await checkUpstream({}, [], { run: async () => { throw thrown; } });
  assert.match(rejected.error, /found no templates/);
  assert.equal(rejected.rows, undefined);
});

test('a name that is not in the registry is named back', () => {
  // check-upstreams.mjs exits 2 with this. Saying "nothing to report" would read as "you are up
  // to date", which is the opposite of what happened.
  const out = readDrift('no such template: n88n\n');
  assert.equal(out.error, 'There is no template called n88n.');
  assert.doesNotMatch(out.error, /json/);
  assert.equal(readDrift('WARN x\nno such template: n88n\n').error, 'There is no template called n88n.');
  assert.equal(readDrift('no such template: n88n\r\n').error, 'There is no template called n88n.');
  assert.equal(readDrift('no such template: n88n  \n').error, 'There is no template called n88n.');
});

test('a non-zero exit is still read, because the detector uses one to mean unresolved', async () => {
  // insta compute exec rejects on a non-zero exit and hangs the output off the error. Dropping
  // that output would turn openclaw, unresolved on every single run, into a hard failure.
  const rows = [{ code: 'openclaw', unknown: 'needs a registry token' }];
  const thrown = Object.assign(new Error('Command failed'), { stdout: JSON.stringify(rows) });
  const out = await checkUpstream({}, [], { run: async () => { throw thrown; } });
  assert.equal(out.rows[0].code, 'openclaw');
  // With warnings on stderr as well, and the whole pretty printed answer.
  const noisy = Object.assign(new Error('Command failed'), { code: 1, stdout: PRINTED, stderr: 'warn [x]\n' });
  assert.deepEqual((await checkUpstream({}, [], { run: async () => { throw noisy; } })).rows, ROWS);
});

// What execFile really puts on the error, and the message is the whole command line.
const ARGV = `Command failed: insta compute exec box -- sh -c ${checkScript([])}`;
const failed = (fields) => Object.assign(new Error(ARGV), fields);
const askAndThrow = (thrown) => checkUpstream({}, [], { run: async () => { throw thrown; } });

test('a run that never produced output still says why, because execFile leaves stdout empty', async () => {
  // execFile sets stdout to '' rather than leaving it off when the binary is missing or the run is
  // killed. An empty string is not an answer, and the error object is all that is left.
  const missing = Object.assign(new Error('spawn insta ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' });
  const gone = await askAndThrow(missing);
  assert.match(gone.error, /ENOENT/);
  assert.doesNotMatch(gone.error, /\(nothing\)|exit code/);

  // The real shape of a run killed at its timeout, measured: not the invented message it once had.
  const slow = await askAndThrow(failed({ code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }));
  assert.match(slow.error, /killed by SIGTERM/);
  assert.match(slow.error, /28 second/);
  assert.doesNotMatch(slow.error, /flock|compute exec|\(nothing\)/);

  // Killed from outside carries a signal and no `killed`, and a kill with no signal still says so.
  const outside = await askAndThrow(failed({ code: null, killed: false, signal: 'SIGKILL', stdout: '', stderr: '' }));
  assert.match(outside.error, /killed by SIGKILL/);
  const unnamed = await askAndThrow(failed({ code: null, killed: true, signal: null, stdout: '', stderr: '' }));
  assert.match(unnamed.error, /the run was killed before it finished/);
});

test('a failed run says what it printed, not the command line that ran', async () => {
  const dns = await askAndThrow(failed({
    code: 128, stdout: '', stderr: 'fatal: unable to access the remote: Could not resolve host: github.com\n',
  }));
  assert.match(dns.error, /exit code 128/);
  assert.match(dns.error, /Could not resolve host: github\.com/);
  assert.doesNotMatch(dns.error, /flock|compute exec/);

  // The cause is at the end of a long stderr, and the error stays short.
  const long = await askAndThrow(failed({ code: 1, stdout: '', stderr: `${'noise\n'.repeat(500)}the real cause\n` }));
  assert.match(long.error, /the real cause/);
  assert.ok(long.error.length < 300, `error is ${long.error.length} characters`);

  // Both streams have something: stderr is the cause, and stdout is only what git said on the way.
  const both = await askAndThrow(failed({ code: 1, stdout: 'HEAD is now at 1234567 subject\n', stderr: 'the cause\n' }));
  assert.match(both.error, /exit code 1: the cause$/);

  // Only stdout has anything, which is where a merged channel puts it.
  const merged = await askAndThrow(failed({ code: 127, stdout: 'sh: 1: node: not found\n', stderr: '' }));
  assert.match(merged.error, /node: not found/);

  // A long message with nothing else to go on is cut short too.
  const wordy = await askAndThrow(Object.assign(new Error('boom '.repeat(200)), { stdout: '', stderr: '' }));
  assert.match(wordy.error, /^The box did not answer with json: boom boom/);
  assert.ok(wordy.error.length < 300, `error is ${wordy.error.length} characters`);

  // An exit with nothing said at all still names the exit, and not the argv.
  const silent = await askAndThrow(failed({ code: 3, stdout: '', stderr: '' }));
  assert.match(silent.error, /exit code 3/);
  assert.doesNotMatch(silent.error, /flock|compute exec/);
});

test('a name the registry does not have is named back from stderr, where the detector says it', async () => {
  // check-upstreams.mjs prints `no such template` with console.error and exits 2, and that exit is
  // a rejection, so stdout is empty and the words are only on the error's stderr.
  const out = await askAndThrow(failed({ code: 2, stdout: '', stderr: 'no such template: n88n\n' }));
  assert.equal(out.error, 'There is no template called n88n.');
});

// The channel these tests are really about: a fake `insta` on disk, run by the real execFile.
async function fakeInsta(t, body) {
  const dir = await mkdtemp(join(tmpdir(), 'drift-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'insta');
  await writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { instaBin: bin, agentService: 'box', agentProjectId: 'proj' };
}

test('through the real exec path, a non-zero exit still yields the rows', async (t) => {
  // Nothing else asserts that spawn in agent.js hangs stdout on the error. Drop that line and every
  // real run fails with a plausible message while every test with an injected error stays green.
  const config = await fakeInsta(t, [
    "echo 'A new insta is available [0.0.71], run insta upgrade'",
    `printf '%s\\n' '${PRINTED}'`,
    "echo '[0.0.71]'",
    "echo 'a warning' >&2",
    'exit 1',
  ].join('\n'));
  const out = await checkUpstream(config, []);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.rows, ROWS);
});

test('through the real exec path, the cause of a failure is read off stderr', async (t) => {
  const config = await fakeInsta(t, [
    "echo 'fatal: unable to access the remote: Could not resolve host: github.com' >&2",
    'exit 128',
  ].join('\n'));
  const out = await checkUpstream(config, []);
  assert.match(out.error, /exit code 128/);
  assert.match(out.error, /Could not resolve host/);
  assert.doesNotMatch(out.error, /flock|compute exec/);
});

test('through the real exec path, a run killed at the timeout says it was killed', async (t) => {
  const config = await fakeInsta(t, 'exec sleep 30');
  // The same channel and the same error, with a timeout short enough to wait for.
  const run = (c, script, opts) => execInBox(c, script, { ...opts, timeoutMs: 300 });
  const out = await checkUpstream(config, [], { run });
  assert.match(out.error, /killed by SIGTERM/);
  assert.doesNotMatch(out.error, /flock|compute exec/);
});

test('through the real exec path, a checkout with no templates is an error and not a clean bill', async (t) => {
  const config = await fakeInsta(t, ["echo 'HEAD is now at 1234567 [skip ci] x'", 'echo []', 'exit 0'].join('\n'));
  const out = await checkUpstream(config, []);
  assert.match(out.error, /found no templates/);
  assert.equal(out.rows, undefined);
});

test('through the real exec path, an unknown name and a missing binary are both said plainly', async (t) => {
  const config = await fakeInsta(t, ["echo 'no such template: n88n' >&2", 'exit 2'].join('\n'));
  assert.equal((await checkUpstream(config, ['n88n'])).error, 'There is no template called n88n.');

  const missing = await checkUpstream({ ...config, instaBin: join(tmpdir(), 'no-such-insta-binary') }, []);
  assert.match(missing.error, /ENOENT/);
  assert.doesNotMatch(missing.error, /\(nothing\)/);
});

// What follows the count in a behind answer, whole. Hermes can see its own tools and this server
// cannot, so the sentence is a condition on them and asserts nothing about them. It has been wrong
// four times by a clause that did: one named a tool, one denied a tool, one affirmed one, and one
// was slipped in between the parts a partial match looks at. So it is compared whole, and rewording
// it fails here on purpose: changing it should take a decision and not a drive-by.
const AFTER_COUNT =
  "This check only reports. If none of your tools moves a template's pin, a person runs " +
  '`npm run check-upstreams -- --apply` in templates/ of InsForge/instacloud-oss, reads the diff ' +
  'and opens the pull request. Tell them which are behind, from the lines above.';

test('the lines name what moved, and end with the move that follows', () => {
  const said = describeDrift([
    { code: 'n8n', from: '2.36.5', to: '2.41.3', level: 'minor' },
    { code: 'pi', current: true },
    { code: 'openclaw', unknown: 'needs a registry token' },
  ]);
  assert.match(said, /^n8n: 2\.36\.5 -> 2\.41\.3  minor$/m);
  assert.doesNotMatch(said, /not comparable/);
  assert.match(said, /^pi: up to date$/m);
  assert.match(said, /^openclaw: could not be resolved, needs a registry token$/m);
  // One is behind: not the three rows, and not the two that are not current.
  assert.match(said, /^1 behind\. /m);
  // Every word of it, once: nothing inserted, removed or reworded anywhere.
  assert.equal(
    said,
    [
      'n8n: 2.36.5 -> 2.41.3  minor',
      'pi: up to date',
      'openclaw: could not be resolved, needs a registry token',
      '',
      `1 behind. ${AFTER_COUNT}`,
    ].join('\n'),
  );
  // Whatever the rows are, the sentence is the same one: nothing in it depends on a level or a count.
  assert.equal(
    describeDrift([
      { code: 'n8n', from: '1.0.0', to: '2.0.0', level: 'major' },
      { code: 'laya', from: 'c9dcaab', to: 'd113dca', level: null },
    ]),
    ['n8n: 1.0.0 -> 2.0.0  major', 'laya: c9dcaab -> d113dca  changed, not comparable', '', `2 behind. ${AFTER_COUNT}`].join('\n'),
  );
  // A commit sha has no level, and calling it a patch would be an invention.
  assert.match(
    describeDrift([{ code: 'laya', from: 'c9dcaab', to: 'd113dca', level: null }]),
    /^laya: c9dcaab -> d113dca {2}changed, not comparable$/m,
  );
  // A clean day has nothing to advise about, and is compared whole for the same reason.
  assert.equal(describeDrift([{ code: 'pi', current: true }]), 'pi: up to date\n\nNothing is behind.');
});

test('with no templates at all it does not call the registry clean', () => {
  // Not reachable through checkUpstream, which refuses an empty list, but describeDrift is exported
  // and an empty array must not print the line that means every template was looked at.
  const said = describeDrift([]);
  assert.equal(said, 'No templates were found, so nothing was checked.');
  assert.doesNotMatch(said, /Nothing is behind|only reports|behind/i);
});

test('when nothing is behind but something could not be checked, it says so', () => {
  // One template is pinned by digest and unresolved on every run, so on a quiet day "Nothing is
  // behind" would sit under a line saying that template could not be looked at.
  const said = describeDrift([
    { code: 'pi', current: true },
    { code: 'openclaw', unknown: 'needs a registry token' },
    { code: 'other', unknown: 'no network' },
  ]);
  assert.doesNotMatch(said, /Nothing is behind/);
  assert.equal(
    said,
    [
      'pi: up to date',
      'openclaw: could not be resolved, needs a registry token',
      'other: could not be resolved, no network',
      '',
      'Nothing is known to be behind, but openclaw, other could not be checked.',
    ].join('\n'),
  );
  // A row that says both is current, as its own line says, and is not counted as unchecked.
  const both = describeDrift([{ code: 'pi', current: true, unknown: 'stale' }]);
  assert.match(both, /^pi: up to date$/m);
  assert.match(both, /Nothing is behind\./);
  // With something behind, the count is the move that follows, and unresolved rows are not in it.
  assert.match(describeDrift([{ code: 'n8n', to: '2', from: '1', level: 'major' }, { code: 'openclaw', unknown: 'x' }]), /^1 behind\. /m);
});

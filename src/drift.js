// src/drift.js
// Running the registry's own detector in the box, and reading what comes back.
//
// The arithmetic is not repeated here. `check-upstreams.mjs` in instacloud-oss decides what a pin
// should be, it is unit tested there against recorded registry responses, and a second copy of
// that judgement living in this repository would drift from the one those tests cover.

import { execInBox } from './agent.js';
import { REGISTRY_DIR, refreshScript } from './registry.js';

// A template code, spelled the way src/upstream.js spells it so the repository has one meaning for
// the word. A copy and not an import, because the two features are unrelated.
//
// This string is pasted into a shell on a box that holds a GitHub token with push rights and a
// platform key for a whole organization, and the detector's `--apply` flag WRITES files. The
// pattern is the only thing keeping this tool read only: a code can never start with a hyphen, so
// `--apply` is never a code.
const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// `insta compute exec` caps a command at 180 seconds (see boxCommand in agent.js), so a longer
// timeout is dead code and someone will otherwise restore 300000. The work measures about 3.
const TIMEOUT_MS = 170000;

// A failed clone or install prints a page, and this lands in a chat reply.
const TAIL = 200;

export function checkScript(codes) {
  for (const c of codes) {
    // A null is not text, and `join` would drop it, which reads as "every template".
    if (typeof c !== 'string' || !CODE.test(c)) throw new Error(`'${c}' is not a template code`);
  }
  const args = codes.length ? ` ${codes.join(' ')}` : '';
  return `${refreshScript()}\nnode ${REGISTRY_DIR}/templates/scripts/check-upstreams.mjs --json${args}`;
}

const isRow = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

/**
 * The array of rows, out of whatever else shared the stream.
 *
 * Other output has brackets of its own: `git reset --hard` prints `HEAD is now at <sha> <subject>`
 * and a subject can say `[skip ci]`, and the CLI can print a `[0.0.71]` banner. So this does not
 * take the first bracket to the last, it keeps the first span that is an array of objects.
 *
 * Where a span ends is never a guess, and that is what keeps this linear. The detector prints
 * `JSON.stringify(rows, null, 2)`: a `[` alone on a line, every line inside indented, and a `]`
 * alone on a line. Compact json on one line is read too. Trying every opening line against every
 * closing line was cubic, 17 seconds at 2000 noise lines, and this runs in the Slack bot's own
 * process, where that is the bot deaf to everything else for as long as it takes.
 */
function findRows(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.startsWith('[')) continue;
    let span = null;
    if (line.endsWith(']')) {
      span = line;
    } else if (line === '[') {
      // The indented run belongs to this opener alone: the next opener is not indented, so no two
      // runs overlap and every line is read a constant number of times.
      let j = i + 1;
      while (j < lines.length && /^\s/.test(lines[j])) j++;
      if (j < lines.length && lines[j].trimEnd() === ']') span = lines.slice(i, j + 1).join('\n');
    }
    if (span === null) continue;
    try {
      const rows = JSON.parse(span);
      if (Array.isArray(rows) && rows.every(isRow)) return rows;
    } catch {
      // Not this span. A bracket in a warning is not json, and that is not an exception.
    }
  }
  return null;
}

/** The rows, and otherwise what went wrong: `cause` when the caller knows it, else what was said. */
export function readDrift(stdout, cause) {
  const text = String(stdout ?? '');
  const rows = findRows(text);
  // An empty list is not "nothing to report", it is a checkout with no templates in it. Handed on
  // as rows it would read as a healthy registry, which is the worst answer this could give.
  if (rows?.length === 0) {
    return {
      error:
        'The detector found no templates at all, so nothing was checked. ' +
        'The registry checkout on the box may be empty or broken.',
    };
  }
  if (rows) return { rows };
  const named = /no such template: (.+)/.exec(text);
  if (named) return { error: `There is no template called ${named[1].trim()}.` };
  return { error: `The box did not answer with json: ${cause || text.trim().slice(0, TAIL) || '(nothing)'}` };
}

/**
 * What went wrong, read off the error object. Its message is `Command failed:` plus the whole argv,
 * which here contains the entire refresh script, so the message never shows the cause.
 */
function describeFailure(e) {
  if (e.killed || e.signal) {
    const by = e.signal ? ` by ${e.signal}` : '';
    return `the run was killed${by} before it finished, most likely at its ${TIMEOUT_MS / 1000} second limit`;
  }
  const said = String(e.stderr || e.stdout || '').trim();
  const how = typeof e.code === 'number' ? `exit code ${e.code}` : '';
  if (said) return how ? `${how}: ${said.slice(-TAIL)}` : said.slice(-TAIL);
  // No output at all: an exit code says more than the argv, and a spawn error says the most.
  return how ? `${how} with no output` : String(e.message ?? e).slice(0, TAIL);
}

/**
 * Ask the box, and read the answer.
 *
 * A non-zero exit is NOT a failure here. The detector exits 1 whenever any template could not be
 * resolved, which openclaw does on every run, so the output is read either way and only the
 * absence of json is an error. It says `no such template` on stderr, so that is read too.
 */
export async function checkUpstream(config, codes, deps = {}) {
  const { run = execInBox } = deps;
  let script;
  try {
    script = checkScript(codes);
  } catch (e) {
    return { error: `${e.message}. A code is a directory under templates/ in instacloud-oss.` };
  }
  let answer;
  try {
    answer = await run(config, script, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    return readDrift([e.stdout, e.stderr].filter(Boolean).join('\n'), describeFailure(e));
  }
  return readDrift(answer.stdout);
}

/** One line per template, and the move that follows from them. */
export function describeDrift(rows) {
  // Nothing was looked at, so there is nothing to call clean. readDrift refuses an empty list, and
  // this keeps the same answer for a caller that arrives here some other way.
  if (!rows.length) return 'No templates were found, so nothing was checked.';
  const behind = rows.filter((r) => r.to);
  const unresolved = rows.filter((r) => !r.current && r.unknown);
  const lines = rows.map((r) => {
    if (r.current) return `${r.code}: up to date`;
    if (r.unknown) return `${r.code}: could not be resolved, ${r.unknown}`;
    return `${r.code}: ${r.from} -> ${r.to}  ${r.level ?? 'changed, not comparable'}`;
  });
  let next = '\n\nNothing is behind.';
  if (behind.length) {
    next = `\n\n${behind.length} behind. bump_template(code) opens a draft PR for one of them, with a running instance to try.`;
  } else if (unresolved.length) {
    // "Nothing is behind" would be false comfort: those are the ones nobody could look at.
    next = `\n\nNothing is known to be behind, but ${unresolved.map((r) => r.code).join(', ')} could not be checked.`;
  }
  return `${lines.join('\n')}${next}`;
}

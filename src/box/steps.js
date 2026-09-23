// Splits the agent's stream-json into three files while it runs, and passes the
// stream through untouched so out.jsonl stays a faithful archive.
//
//   steps.txt  what the agent said it was about to do, one line per turn
//   out.log    the agent's prose in full, so parseResult still finds RESULT
//
// The trace is the agent's own sentences rather than the commands it ran,
// because it already narrates before it acts and that narration is written for
// a person. A command is the fallback for a turn that went straight to work.
//
// Written per job rather than installed on the box: the box's root disk is
// wiped on restart and a job already ships its own runner the same way.
const fs = require('fs');
const path = process.argv[2];
const steps = fs.createWriteStream(`${path}/steps.txt`, { flags: 'a' });
const log = fs.createWriteStream(`${path}/out.log`, { flags: 'a' });

const LINE = 150;

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The first sentence, which is where the agent says what it is about to do. */
function opening(text) {
  const one = flat(text);
  // Headings and list markers are formatting, not narration.
  if (/^[#\-*>|`]/.test(one)) return '';
  const stop = one.search(/[.:!?](\s|$)/);
  const first = stop === -1 ? one : one.slice(0, stop + 1);
  return cut(first, LINE);
}

// Bookkeeping, not work: naming these is noise in a line meant to be read.
const NOISE = new Set(['cd', 'ls', 'echo', 'head', 'tail', 'wc', 'set', 'export', 'true', 'printf', 'pwd']);

const VERBS = {
  cat: 'reading',
  sed: 'reading',
  less: 'reading',
  grep: 'searching for',
  rg: 'searching for',
  find: 'looking for',
  node: 'running',
  mkdir: 'creating',
  cp: 'copying',
  mv: 'moving',
  diff: 'comparing',
};

// These say nothing without their subcommand: `git` is not a step, `git clone` is.
const SUBCOMMAND = new Set(['git', 'gh', 'insta', 'npm', 'npx', 'docker', 'yarn', 'pnpm']);

/** owner/repo, which is how anyone refers to a clone. */
const shorten = (t) => t.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');

/** A command, said the way a person would say it. Only used when nothing was said. */
function fromCommand(command) {
  // The job directory prefixes half these lines and says nothing.
  const whole = flat(command)
    .replace(/\/data\/work\/jobs\/[A-Za-z0-9-]+\//g, '')
    // Redirections are plumbing, and they read as arguments if left in.
    .replace(/\s*\d?>{1,2}\s*(?:&\d|\/dev\/null|\S+)/g, '');
  // A pipe needs spaces around it to be a pipe: `\|` inside a grep pattern is
  // one idea, not two commands, and splitting on it loses the whole search.
  const segments = whole.split(/\s*(?:&&|\|\|)\s*|;\s*|\s+\|\s+/).filter(Boolean);
  const meaty = segments.find((s) => !NOISE.has(s.split(/\s+/)[0])) ?? segments[0] ?? whole;

  const words = meaty.split(/\s+/);
  const verb = words[0];

  // `insta template deploy` is the step; `insta` alone is not. Take the plain
  // words that follow, which are subcommands, and stop at the first argument.
  let taken = 1;
  if (SUBCOMMAND.has(verb)) {
    while (taken < 3 && /^[a-z][a-z-]*$/.test(words[taken] ?? '')) taken += 1;
  }
  const said = SUBCOMMAND.has(verb) ? words.slice(0, taken).join(' ') : (VERBS[verb] ?? verb);
  const rest = words.slice(taken);

  // A quoted string is a search pattern for a search, and a title or a message
  // for anything else, which is the command's own words rather than a step.
  const searching = verb === 'grep' || verb === 'rg' || verb === 'find';
  const quoted = searching ? meaty.match(/["']([^"']{2,60})["']/) : null;
  // An alternation is one idea written several ways; the first of them says it.
  const pattern = quoted ? flat(quoted[1].split(/\\?\|/)[0]).replace(/\\+$/, '') : '';
  const target = rest.find((t) => !t.startsWith('-') && /[/.]/.test(t) && !/^["']/.test(t));

  const what = [pattern, target && shorten(target)].filter(Boolean).join(' in ');
  const plain = rest.filter((t) => !t.startsWith('-')).slice(0, 2).join(' ');
  return cut(what ? `${said} ${what}` : `${said} ${plain}`.trim(), LINE);
}

function describeTool(name, input = {}) {
  if (name === 'Bash' && input.command) return fromCommand(input.command);
  const short = name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
  const object = input.file_path ?? input.url ?? input.pattern ?? '';
  return cut(object ? `${short} ${object}` : short, LINE);
}

let buf = '';
process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk);
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) handle(line);
});
process.stdin.on('end', () => {
  if (buf.trim()) handle(buf);
  steps.end();
  log.end();
});

function handle(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Not every line is ours to understand; the archive already has it verbatim.
    return;
  }
  const content = event?.message?.content;
  if (event.type !== 'assistant' || !Array.isArray(content)) return;

  // One line per turn. What the agent said wins; a tool is the fallback for a
  // turn that said nothing, and repeating both would say the same thing twice.
  let said = '';
  for (const part of content) {
    if (part.type === 'text' && part.text.trim()) {
      log.write(`${part.text}\n`);
      said = said || opening(part.text);
    }
  }
  if (said) {
    steps.write(`${said}\n`);
    return;
  }
  const tool = content.find((p) => p.type === 'tool_use');
  if (tool) steps.write(`${describeTool(tool.name, tool.input)}\n`);
}

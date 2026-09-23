// Splits the agent's stream-json into three files while it runs, and passes the
// stream through untouched so out.jsonl stays a faithful archive.
//
//   steps.txt  one compact line per tool call, the trace a watcher shows live
//   out.log    the agent's own prose, so parseResult still finds the RESULT block
//
// Written per job rather than installed on the box: the box's root disk is wiped
// on restart and a job already ships its own runner the same way.
const fs = require('fs');
const path = process.argv[2];
const steps = fs.createWriteStream(`${path}/steps.txt`, { flags: 'a' });
const log = fs.createWriteStream(`${path}/out.log`, { flags: 'a' });

const cut = (s, n) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// The most informative single field, per tool, because a step is only useful if
// it says which file or which URL. Falls back to whatever the tool was given.
function describe(name, input = {}) {
  const short = name.replace(/^mcp__[^_]+__/, '');
  if (name === 'Bash') return `$ ${cut(input.command, 140)}`;
  if (input.file_path) return `${short} ${cut(input.file_path, 100)}`;
  if (input.url) return `${short} ${cut(input.url, 100)}`;
  if (input.pattern) return `${short} ${cut(input.pattern, 80)}`;
  if (input.selector || input.element) return `${short} ${cut(input.selector || input.element, 80)}`;
  const first = Object.values(input)[0];
  return first === undefined ? short : `${short} ${cut(first, 80)}`;
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
  if (event.type === 'assistant' && Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'tool_use') steps.write(`${describe(part.name, part.input)}\n`);
      if (part.type === 'text' && part.text.trim()) log.write(`${part.text}\n`);
    }
  }
  // The closing event repeats the final answer; the text blocks above already
  // carried it, so writing it again would duplicate the RESULT block.
}

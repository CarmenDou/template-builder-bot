#!/usr/bin/env node
// What a job has done since the caller last looked: job-feed <jobId> [byteOffset] [stagesSeen]
//
// Prints the new agent sentences, tool calls and stage lines, then one `next:` line carrying the
// offsets to pass back next time. Only the increment, and capped, so whoever is watching reads a
// few hundred bytes a minute instead of the whole log again.
const fs = require('fs');
const [jobId, offArg = '0', stagesArg = '0'] = process.argv.slice(2);
if (!/^[\w-]+$/.test(jobId || '')) { console.error('usage: job-feed <jobId> [offset] [stagesSeen]'); process.exit(2); }
const dir = `/data/work/jobs/${jobId}`;
const offset = Number(offArg) || 0;
const stagesSeen = Number(stagesArg) || 0;
const MAX_EVENTS = 40;

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const strip = (s) => flat(s).replace(/\/data\/work\/jobs\/[\w-]+\//g, '');

function describe(name, input = {}) {
  const short = name.replace(/^mcp__[^_]+__/, '');
  if (name === 'Bash') return `run: ${cut(strip(input.command), 160)}`;
  const target = input.file_path ?? input.url ?? input.pattern ?? input.element ?? '';
  return `${short}: ${cut(strip(target), 120)}`;
}

let text = '';
let size = 0;
try {
  const fd = fs.openSync(`${dir}/out.jsonl`, 'r');
  size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.max(0, size - offset));
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  text = buf.toString('utf8');
} catch {
  // No stream yet: the job is still setting up its browser.
}

// A partial last line belongs to the next read, so the offset stops before it.
const lastNewline = text.lastIndexOf('\n');
const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
const nextOffset = offset + Buffer.byteLength(complete, 'utf8');

const events = [];
for (const line of complete.split('\n')) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  const content = e?.message?.content;
  if (e.type !== 'assistant' || !Array.isArray(content)) continue;
  for (const p of content) {
    if (p.type === 'text' && p.text.trim()) events.push(`said: ${cut(flat(p.text), 240)}`);
    if (p.type === 'tool_use') events.push(describe(p.name, p.input));
  }
}

let stages = [];
try { stages = fs.readFileSync(`${dir}/stage.txt`, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch {}
for (const s of stages.slice(stagesSeen)) console.log(`stage: ${s}`);

const shown = events.slice(-MAX_EVENTS);
if (events.length > shown.length) console.log(`(${events.length - shown.length} earlier actions in this stretch not shown)`);
for (const ev of shown) console.log(ev);

let status = 'running';
try { status = `done exit=${fs.readFileSync(`${dir}/exit.code`, 'utf8').trim()}`; } catch {}
console.log(`next: ${nextOffset} ${stages.length} status: ${status}`);

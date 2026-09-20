import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

// Every job gets its own directory on the agent box's persistent volume:
//   /data/work/jobs/<id>/task.txt   what we asked for
//   /data/work/jobs/<id>/out.log    the agent's output
//   /data/work/jobs/<id>/exit.code  written only after the agent process ends
//
// The exit.code file is the completion signal. It exists because `insta compute
// exec` is a one-shot channel that can (and does) drop on long commands: a
// 10-minute template job outlives it. So the bot never holds the channel open --
// it starts the work with nohup, lets the channel close, and polls afterwards.
const JOBS_ROOT = '/data/work/jobs';

// Tools the agent is allowed to use. Deliberately an allowlist rather than
// bypassing permission checks: this box holds a GitHub token that can push to
// instacloud-oss and a platform key with full access to its org.
const ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'Bash(insta *)',
  'Bash(gh *)',
  'Bash(git *)',
  'Bash(curl *)',
  'Bash(mkdir *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(grep *)',
  'Bash(find *)',
  'Bash(sed *)',
  'Bash(awk *)',
  'Bash(cp *)',
  'Bash(mv *)',
  'Bash(wc *)',
  'Bash(echo *)',
  'Bash(printf *)',
  'Bash(cd *)',
  'Bash(test *)',
  'Bash(diff *)',
  'Bash(node *)',
  'mcp__playwright',
];

// Pinned as a pair: the browser must come from the playwright the MCP bundles.
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.82';
const PLAYWRIGHT = 'playwright@1.64.0-alpha-1789764292000';

export function newJobId(now = Date.now(), rand = () => crypto.randomBytes(3).toString('hex')) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${rand()}`;
}

// A job runs for tens of minutes. Without this the requester gets one message at
// the start and then silence, and cannot tell a long build from a dead agent.
export function stageInstructions(dir) {
  return `## Reporting progress

Append ONE line to \`${dir}/stage.txt\` at each of these four moments. Someone is watching from
Slack and this file is the only way they know you are alive.

    triage: <verdict> — one line of why
    pr: <url> — what you are waiting on next
    build: <green|red> — what happens next
    verify: reach ✓  enter ✓  round-trip ✓  survive ✓

Append, never rewrite. Write the triage line before you start writing files, not after.

The verify line is the four verdicts from CLAUDE.md, in that order, never free text: the reader
counts ticks. A failure carries its reason inline, \`round-trip ✗ search returned nothing\`. An
item that cannot apply is \`—\` plus a word, \`survive — stateless\`.

**One sentence each.** These are landmarks in a thread, not a narrative: the reader wants to know
where you are, and the detail is going into the PR body anyway. When something unexpected happens
and changes what you do next, give it its own line rather than stuffing it into the nearest stage:

    note: the first deploy failed the port probe, so the entrypoint now holds it through migrations

Then \`build: green\` stays \`build: green\`. Use \`note:\` only for something that changed your plan,
never for narrating ordinary progress.`;
}

export function buildTask({ url, extra, dir }) {
  const hint = extra ? `\n\nExtra instructions from the requester: ${extra}` : '';
  const stages = dir ? `\n\n${stageInstructions(dir)}` : '';
  return `Turn ${url} into an InstaCloud template.

Follow your CLAUDE.md end to end: triage it against the five judgements, create a fresh project for
this job, write the manifest, open a DRAFT PR on InsForge/instacloud-oss, deploy and verify it
(the four verdicts under Verifying: reach, enter, round-trip, survive, in the browser when the app
has one), put the evidence and the entry points in the PR body, then stop. Do not publish.

Finish your reply with a section headed RESULT containing, one per line:
  verdict: <directly-usable | thin-shell | tool-not-service | out>
  project: <project id, or none>
  service: <public URL, or none>
  pr: <PR url, or none>
  ask: <one thing a human has to settle>

Repeat the ask line once per thing, or leave it out entirely if there is nothing. One sentence each,
naming the decision rather than arguing it: the reasoning belongs in the PR body, and a reader who
needs it will open the PR. Five of them run together in one paragraph is a wall nobody reads.${hint}${stages}`;
}

export function buildFollowupTask({ pr, extra, dir }) {
  const stages = dir ? `\n\n${stageInstructions(dir)}` : '';
  return `Keep working on the template in InsForge/instacloud-oss PR #${pr}.

Recover the context from the PR itself rather than assuming anything: \`gh pr view ${pr} --json
headRefName,body,title\` gives you the branch, clone it into a FRESH job directory of your own and
check that branch out. Do not reuse another job's clone.

What the reviewer wants changed:
${extra || '(they did not say; read the PR comments with `gh pr view ' + pr + ' --comments`)'}

Make the change, commit and push to the same branch (pushing is what rebuilds the image), wait for
the build, redeploy and verify again the same way as the first time, and update the PR body so its
evidence matches what is now true. Keep it a draft. Do not publish and do not merge.

Finish your reply with a section headed RESULT containing, one per line:
  verdict: updated
  project: <project id you verified in, or none>
  service: <public URL, or none>
  pr: https://github.com/InsForge/instacloud-oss/pull/${pr}
  ask: <one thing a human has to settle>

Repeat the ask line once per thing, or leave it out entirely if there is nothing. One sentence each,
naming the decision rather than arguing it: the reasoning belongs in the PR body.${stages}`;
}

// argv, never a shell string, so a repo name can never become a command.
function execInsta(config, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.instaBin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, INSTA_PROJECT_ID: config.agentProjectId, CLAUDECODE: undefined },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function execInBox(config, script, opts) {
  return execInsta(config, ['compute', 'exec', config.agentService, '--', 'sh', '-c', script], opts);
}

export async function ensureLogin(config, run = execInsta) {
  await run(config, ['login', '--api-key', config.instaApiKey], { timeoutMs: 60000 });
}

/**
 * Starts the agent and returns as soon as it is running. Does NOT wait for it.
 */
export async function startJob(config, { url, pr, extra, slack }, deps = {}) {
  const { run = execInBox, jobId = newJobId() } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const task = pr ? buildFollowupTask({ pr, extra, dir }) : buildTask({ url, extra, dir });

  // Both the task and the runner travel as base64 and land as files. Quoting a
  // runner inline does not survive: `sh -c '... --allowedTools 'Read' ...'` ends
  // the outer quote at the first inner one, which leaves `Bash(insta *)` bare in
  // the shell (`Syntax error: "(" unexpected`) and eats the `*` as a glob.
  const taskB64 = Buffer.from(task, 'utf8').toString('base64');

  // Safe to single-quote here: this string becomes a file, it is never re-parsed
  // as part of a larger command line.
  const tools = ALLOWED_TOOLS.map((t) => `'${t}'`).join(' ');

  // Headless, a fresh profile per job, root needs no-sandbox, screenshots beside
  // the job and never inside the instacloud-oss clone where a commit could take them.
  const mcp = JSON.stringify({
    mcpServers: {
      playwright: {
        command: 'npx',
        // --browser chromium: the default channel is system Chrome, which the box does not have.
        args: ['-y', PLAYWRIGHT_MCP, '--browser', 'chromium', '--headless', '--isolated', '--no-sandbox', '--output-dir', `${dir}/browser`],
      },
    },
  });
  const mcpB64 = Buffer.from(mcp, 'utf8').toString('base64');

  const runner = [
    'export PATH="/data/home/.insta/bin:/data/home/bin:$PATH"',
    // Own pid, recorded before any work, so the job can be stopped later.
    `echo $$ > ${dir}/pid`,
    `cd ${dir}`,
    // Chromium sits on the volume but its shared libraries sit on the root disk,
    // which a restart wipes. Cheap check; the install runs once after a restart.
    `if ! dpkg -s libnss3 >/dev/null 2>&1 || ! ls /data/home/.cache/ms-playwright 2>/dev/null | grep -q chromium; then`,
    `  npx -y ${PLAYWRIGHT} install --with-deps chromium > ${dir}/setup.log 2>&1`,
    'fi',
    // No `set -e`: a failing claude must still reach the next line, because
    // exit.code is what the poller waits for.
    `claude -p "$(cat ${dir}/task.txt)" --allowedTools ${tools} --mcp-config ${dir}/mcp.json --strict-mcp-config > ${dir}/out.log 2>&1`,
    `echo $? > ${dir}/exit.code`,
    '',
  ].join('\n');
  const runnerB64 = Buffer.from(runner, 'utf8').toString('base64');

  // Who to answer, written next to the job. The bot's own memory does not
  // survive a redeploy, and the agent keeps running when the bot restarts, so a
  // job whose thread lived only in memory finishes with nobody listening.
  const ticket = Buffer.from(
    JSON.stringify({ jobId, url: url ?? (pr ? `PR #${pr}` : 'unknown'), ...slack }),
    'utf8',
  ).toString('base64');

  const script = [
    'set -e',
    `mkdir -p ${dir}`,
    `printf '%s' '${taskB64}' | base64 -d > ${dir}/task.txt`,
    `printf '%s' '${runnerB64}' | base64 -d > ${dir}/run.sh`,
    `printf '%s' '${mcpB64}' | base64 -d > ${dir}/mcp.json`,
    `printf '%s' '${ticket}' | base64 -d > ${dir}/slack.json`,
    `nohup setsid sh ${dir}/run.sh > /dev/null 2>&1 < /dev/null &`,
    'echo started',
  ].join('\n');

  await run(config, script, { timeoutMs: 120000 });
  return { jobId, dir };
}

export async function readJob(config, jobId, deps = {}) {
  const { run = execInBox } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const script = [
    `if [ -f ${dir}/exit.code ]; then echo "STATUS done $(cat ${dir}/exit.code)"; else echo "STATUS running"; fi`,
    `echo "---STAGES---"`,
    `cat ${dir}/stage.txt 2>/dev/null || true`,
    `echo "---LOG---"`,
    `tail -c 12000 ${dir}/out.log 2>/dev/null || true`,
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 60000 });
  const [head, ...afterStages] = stdout.split('---STAGES---');
  const [stageBlock, ...rest] = afterStages.join('---STAGES---').split('---LOG---');
  const statusLine = head.trim().split(/\s+/);
  const done = statusLine[1] === 'done';
  return {
    done,
    exitCode: done ? Number(statusLine[2]) : null,
    stages: (stageBlock ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    log: rest.join('---LOG---').trim(),
  };
}

/** Pulls the RESULT block the task asks the agent to end with. */
export function parseResult(log) {
  const idx = log.lastIndexOf('RESULT');
  if (idx === -1) return null;
  const block = log.slice(idx);
  const field = (name) => {
    const m = block.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'));
    const value = m?.[1]?.trim();
    return value && value.toLowerCase() !== 'none' ? value : null;
  };
  // One `ask:` line per thing to settle. Five of them on one line is a wall
  // nobody reads, so the block carries them separately all the way to Slack.
  const asks = [...block.matchAll(/^\s*ask:\s*(.+)$/gim)]
    .map((m) => m[1].trim())
    .filter((a) => a && a.toLowerCase() !== 'none');

  const legacy = field('asks');
  if (!asks.length && legacy) asks.push(legacy);

  return {
    verdict: field('verdict'),
    project: field('project'),
    service: field('service'),
    pr: field('pr'),
    asks,
  };
}

/**
 * Jobs that carry a Slack ticket and have not been reported yet. Used at boot to
 * re-attach to work that outlived the bot process.
 */
export async function listUnreportedJobs(config, deps = {}) {
  const { run = execInBox } = deps;
  const script = [
    `for d in ${JOBS_ROOT}/*/; do`,
    `  [ -f "$d/slack.json" ] || continue`,
    `  [ -f "$d/reported" ] && continue`,
    `  cat "$d/slack.json"; echo`,
    'done',
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 60000 });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Marks a job reported so a later restart does not answer it twice. */
export async function markReported(config, jobId, deps = {}) {
  const { run = execInBox } = deps;
  await run(config, `touch ${JOBS_ROOT}/${jobId}/reported`, { timeoutMs: 30000 });
}

/** Jobs still running: they carry a ticket and have not written an exit code. */
export async function listRunningJobs(config, deps = {}) {
  const { run = execInBox } = deps;
  const script = [
    `for d in ${JOBS_ROOT}/*/; do`,
    `  [ -f "$d/slack.json" ] || continue`,
    `  [ -f "$d/exit.code" ] && continue`,
    `  cat "$d/slack.json"; echo`,
    'done',
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 60000 });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Stops a running job. Kills the whole process group, because claude spawns
 * children (bg-pty-host, subagents) that outlive their parent shell otherwise.
 * Writes an exit code so the poller and any later boot see a finished job
 * rather than waiting on one that will never report.
 *
 * 143 is 128+SIGTERM, the shell convention for "terminated", which is how
 * describeResult tells a stop apart from a crash.
 */
export async function stopJob(config, jobId, deps = {}) {
  const { run = execInBox } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const script = [
    `[ -d ${dir} ] || { echo "no such job"; exit 0; }`,
    `[ -f ${dir}/exit.code ] && { echo "already finished"; exit 0; }`,
    // Preferred: the recorded pid, killed as a group.
    `if [ -f ${dir}/pid ]; then kill -TERM -"$(cat ${dir}/pid)" 2>/dev/null || kill -TERM "$(cat ${dir}/pid)" 2>/dev/null; fi`,
    // Fallback for jobs started before pids were recorded: match the runner path.
    `pkill -TERM -f "${dir}/run.sh" 2>/dev/null`,
    `pkill -TERM -f "${dir}/task.txt" 2>/dev/null`,
    `sleep 2`,
    `echo 143 > ${dir}/exit.code`,
    `echo stopped`,
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 60000 });
  return stdout.trim();
}

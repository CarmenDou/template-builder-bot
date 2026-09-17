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
];

export function newJobId(now = Date.now(), rand = () => crypto.randomBytes(3).toString('hex')) {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${rand()}`;
}

// A job runs for tens of minutes. Without this the requester gets one message at
// the start and then silence, and cannot tell a long build from a dead agent.
export function stageInstructions(dir) {
  return `## Reporting progress

Append ONE line to \`${dir}/stage.txt\` at each of these four moments, and only these four. Someone
is watching from Slack and this file is the only way they know you are alive.

    triage: <verdict> — one line of why
    pr: <url> — what you are waiting on next
    build: <green|red> — what happens next
    verify: <what you actually proved, not what you ran>

Append, never rewrite, and keep each to one line. Write the triage line before you start writing
files, not after.`;
}

export function buildTask({ url, extra, dir }) {
  const hint = extra ? `\n\nExtra instructions from the requester: ${extra}` : '';
  const stages = dir ? `\n\n${stageInstructions(dir)}` : '';
  return `Turn ${url} into an InstaCloud template.

Follow your CLAUDE.md end to end: triage it against the five judgements, create a fresh project for
this job, write the manifest, open a DRAFT PR on InsForge/instacloud-oss, deploy and verify it
(including one real request that exercises what the app actually does, not just the health gate),
put the evidence and the verification entry points in the PR body, then stop. Do not publish.

Finish your reply with a section headed RESULT containing, one per line:
  verdict: <directly-usable | thin-shell | tool-not-service | out>
  project: <project id, or none>
  service: <public URL, or none>
  pr: <PR url, or none>
  asks: <what you need a human to settle, or none>${hint}${stages}`;
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
  asks: <anything still needing a human, or none>${stages}`;
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
export async function startJob(config, { url, pr, extra }, deps = {}) {
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
  const runner = [
    'export PATH="/data/home/.insta/bin:/data/home/bin:$PATH"',
    `cd ${dir}`,
    // No `set -e`: a failing claude must still reach the next line, because
    // exit.code is what the poller waits for.
    `claude -p "$(cat ${dir}/task.txt)" --allowedTools ${tools} > ${dir}/out.log 2>&1`,
    `echo $? > ${dir}/exit.code`,
    '',
  ].join('\n');
  const runnerB64 = Buffer.from(runner, 'utf8').toString('base64');

  const script = [
    'set -e',
    `mkdir -p ${dir}`,
    `printf '%s' '${taskB64}' | base64 -d > ${dir}/task.txt`,
    `printf '%s' '${runnerB64}' | base64 -d > ${dir}/run.sh`,
    `nohup sh ${dir}/run.sh > /dev/null 2>&1 < /dev/null &`,
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
  return {
    verdict: field('verdict'),
    project: field('project'),
    service: field('service'),
    pr: field('pr'),
    asks: field('asks'),
  };
}

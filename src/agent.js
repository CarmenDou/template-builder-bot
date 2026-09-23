import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

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

const lines = (block) =>
  String(block ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

// Read once at module load: it ships with this repo and lands in every job dir.
const STEPS_JS = readFileSync(new URL('./box/steps.js', import.meta.url), 'utf8');
// How whoever started a job follows it. Rewritten on every start rather than
// installed once, so the box always has the version this code expects.
const JOB_FEED_JS = readFileSync(new URL('./box/job-feed.js', import.meta.url), 'utf8');

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

/**
 * What the agent is handed when someone speaks while it is working.
 *
 * It has to carry the instruction to CARRY ON. Resumed with the person's words
 * alone, the agent answers them and exits, and the job is over: a question like
 * "how is it going" would end the template.
 */
export function buildSteerPrompt(message) {
  return `The person watching in Slack said this while you were working:

${message}

You were interrupted part way through a step to be given it, so before you act, check what state
you actually left behind. A push, a deploy or a CI build may have gone out and still be running,
and repeating one of those is worse than the interruption was.

Then carry on with the same job, taking what they said into account. If it was a question, answer
it in a sentence or two and keep going. If it changes the plan, append one \`note:\` line to your
stage file saying what you changed.

Nothing else about the job changes. Finish the way you were going to, with the RESULT section.`;
}

/**
 * What the agent is handed when someone comes back to a job it already finished.
 *
 * Not the steering prompt: nothing was interrupted, time has passed, and a person
 * may have touched what it left behind. It has to look before it acts, and it has
 * to report again, because a watcher treats the new RESULT as the answer.
 */
export function buildResumePrompt(message) {
  return `The job you did has finished, and the person who asked for it is back with this:

${message}

Everything you did is still here: this job directory, your clones, the project you deployed into,
the credentials you created and the PR. Do what they ask, on those same things. Check the state they
are actually in before you change anything, since time has passed and someone may have touched them.

Append a line to your stage file for each thing you do, as before, so they can follow along. Finish
with a RESULT section again: repeat last time's fields and change only the ones that changed.`;
}

// Identical for a fresh start and for a resume; only the claude invocation
// differs. Both end by writing the exit.code the poller waits on.
function runnerScript(dir, claudeLine) {
  return [
    'export PATH="/data/home/.insta/bin:/data/home/bin:$PATH"',
    // Own pid, recorded before any work, so the job can be stopped or steered later.
    `echo $$ > ${dir}/pid`,
    `cd ${dir}`,
    // Chromium sits on the volume but its shared libraries sit on the root disk,
    // which a restart wipes. Cheap check; the install runs once after a restart.
    `if ! dpkg -s libnss3 >/dev/null 2>&1 || ! ls /data/home/.cache/ms-playwright 2>/dev/null | grep -q chromium; then`,
    `  npx -y ${PLAYWRIGHT} install --with-deps chromium > ${dir}/setup.log 2>&1`,
    'fi',
    // No `set -e`: a failing claude must still reach the next line, because
    // exit.code is what the poller waits for.
    //
    // The stream goes through steps.js, which splits it into the live trace and
    // the agent's prose while passing it through to the archive. `$?` after a
    // pipeline is the SPLITTER's status, so claude's own is captured inside the
    // braces and only becomes exit.code once the splitter has flushed.
    `{ ${claudeLine} < /dev/null ; echo $? > ${dir}/claude.exit ; } 2>> ${dir}/stderr.log | node ${dir}/steps.js ${dir} >> ${dir}/out.jsonl`,
    `cp ${dir}/claude.exit ${dir}/exit.code 2>/dev/null || echo 99 > ${dir}/exit.code`,
    '',
  ].join('\n');
}

const claudeFlags = (dir) =>
  `--allowedTools ${ALLOWED_TOOLS.map((t) => `'${t}'`).join(' ')} --mcp-config ${dir}/mcp.json --strict-mcp-config --output-format stream-json --verbose`;

// A job runs for tens of minutes. Without this the requester gets one message at
// the start and then silence, and cannot tell a long build from a dead agent.
export function stageInstructions(dir) {
  return `## Reporting progress

Append ONE line to \`${dir}/stage.txt\` each time you finish one of these, in this order. Someone is
watching from Slack, and this file is the only thing they see. Append, never rewrite.

    triage: <verdict> — one line of why
    manifest: <what you wrote> — the overlay too, if there is one
    pr: <url> — what you are waiting on next
    build: <green|red> — what happens next
    deploy: <url> — or what failed and what you are trying
    verify: reach ✓  enter ✓  round-trip ✓  survive ✓

Write the triage line before you start writing files, not after.

The verify line is the four verdicts from CLAUDE.md, in that order, never free text: the reader
counts ticks. A failure carries its reason inline, \`round-trip ✗ search returned nothing\`. An
item that cannot apply is \`—\` plus a word, \`survive — stateless\`.

**If a step takes more than about five minutes, append a line before it is done**, saying what you
are working on and what you are waiting for. Twenty minutes of silence in the middle of a deploy is
the worst thing this file can do, and it is exactly when the person is most curious:

    deploy: migration stalled after creating the postgres extensions, reading logs before I touch anything
    deploy: redis reachable and the TLS handshake is fine, so it is the migration and not the queue

Use \`note:\` for something unexpected that changed your plan, and only for that:

    note: a draft PR already existed (#149), so I am continuing that one rather than opening a second

**One sentence each.** These are the only words anybody reads while you work: the detail goes in the
PR body. Say what you did and what it means, never what you typed.`;
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
  created: <something you made that a human needs in order to carry on>
  ask: <one thing a human has to settle>

Repeat either line once per thing, or leave it out entirely if there is nothing. One sentence each.
For \`ask\`, name the decision rather than arguing it: the reasoning belongs in the PR body, and a
reader who needs it will open the PR. Five of them run together in one paragraph is a wall nobody
reads.

**\`created\` is where the real values go.** This block is read out in a private Slack channel, not
in the PR, so unlike the PR body it carries the account you signed up, the password you actually
typed, and the records you seeded. Whoever picks this up has to sign in as you did, and the platform
cannot help them: template variable values are write-only. Give them everything they need.

Only what you BROUGHT INTO EXISTENCE. The credentials you were HANDED to do the job with, the GitHub
token and the platform key on this box, are never reported anywhere, in any channel, for any
reason.${hint}${stages}`;
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
  created: <something you made that a human needs in order to carry on>
  ask: <one thing a human has to settle>

Repeat either line once per thing, or leave it out entirely if there is nothing. One sentence each.

\`created\` is read out in a private Slack channel rather than in the PR, so it carries the real
values: the account you signed up, the password you typed, the records you seeded. Only what you
brought into existence, though. The GitHub token and platform key you were handed are never
reported anywhere.${stages}`;
}

// argv, never a shell string, so a repo name can never become a command.
function spawn(file, args, { timeoutMs = 120000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// CLAUDECODE is stripped because the CLI switches to agent mode when it is set,
// and agent mode is a different credential than the one this process holds.
const instaEnv = (config) => ({
  ...process.env,
  INSTA_PROJECT_ID: config.agentProjectId,
  CLAUDECODE: undefined,
});

function execInsta(config, args, opts) {
  return spawn(config.instaBin, args, { ...opts, env: instaEnv(config) });
}

/**
 * How this process reaches the agent box, as argv.
 *
 * Over ssh when the box has been set up for it, because `compute exec` caps a
 * command at 64KB of argv and 180 seconds and drops the channel on a long one.
 * Over exec otherwise, which is what the CLI's own help points automation at
 * and what the tests and any machine without a certificate get.
 *
 * BatchMode because nothing here can answer a prompt, and -F because ssh finds
 * ~/.ssh/config through the passwd entry rather than $HOME: the account this
 * runs as has a different home than the one holding the certificate.
 */
export function boxCommand(config, script) {
  if (config.sshConfig) {
    return {
      file: 'ssh',
      args: [
        '-F',
        config.sshConfig,
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=25',
        // The config the setup writes puts the control socket under `~`, which
        // for a service account is a root-disk home that a restart wipes. The
        // multiplexing is not worth a dependency on a directory that vanishes.
        '-o',
        'ControlMaster=no',
        config.sshAlias,
        script,
      ],
      env: process.env,
    };
  }
  return {
    file: config.instaBin,
    args: ['compute', 'exec', config.agentService, '--', 'sh', '-c', script],
    env: instaEnv(config),
  };
}

// ssh certificates are short-lived, about an hour. The config block the setup
// writes renews them itself, through a `Match exec` line, but that line calls a
// bare `insta` and a `~` path that only resolve on a machine set up by hand, and
// renewing REWRITES the block, so patching either one does not survive. Renewing
// from here does: it depends on nothing outside this process and the volume.
async function renewCertificate(config) {
  await execInsta(config, ['compute', 'ssh', config.agentService, '--ensure-cert', config.sshAlias], {
    timeoutMs: 60000,
  });
}

// An expired certificate looks like any other ssh failure, so rather than read
// the expiry, spend one retry on it. The happy path pays nothing.
export function execInBox(config, script, opts, deps = {}) {
  const { run = spawn, renew = renewCertificate } = deps;
  const { file, args, env } = boxCommand(config, script);
  if (file !== 'ssh') return run(file, args, { ...opts, env });

  return run(file, args, { ...opts, env }).catch(async (error) => {
    await renew(config).catch(() => {
      // Report the ssh failure, not the renewal's: the caller asked for the box.
      throw error;
    });
    return run(file, args, { ...opts, env });
  });
}

export async function ensureLogin(config, run = execInsta) {
  await run(config, ['login', '--api-key', config.instaApiKey], { timeoutMs: 60000 });
}

/**
 * Starts the agent and returns as soon as it is running. Does NOT wait for it.
 */
export async function startJob(config, { url, pr, extra, slack }, deps = {}) {
  const { run = execInBox, jobId = newJobId(), sessionId = crypto.randomUUID() } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const task = pr ? buildFollowupTask({ pr, extra, dir }) : buildTask({ url, extra, dir });

  // Both the task and the runner travel as base64 and land as files. Quoting a
  // runner inline does not survive: `sh -c '... --allowedTools 'Read' ...'` ends
  // the outer quote at the first inner one, which leaves `Bash(insta *)` bare in
  // the shell (`Syntax error: "(" unexpected`) and eats the `*` as a glob.
  const taskB64 = Buffer.from(task, 'utf8').toString('base64');

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

  // The session id is ours, chosen up front rather than scraped back out of the
  // output, so steering later is `--resume <that>` with no bookkeeping in between.
  const runner = runnerScript(
    dir,
    `claude -p "$(cat ${dir}/task.txt)" --session-id ${sessionId} ${claudeFlags(dir)}`,
  );
  const runnerB64 = Buffer.from(runner, 'utf8').toString('base64');

  // Who to answer, written next to the job. The bot's own memory does not
  // survive a redeploy, and the agent keeps running when the bot restarts, so a
  // job whose thread lived only in memory finishes with nobody listening.
  const ticket = Buffer.from(
    JSON.stringify({ jobId, sessionId, url: url ?? (pr ? `PR #${pr}` : 'unknown'), ...slack }),
    'utf8',
  ).toString('base64');

  const stepsB64 = Buffer.from(STEPS_JS, 'utf8').toString('base64');
  const feedB64 = Buffer.from(JOB_FEED_JS, 'utf8').toString('base64');

  const script = [
    'set -e',
    `mkdir -p ${dir}`,
    `printf '%s' '${taskB64}' | base64 -d > ${dir}/task.txt`,
    `printf '%s' '${stepsB64}' | base64 -d > ${dir}/steps.js`,
    'mkdir -p /data/home/bin',
    `printf '%s' '${feedB64}' | base64 -d > /data/home/bin/job-feed && chmod 755 /data/home/bin/job-feed`,
    `printf '%s' '${runnerB64}' | base64 -d > ${dir}/run.sh`,
    `printf '%s' '${mcpB64}' | base64 -d > ${dir}/mcp.json`,
    `printf '%s' '${ticket}' | base64 -d > ${dir}/slack.json`,
    // Also beside the job, so steering works even if the ticket is unreadable.
    `printf '%s' '${sessionId}' > ${dir}/session`,
    `nohup setsid sh ${dir}/run.sh > /dev/null 2>&1 < /dev/null &`,
    'echo started',
  ].join('\n');

  await run(config, script, { timeoutMs: 120000 });
  return { jobId, dir, sessionId };
}

/**
 * Hands a job's own agent something a human just said, whether or not the job is
 * still running, and lets it carry on.
 *
 * A running agent is killed and resumed rather than interrupted in place: `claude
 * -p` has no channel to speak into once it is running. That costs the step in
 * flight and nothing else, because the session file is written turn by turn, so
 * `--resume` picks up everything already done.
 *
 * A finished one is resumed in the same session. It is the only thing with the
 * browser, the platform login for the project it deployed into and the
 * credentials it created, so follow-up work on what it built belongs to it rather
 * than to whoever is relaying. Its old exit.code is removed so a follower sees
 * the new stretch as running, not as the end of the old one.
 *
 * Never writes exit.code itself: the job has not finished, and whoever is
 * watching must stay attached across the restart.
 *
 * Answers `steered <offset> <stages>` or `resumed <offset> <stages>`, where the
 * numbers are where a follower should pick up from.
 */
export async function steerJob(config, jobId, message, deps = {}) {
  const { run = execInBox } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const duringB64 = Buffer.from(buildSteerPrompt(message), 'utf8').toString('base64');
  const afterB64 = Buffer.from(buildResumePrompt(message), 'utf8').toString('base64');

  // `$(cat session)` rather than a baked id: the file is the record, and it is
  // right even for a job this process did not start.
  const runner = runnerScript(
    dir,
    `claude --resume "$(cat ${dir}/session)" -p "$(cat ${dir}/steer.txt)" ${claudeFlags(dir)}`,
  );
  const runnerB64 = Buffer.from(runner, 'utf8').toString('base64');

  const script = [
    `[ -d ${dir} ] || { echo "no such job"; exit 0; }`,
    `[ -f ${dir}/session ] || { echo "no session to resume"; exit 0; }`,
    `if [ -f ${dir}/exit.code ]; then`,
    `  mode=resumed`,
    `  printf '%s' '${afterB64}' | base64 -d > ${dir}/steer.txt`,
    `  rm -f ${dir}/exit.code ${dir}/claude.exit`,
    `else`,
    `  mode=steered`,
    `  if [ -f ${dir}/pid ]; then kill -TERM -"$(cat ${dir}/pid)" 2>/dev/null || kill -TERM "$(cat ${dir}/pid)" 2>/dev/null; fi`,
    `  pkill -TERM -f "${dir}/run.sh" 2>/dev/null`,
    '  sleep 2',
    `  printf '%s' '${duringB64}' | base64 -d > ${dir}/steer.txt`,
    `fi`,
    `printf '%s' '${runnerB64}' | base64 -d > ${dir}/run.sh`,
    `nohup setsid sh ${dir}/run.sh > /dev/null 2>&1 < /dev/null &`,
    `echo "$mode $(wc -c < ${dir}/out.jsonl 2>/dev/null || echo 0) $(grep -c . ${dir}/stage.txt 2>/dev/null || echo 0)"`,
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 120000 });
  return stdout.trim();
}

/**
 * What a job did since the caller last looked, waiting up to `waitSeconds` for it
 * to do something. Answers early when a milestone lands or the job ends.
 *
 * The wait happens on the box, inside job-feed, so the caller has one call to make
 * in a loop and no sleep of its own to get wrong. `offset` and `stages` come back
 * in the result and go straight into the next call.
 */
export async function jobFeed(config, jobId, { offset = 0, stages = 0, waitSeconds = 45 } = {}, deps = {}) {
  const { run = execInBox } = deps;
  if (!/^[\w-]+$/.test(String(jobId))) throw new Error(`not a job id: ${jobId}`);
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const { stdout } = await run(
    config,
    `/data/home/bin/job-feed ${jobId} ${n(offset)} ${n(stages)} ${n(waitSeconds)}`,
    { timeoutMs: (n(waitSeconds) + 60) * 1000 },
  );
  const lines = stdout.trim().split('\n');
  const tail = lines.at(-1) ?? '';
  const m = tail.match(/^next: (\d+) (\d+) status: (running|done exit=(-?\d+))$/);
  if (!m) throw new Error(`job-feed answered with something else: ${tail.slice(0, 200)}`);
  return {
    activity: lines.slice(0, -1),
    offset: Number(m[1]),
    stages: Number(m[2]),
    done: m[3] !== 'running',
    exitCode: m[4] === undefined ? null : Number(m[4]),
  };
}

export async function readJob(config, jobId, deps = {}) {
  const { run = execInBox } = deps;
  const dir = `${JOBS_ROOT}/${jobId}`;
  const script = [
    `if [ -f ${dir}/exit.code ]; then echo "STATUS done $(cat ${dir}/exit.code)"; else echo "STATUS running"; fi`,
    `echo "---STAGES---"`,
    `cat ${dir}/stage.txt 2>/dev/null || true`,
    `echo "---STEPS---"`,
    // Whole, not tailed: the trace is the history someone scrolls back through,
    // and a window would quietly drop the beginning of a long job.
    `cat ${dir}/steps.txt 2>/dev/null || true`,
    `echo "---LOG---"`,
    `tail -c 12000 ${dir}/out.log 2>/dev/null || true`,
  ].join('\n');

  const { stdout } = await run(config, script, { timeoutMs: 60000 });
  // Split from the outside in, so a missing marker loses that one section
  // instead of folding the rest of the output into the section before it.
  const [head, ...afterStages] = stdout.split('---STAGES---');
  const [beforeLog, ...rest] = afterStages.join('---STAGES---').split('---LOG---');
  const [stageBlock, ...stepParts] = beforeLog.split('---STEPS---');
  const stepBlock = stepParts.join('---STEPS---');
  const statusLine = head.trim().split(/\s+/);
  const done = statusLine[1] === 'done';
  return {
    done,
    exitCode: done ? Number(statusLine[2]) : null,
    stages: lines(stageBlock),
    // Every tool the agent has called, newest last. The stages are landmarks; this
    // is the trace between them, and the only thing that moves during a long step.
    steps: lines(stepBlock),
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
  // One line per thing. Five of them on one line is a wall nobody reads, so the
  // block carries them separately all the way to Slack.
  const lines = (name) =>
    [...block.matchAll(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'gim'))]
      .map((m) => m[1].trim())
      .filter((v) => v && v.toLowerCase() !== 'none');

  const asks = lines('ask');
  const legacy = field('asks');
  if (!asks.length && legacy) asks.push(legacy);

  return {
    verdict: field('verdict'),
    project: field('project'),
    service: field('service'),
    pr: field('pr'),
    created: lines('created'),
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

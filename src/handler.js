import { parseCommand } from './command.js';
import { startJob, readJob, parseResult } from './agent.js';

const HELP =
  'Give me a GitHub repository URL and I will try to turn it into an InstaCloud template ' +
  'draft PR.\nExample: `@template-builder https://github.com/owner/repo`\n' +
  'To change a template I already drafted, name its PR: `@template-builder #145 use the small model`';

export function describeStart({ url, jobId, followup = false }) {
  if (followup) {
    return `Picking ${url} back up.\nJob \`${jobId}\`. I will push to the same branch, let CI rebuild, redeploy and re-verify, then update the PR body. It stays a draft.`;
  }
  return `On it: \`${url}\`\nJob \`${jobId}\`. Triage first, then a draft PR, then a real deploy to verify. This usually takes 10 to 30 minutes and I will report back here.`;
}

export function describeResult({ url, jobId, exitCode, result, log }) {
  if (result) {
    const lines = [`Done with \`${url}\` (job \`${jobId}\`).`];
    if (result.verdict) lines.push(`Verdict: *${result.verdict}*`);
    if (result.pr) lines.push(`Draft PR: ${result.pr}`);
    if (result.service) lines.push(`Deployed for you to check: ${result.service}`);
    if (result.project) lines.push(`Project: \`${result.project}\` (kept, not deleted)`);
    if (result.asks) lines.push(`\nNeeds you to settle: ${result.asks}`);
    lines.push('\nNothing was published. Verifying and merging is yours.');
    return lines.join('\n');
  }

  // No RESULT block: report honestly rather than inventing an outcome.
  const tail = log ? `\n\`\`\`\n${log.slice(-1200)}\n\`\`\`` : '';
  return `Job \`${jobId}\` for \`${url}\` ended with exit code ${exitCode} but did not print a RESULT block, so I cannot tell you what it concluded. Last output:${tail}`;
}

export function describeTimeout({ url, jobId, log }) {
  const tail = log ? `\n\`\`\`\n${log.slice(-800)}\n\`\`\`` : '';
  return `Job \`${jobId}\` for \`${url}\` is still running past the timeout. It has NOT been killed, so it may still finish. Last output:${tail}`;
}

/**
 * Decides what to do with one mention. Returns { reply, job } where job is
 * non-null only when work actually started.
 */
export async function handleMention({ event, config, deps = {} }) {
  const { start = startJob } = deps;

  if (!config.allowedChannels.includes(event.channel)) {
    // Silence rather than a refusal message: a bot that answers in channels it
    // does not serve is a bot that can be baited into noise.
    return { reply: null, job: null };
  }

  const { kind, repos, pr, extra } = parseCommand(event.text ?? '');

  if (kind === 'followup') {
    const { jobId } = await start(config, { pr, extra });
    const label = `PR #${pr}`;
    return { reply: describeStart({ url: label, jobId, followup: true }), job: { jobId, url: label } };
  }

  if (kind === 'none') return { reply: HELP, job: null };
  if (repos.length > 1) {
    return {
      reply: `I see ${repos.length} repositories in that message. Send them one at a time so each gets its own PR.`,
      job: null,
    };
  }

  const { url } = repos[0];
  const { jobId } = await start(config, { url, extra });
  return { reply: describeStart({ url, jobId }), job: { jobId, url } };
}

/**
 * Polls until the agent writes its exit code, then returns the message to post.
 * Never throws for job failure: a failed job is a report, not a crash.
 */
export async function followJob({ config, job, deps = {} }) {
  const { read = readJob, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = deps;
  const deadline = now() + config.jobTimeoutMs;
  let last = { log: '' };

  while (now() < deadline) {
    await sleep(config.pollIntervalMs);
    try {
      last = await read(config, job.jobId);
    } catch (error) {
      // A dropped exec channel is expected on a busy box; keep polling.
      continue;
    }
    if (last.done) {
      return describeResult({
        url: job.url,
        jobId: job.jobId,
        exitCode: last.exitCode,
        result: parseResult(last.log ?? ''),
        log: last.log,
      });
    }
  }

  return describeTimeout({ url: job.url, jobId: job.jobId, log: last.log });
}

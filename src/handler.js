import { parseCommand, findPrInThread, findJobIdInThread, renderThread, isStopRequest, stripMention } from './command.js';
import { startJob, readJob, parseResult, listRunningJobs, stopJob, steerJob } from './agent.js';
import { fetchThread } from './slack.js';

const HELP = [
  'I turn a GitHub repository into an InstaCloud template draft PR. A human verifies it and decides whether to publish; I never publish.',
  '',
  '`@template-builder https://github.com/owner/repo` — start a new template',
  '`@template-builder #145 use the small model` — change one I already drafted',
  '`@template-builder stop` — stop what is running (already pushed work stays pushed)',
  '',
  'Inside a thread I already replied in, you can leave the number out: I read the thread for it.',
].join('\n');

/** `https://github.com/twentyhq/twenty` reads as `twentyhq/twenty` in a headline. */
function repoName(url) {
  return url.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '') || url;
}

export function describeStart({ url, jobId, followup = false }) {
  // A follow-up is always handed the `PR #147` label, never a repository URL.
  if (followup) {
    return `Picking \`${url}\` back up.\nI push to the same branch, let CI rebuild, redeploy and re-verify, then update the PR body. It stays a draft. (job \`${jobId}\`)`;
  }
  return `On it: \`${repoName(url)}\`\nTriage first, then a draft PR, then a real deploy to verify. Usually 10 to 30 minutes, and I report back here. (job \`${jobId}\`)`;
}

export function describeResult({ url, jobId, exitCode, result, log }) {
  if (result) {
    const headline = result.verdict
      ? `Done with \`${repoName(url)}\` — *${result.verdict}*`
      : `Done with \`${repoName(url)}\`.`;
    const lines = [headline, ''];

    // The deployment first: the first thing a reviewer does is open it and click
    // around. The PR is what they read afterwards, once it looks real.
    if (result.service) lines.push(`Open: ${result.service}`);
    if (result.pr) lines.push(`Draft PR: ${result.pr}`);
    if (result.project) lines.push(`Project: ${result.project} (kept, not deleted)`);

    // The values that exist nowhere else. Template variables are write-only, so
    // the platform cannot hand these back, and the PR must not carry them: this
    // private channel is the only place a reviewer can pick them up.
    const created = result.created ?? [];
    if (created.length) {
      lines.push('', '*What it created* (this channel only, never the PR)', ...created.map((c) => `• ${c}`));
    }

    const asks = result.asks ?? [];
    if (asks.length) {
      lines.push('', `*Needs you to settle*`, ...asks.map((a) => `• ${a}`));
    }

    lines.push('', `Nothing was published. Verifying and merging is yours. (job \`${jobId}\`)`);
    return lines.join('\n');
  }

  if (exitCode === 143) {
    return `Job \`${jobId}\` for \`${url}\` was stopped. Anything it had already pushed is still there; nothing was reverted.`;
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
  const {
    start = startJob,
    thread = fetchThread,
    read = readJob,
    running = listRunningJobs,
    stop = stopJob,
    steer = steerJob,
  } = deps;

  // Two agents on one PR both push to the same branch and both rewrite the body,
  // so the slower one silently overwrites the better one. Never start a second.
  const alreadyOn = async (subject) => {
    const jobs = await running(config).catch(() => []);
    return jobs.find((j) => j.url === subject) ?? null;
  };

  // Which is not a reason to ignore the person. The one agent already on it gets
  // what they said and carries on, so the guard holds and the thread still works.
  const handOver = async (busy, said) => {
    const outcome = await steer(config, busy.jobId, said).catch((error) => `failed: ${error.message}`);
    if (!/^steered/.test(outcome)) {
      return {
        reply: `I could not pass that to the agent working on \`${busy.url}\` (job \`${busy.jobId}\`): ${outcome}. It is still running.`,
        job: null,
      };
    }
    return {
      reply: `Passed that to the agent already on \`${busy.url}\` (job \`${busy.jobId}\`). It picks up from where it was, keeping what it has done.`,
      job: null,
    };
  };
  const slack = { channel: event.channel, threadTs: event.thread_ts ?? event.ts };

  if (!config.allowedChannels.includes(event.channel)) {
    // Silence rather than a refusal message: a bot that answers in channels it
    // does not serve is a bot that can be baited into noise.
    return { reply: null, job: null };
  }

  // A stop is answered before any parsing of what to build: "stop #147" must
  // never be read as "work on 147".
  if (isStopRequest(event.text ?? '')) {
    const jobs = await running(config).catch(() => []);
    if (jobs.length === 0) return { reply: 'Nothing is running.', job: null };

    const wanted = event.thread_ts
      ? jobs.filter((j) => j.threadTs === event.thread_ts)
      : jobs;
    const targets = wanted.length > 0 ? wanted : jobs;

    const results = [];
    for (const j of targets) {
      const outcome = await stop(config, j.jobId).catch((e) => `failed: ${e.message}`);
      results.push(`\`${j.jobId}\` (${j.url}) — ${outcome}`);
    }
    return {
      reply: `Stopped ${results.length === 1 ? 'it' : results.length + ' jobs'}:\n${results.join('\n')}\n\nAnything already pushed stays pushed; nothing is reverted.`,
      job: null,
    };
  }

  const { kind, repos, pr, extra } = parseCommand(event.text ?? '');

  if (kind === 'followup') {
    const busy = await alreadyOn(`PR #${pr}`);
    if (busy) return handOver(busy, extra || stripMention(event.text ?? ''));
    const { jobId } = await start(config, { pr, extra, slack });
    const label = `PR #${pr}`;
    return { reply: describeStart({ url: label, jobId, followup: true }), job: { jobId, url: label } };
  }

  if (kind === 'none') {
    // Nothing actionable in the message itself. If this is a reply inside a
    // thread, the thread probably names the PR and carries what "as discussed
    // above" refers to, so read it before giving up.
    if (event.thread_ts) {
      const { messages } = await thread({
        token: config.slackBotToken,
        channel: event.channel,
        threadTs: event.thread_ts,
      });
      // The PR link is the cheap path. When the final report never made it to
      // the thread, the job id in "On it" still leads to the same answer.
      let threadPr = findPrInThread(messages);
      if (!threadPr) {
        const jobId = findJobIdInThread(messages);
        if (jobId) {
          const state = await read(config, jobId).catch(() => null);
          const prUrl = parseResult(state?.log ?? '')?.pr;
          const m = prUrl?.match(/\/pull\/(\d+)/);
          if (m) threadPr = Number(m[1]);
        }
      }
      if (threadPr) {
        const busy = await alreadyOn(`PR #${threadPr}`);
        if (busy) return handOver(busy, stripMention(event.text ?? ''));
        const context = renderThread(messages, { botUserId: config.botUserId });
        const { jobId } = await start(config, {
          pr: threadPr,
          extra: extra ? `${extra}\n\nThe thread this came from:\n${context}` : context,
          slack,
        });
        const label = `PR #${threadPr}`;
        return {
          reply: describeStart({ url: label, jobId, followup: true }),
          job: { jobId, url: label },
        };
      }
    }
    return { reply: HELP, job: null };
  }
  if (repos.length > 1) {
    return {
      reply: `I see ${repos.length} repositories in that message. Send them one at a time so each gets its own PR.`,
      job: null,
    };
  }

  const { url } = repos[0];
  const busy = await alreadyOn(url);
  if (busy) return handOver(busy, extra || stripMention(event.text ?? ''));
  const { jobId } = await start(config, { url, extra, slack });
  return { reply: describeStart({ url, jobId }), job: { jobId, url } };
}

/**
 * One line the agent appended to stage.txt, rendered for the thread. The stage
 * name carries the bold so four of these scroll past as four landmarks rather
 * than four paragraphs.
 */
export function formatStage(line) {
  const m = String(line).match(/^\s*([a-z]+):\s*(.+)$/is);
  return m ? `• *${m[1]}* ${m[2].trim()}` : `• ${line}`;
}

/**
 * Polls until the agent writes its exit code, then returns the message to post.
 * Posts each new stage line on the way, because a job runs for tens of minutes
 * and silence is indistinguishable from a dead agent.
 * Never throws for job failure: a failed job is a report, not a crash.
 */
export async function followJob({ config, job, say, deps = {} }) {
  const { read = readJob, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = deps;
  const deadline = now() + config.jobTimeoutMs;
  let last = { log: '', stages: [] };
  let reported = 0;

  while (now() < deadline) {
    await sleep(config.pollIntervalMs);
    try {
      last = await read(config, job.jobId);
    } catch (error) {
      // A dropped exec channel is expected on a busy box; keep polling.
      continue;
    }

    // A failure to post progress must never end the watch: the final report
    // matters more than any one update.
    if (say && Array.isArray(last.stages)) {
      for (const line of last.stages.slice(reported)) {
        await say(formatStage(line)).catch(() => {});
      }
      reported = last.stages.length;
    }

    if (last.done) {
      return {
        finished: true,
        text: describeResult({
          url: job.url,
          jobId: job.jobId,
          exitCode: last.exitCode,
          result: parseResult(last.log ?? ''),
          log: last.log,
        }),
      };
    }
  }

  // Not finished, just out of patience. The caller must NOT mark this job
  // answered: the agent is still working and its real result is still coming.
  return { finished: false, text: describeTimeout({ url: job.url, jobId: job.jobId, log: last.log }) };
}

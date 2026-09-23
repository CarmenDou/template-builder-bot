import { readJob, parseResult } from './agent.js';
import { postMessage, updateMessage } from './slack.js';
import { describeResult, describeTimeout, formatStage } from './handler.js';

// How many trace lines the live message shows. Enough to see what it is doing
// now and how it got here; more than this and the message stops being glanceable.
const TRACE_LINES = 8;

/** The live trace, as one code block so a long command wraps instead of reflowing. */
export function renderTrace(steps, done = false) {
  const shown = steps.slice(-TRACE_LINES);
  const hidden = steps.length - shown.length;
  const head = done ? 'Finished' : 'Working';
  return [
    `${head} — ${steps.length} step${steps.length === 1 ? '' : 's'}`,
    '```',
    ...(hidden > 0 ? [`… ${hidden} earlier`] : []),
    ...shown,
    '```',
  ].join('\n');
}

/**
 * Follows a running job and speaks into the thread on its own, so nobody has to
 * ask. Three different things go to three different places:
 *
 *   stages  one message each, because they are the landmarks worth scrolling to
 *   steps   ONE message, rewritten, because there are hundreds of them
 *   result  one message at the end, which is the point of the whole job
 *
 * Every Slack call is allowed to fail without ending the watch: the final report
 * matters more than any one update, and a job nobody hears about is the bug.
 */
export async function watchJob(config, job, deps = {}) {
  const {
    read = readJob,
    post = postMessage,
    update = updateMessage,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = deps;

  const { channel, threadTs } = job;
  const token = config.slackBotToken;
  const say = (text) => post({ token, channel, threadTs, text }).catch(() => null);

  const deadline = now() + config.jobTimeoutMs;
  let reported = 0;
  let traceTs = null;
  let shown = '';
  let state = { stages: [], steps: [], log: '' };

  while (now() < deadline) {
    await sleep(config.pollIntervalMs);
    try {
      state = await read(config, job.jobId);
    } catch {
      // A dropped exec channel is ordinary on a busy box; keep watching.
      continue;
    }

    for (const line of (state.stages ?? []).slice(reported)) await say(formatStage(line));
    reported = (state.stages ?? []).length;

    const trace = renderTrace(state.steps ?? [], state.done);
    if (trace !== shown && (state.steps ?? []).length > 0) {
      shown = trace;
      if (traceTs) {
        await update({ token, channel, ts: traceTs, text: trace }).catch(() => null);
      } else {
        const sent = await post({ token, channel, threadTs, text: trace }).catch(() => null);
        traceTs = sent?.ts ?? null;
      }
    }

    if (state.done) {
      await say(
        describeResult({
          url: job.url,
          jobId: job.jobId,
          exitCode: state.exitCode,
          result: parseResult(state.log ?? ''),
          log: state.log,
        }),
      );
      return { finished: true };
    }
  }

  await say(describeTimeout({ url: job.url, jobId: job.jobId, log: state.log }));
  return { finished: false };
}

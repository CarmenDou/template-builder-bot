import { readJob, parseResult } from './agent.js';
import { postMessage, updateMessage } from './slack.js';
import { describeResult, describeTimeout, formatStage } from './handler.js';

// Slack refuses a message over 4000 characters. Leaving room means a line can
// always be added without the update failing, and the next line starts a new
// message rather than the trace losing its head.
const ROOM = 3600;

/** The trace so far, as one growing message. Nothing is dropped. */
export function renderTrace(lines, { done = false, first = true } = {}) {
  const head = first ? (done ? 'Finished' : 'Working') : 'Working, continued';
  return [head, ...lines.map((l) => `• ${l}`)].join('\n');
}

/**
 * Splits the trace at the last line that still fits.
 * Returns what to show now and what belongs in the next message.
 */
export function fitTrace(lines, opts) {
  let take = lines.length;
  while (take > 1 && renderTrace(lines.slice(0, take), opts).length > ROOM) take -= 1;
  return { shown: lines.slice(0, take), overflow: lines.slice(take) };
}

/**
 * Follows a running job and speaks into the thread on its own, so nobody has to
 * ask. Three different things go to three different places:
 *
 *   stages  one message each, because they are the landmarks worth scrolling to
 *   steps   a message that grows, and a second one when the first is full, so
 *           the history stays readable instead of scrolling out of a window
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
  // Lines already sealed into earlier messages, and the one being written now.
  let sealed = 0;
  let traceTs = null;
  let shownText = '';
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

    const steps = state.steps ?? [];
    while (steps.length > sealed) {
      const opts = { done: state.done, first: sealed === 0 };
      const { shown, overflow } = fitTrace(steps.slice(sealed), opts);
      const text = renderTrace(shown, opts);

      if (text !== shownText) {
        shownText = text;
        if (traceTs) {
          await update({ token, channel, ts: traceTs, text }).catch(() => null);
        } else {
          const sent = await post({ token, channel, threadTs, text }).catch(() => null);
          traceTs = sent?.ts ?? null;
        }
      }

      if (overflow.length === 0) break;
      // This message is full. Leave it sealed and start the next one.
      sealed += shown.length;
      traceTs = null;
      shownText = '';
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

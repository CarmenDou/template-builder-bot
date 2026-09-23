import { readJob, parseResult } from './agent.js';
import { postMessage } from './slack.js';
import { describeResult, describeTimeout, formatStage } from './handler.js';

/**
 * Follows a running job and posts what it says about itself, so nobody has to
 * ask, and so the thread carries one account of the work rather than two.
 *
 * It adds nothing. Earlier versions rendered the middle of a job out of the
 * commands it ran, and then out of a model's summary of those commands, and
 * both were a second voice describing work it was not doing. The agent knows
 * which step it is on and what it just learned; it only had to be asked to
 * write that down more than four times. This moves those lines and nothing else.
 *
 * Slack may fail without ending the watch: the result matters more than any one
 * line, and a job nobody hears about is the bug being fixed.
 */
export async function watchJob(config, job, deps = {}) {
  const {
    read = readJob,
    post = postMessage,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = deps;

  const { channel, threadTs } = job;
  const token = config.slackBotToken;
  const send = (text) => post({ token, channel, threadTs, text }).catch(() => null);

  const deadline = now() + config.jobTimeoutMs;
  let reportedStages = 0;
  let state = { stages: [], steps: [], log: '' };

  while (now() < deadline) {
    await sleep(config.pollIntervalMs);
    try {
      state = await read(config, job.jobId);
    } catch {
      // A dropped channel is ordinary on a busy box; keep watching.
      continue;
    }

    const stages = state.stages ?? [];
    for (const line of stages.slice(reportedStages)) await send(formatStage(line));
    reportedStages = stages.length;

    if (state.done) {
      await send(
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

  await send(describeTimeout({ url: job.url, jobId: job.jobId, log: state.log }));
  return { finished: false };
}

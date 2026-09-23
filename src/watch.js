import { readJob, parseResult } from './agent.js';
import { postMessage } from './slack.js';
import { describeResult, describeTimeout, formatStage } from './handler.js';
import { narrate } from './narrate.js';

// How many new actions are worth a sentence. Below this the answer is almost
// always that it is still doing the last thing, and the model is being asked to
// say nothing at the cost of a call.
const ENOUGH = 6;

/**
 * Follows a running job and says what it is doing, so nobody has to ask.
 *
 * Everything it posts is one plain line. The agent's own milestones and the
 * sentences about what it is up to are both the job talking, and styling one of
 * them made the thread read as two things reporting rather than one working.
 *
 * The middle of a job used to be rendered from the commands it ran, which is
 * how you get `searching for healthz in packages/twenty-server/src` twenty
 * times: true, and no use to anyone. The actions go to a model instead, which
 * is the only thing here that can say what they add up to.
 *
 * Every Slack call may fail without ending the watch: the result matters more
 * than any one update, and a job nobody hears about is the bug being fixed.
 */
export async function watchJob(config, job, deps = {}) {
  const {
    read = readJob,
    post = postMessage,
    say: narrator = narrate,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = deps;

  const { channel, threadTs } = job;
  const token = config.slackBotToken;
  const send = (text) => post({ token, channel, threadTs, text }).catch(() => null);

  const deadline = now() + config.jobTimeoutMs;
  let reportedStages = 0;
  let narratedUpTo = 0;
  let previous = '';
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
    const steps = state.steps ?? [];

    for (const line of stages.slice(reportedStages)) await send(formatStage(line));
    reportedStages = stages.length;

    const fresh = steps.slice(narratedUpTo);
    if (fresh.length >= ENOUGH || (state.done && fresh.length > 0)) {
      narratedUpTo = steps.length;
      // narrate() swallows its own failures, but a narrator is a dependency
      // like any other and the job report must outlive it.
      const said = await narrator(config, {
        repo: job.url,
        stages,
        activity: fresh,
        previous,
      }).catch(() => '');
      if (said) {
        previous = said;
        await send(said);
      }
    }

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

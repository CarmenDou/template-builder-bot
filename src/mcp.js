import { startJob, readJob, steerJob, stopJob, listRunningJobs, parseResult } from './agent.js';
import { watchJob } from './watch.js';
import { askForReview } from './review.js';

// The job-control layer, offered to a conversational agent as MCP tools.
//
// It lives here rather than beside that agent on purpose. Driving the box needs
// an insta credential that can exec into a machine holding a GitHub token, and
// an agent with a terminal tool would be able to use that credential directly,
// straight past every guard below. Keeping the credential on this side means
// the only reachable surface is these six calls, and they refuse.
const PROTOCOL_VERSION = '2025-06-18';

// Descriptions are written for the caller to read. A tool that explains what it
// refuses, and why, is one an agent stops arguing with.
const TOOLS = [
  {
    name: 'start_template_job',
    description:
      'Turn a GitHub repository into an InstaCloud template: triage, manifest, a DRAFT pull request, one real deploy, and verification. Takes 10 to 30 minutes and reports through read_job. REFUSES if a job is already running on that repository, because two agents on one branch overwrite each other; steer_job that one instead.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'https://github.com/owner/repo' },
        instructions: {
          type: 'string',
          description: 'Anything the requester asked for beyond the default, in their own words.',
        },
        slack_channel: {
          type: 'string',
          description:
            'The channel id of the conversation you are in. Pass it and the job reports its own progress there while it works, so nobody has to ask. Leave it out and the job is silent until someone calls read_job.',
        },
        slack_thread_ts: {
          type: 'string',
          description: 'The thread timestamp to report into, so the progress lands under the request rather than in the channel.',
        },
      },
      required: ['repo_url'],
    },
  },
  {
    name: 'continue_template_pr',
    description:
      'Pick a template pull request back up and change it: same branch, CI rebuild, redeploy, re-verify, PR body updated. It stays a draft. REFUSES if a job is already running on that PR; steer_job that one instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'The number on InsForge/instacloud-oss.' },
        instructions: { type: 'string', description: 'What the reviewer wants changed.' },
        slack_channel: {
          type: 'string',
          description:
            'The channel id of the conversation you are in. Pass it and the job reports its own progress there while it works, so nobody has to ask. Leave it out and the job is silent until someone calls read_job.',
        },
        slack_thread_ts: {
          type: 'string',
          description: 'The thread timestamp to report into, so the progress lands under the request rather than in the channel.',
        },
      },
      required: ['pr_number', 'instructions'],
    },
  },
  {
    name: 'list_running_jobs',
    description:
      'Every job still working, with its id and what it is working on. Ask this first when you are not sure whether something is already under way, and after your own restart to find work you were following.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_job',
    description:
      'What a job has done so far: whether it finished, the progress lines it wrote, the tail of its output, and its result once there is one. Use this to answer questions about a running job rather than interrupting it.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'steer_job',
    description:
      'Say something to a job that is already running and let it carry on. Use it when a person changes the plan mid-flight. The agent is interrupted and resumed with your message, so it keeps everything it has done and loses only the step in flight. A question costs the same as an instruction, so prefer read_job when you only want to know where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: {
          type: 'string',
          description: "What to tell it, in the requester's own words rather than your summary.",
        },
      },
      required: ['job_id', 'message'],
    },
  },
  {
    name: 'ask_for_review',
    description:
      "Ask the review bots to look at a template pull request, by posting one line in the review channel. Only after a person has read the draft and said to send it: this wakes real reviewers, so never do it because a job finished. Ask for 'review' first, and only once that comes back clean ask for 'approve'.",
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'https://github.com/owner/repo/pull/123' },
        stage: {
          type: 'string',
          enum: ['review', 'approve'],
          description: "'review' asks Codex to look at it. 'approve' asks Claude to approve it, and belongs after a clean review, not instead of one.",
        },
      },
      required: ['pr_url', 'stage'],
    },
  },
  {
    name: 'stop_job',
    description:
      'End a job. Anything it already pushed stays pushed and nothing is reverted, so this abandons rather than undoes. Steering is almost always the better answer; stop only when the work should not continue at all.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const failure = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

async function callTool(config, name, args, deps) {
  const {
    start = startJob,
    read = readJob,
    steer = steerJob,
    stop = stopJob,
    running = listRunningJobs,
    watch = watchJob,
    review = askForReview,
  } = deps;

  // Deliberately not awaited: the job runs for tens of minutes and this call has
  // to return now. Deliberately not optional either, when the caller said where
  // it is: a job that only speaks when questioned is the thing being fixed here.
  const reportInto = (jobId, url) => {
    const channel = args?.slack_channel;
    const threadTs = args?.slack_thread_ts;
    if (!channel || !config.slackBotToken) return ' Follow it with read_job.';
    watch(config, { jobId, url, channel, threadTs }).catch(() => {});
    return ' It will post its own progress in this thread; read_job still works if you want detail.';
  };

  // The one guard that cannot be a rule the caller remembers: under pressure,
  // with three people talking at once, remembering is exactly what fails.
  const busyWith = async (subject) => (await running(config)).find((j) => j.url === subject) ?? null;

  switch (name) {
    case 'start_template_job': {
      const url = String(args?.repo_url ?? '');
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(url)) {
        return failure(`${url || '(nothing)'} is not a GitHub repository URL.`);
      }
      const busy = await busyWith(url);
      if (busy) {
        return failure(
          `Job ${busy.jobId} is already templating ${url}. Starting a second one would have both push to the same branch. Use steer_job on ${busy.jobId}.`,
        );
      }
      const slack = { channel: args?.slack_channel, threadTs: args?.slack_thread_ts };
      const { jobId } = await start(config, { url, extra: args?.instructions, slack });
      return text(`Started job ${jobId} on ${url}.${reportInto(jobId, url)}`);
    }

    case 'continue_template_pr': {
      const pr = Number(args?.pr_number);
      if (!Number.isInteger(pr) || pr <= 0) return failure(`${args?.pr_number} is not a PR number.`);
      const busy = await busyWith(`PR #${pr}`);
      if (busy) {
        return failure(
          `Job ${busy.jobId} is already working on PR #${pr}. Use steer_job on ${busy.jobId}.`,
        );
      }
      const slack = { channel: args?.slack_channel, threadTs: args?.slack_thread_ts };
      const { jobId } = await start(config, { pr, extra: args?.instructions, slack });
      return text(`Started job ${jobId} on PR #${pr}.${reportInto(jobId, `PR #${pr}`)}`);
    }

    case 'list_running_jobs': {
      const jobs = await running(config);
      if (jobs.length === 0) return text('Nothing is running.');
      return text(jobs.map((j) => `${j.jobId} — ${j.url}`).join('\n'));
    }

    case 'read_job': {
      const state = await read(config, String(args?.job_id ?? ''));
      const result = parseResult(state.log ?? '');
      return text(
        JSON.stringify(
          {
            done: state.done,
            exitCode: state.exitCode,
            stages: state.stages,
            steps: (state.steps ?? []).slice(-20),
            result,
            logTail: (state.log ?? '').slice(-4000),
          },
          null,
          1,
        ),
      );
    }

    case 'steer_job': {
      const message = String(args?.message ?? '').trim();
      if (!message) return failure('steer_job needs the message to pass on.');
      const outcome = await steer(config, String(args?.job_id ?? ''), message);
      return /^steered/.test(outcome)
        ? text(`Passed it on. The job picks up from where it was, keeping what it has done.`)
        : failure(`Could not steer that job: ${outcome}`);
    }

    case 'ask_for_review': {
      const outcome = await review(config, { prUrl: args?.pr_url, stage: args?.stage });
      return /^Asked/.test(outcome) ? text(outcome) : failure(outcome);
    }

    case 'stop_job':
      return text(await stop(config, String(args?.job_id ?? '')));

    default:
      return failure(`No such tool: ${name}`);
  }
}

/**
 * One JSON-RPC message in, one response out, or null for a notification.
 *
 * Separated from the transport so the tools can be tested without HTTP, which
 * is also what keeps the guards honest: they are asserted here, not in a prompt.
 */
export async function handleRpc(config, message, deps = {}) {
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'template-builder-jobs', version: '1.0.0' },
      });

    // Notifications carry no id and get no response at all.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call':
      try {
        return reply(await callTool(config, params?.name, params?.arguments ?? {}, deps));
      } catch (e) {
        // A thrown tool is still a conversation: the caller needs to read why.
        return reply(failure(`${params?.name} failed: ${e.message}`));
      }

    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

export { TOOLS };

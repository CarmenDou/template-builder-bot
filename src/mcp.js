import { startJob, readJob, jobFeed, steerJob, stopJob, listRunningJobs, parseResult } from './agent.js';
import { askForReview, reviewStatus } from './review.js';
import { openUpstreamPr } from './upstream.js';

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
      'Turn a GitHub repository into an InstaCloud template: triage, manifest, a DRAFT pull request, one real deploy, and verification. Takes 10 to 30 minutes and says nothing on its own: whoever starts it follows it with job-feed, or read_job. REFUSES if a job is already running on that repository, because two agents on one branch overwrite each other; steer_job that one instead.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'https://github.com/owner/repo' },
        instructions: {
          type: 'string',
          description: 'Anything the requester asked for beyond the default, in their own words.',
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
      'What a job has done so far: whether it finished, the progress lines it wrote, the tail of its output, and its result once there is one. Use this to answer questions about a job rather than interrupting it. To watch one live, use follow_job; to have something done to what it built, use steer_job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'follow_job',
    description:
      "Follow a running job live. Waits up to about 20 seconds for it to do something, answering early when a milestone lands or it finishes, and returns only what it did since your last call, plus `offset` and `stages` to pass to the next call. Call it in a loop until `done` is true, with nothing in between: it does the waiting itself, so never sleep between calls. When a call shows something new, tell the person in ONE plain sentence what the job did and why, never the raw lines; when it shows nothing new, say nothing and call again. When `done`, call read_job for the result and report it. Ending your turn does NOT stop the job, which runs on another machine: if someone says stop, call stop_job.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        offset: { type: 'number', description: 'From the previous call; 0 the first time.' },
        stages: { type: 'number', description: 'From the previous call; 0 the first time.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'steer_job',
    description:
      "Pass what a person said to a job's own agent, the Claude Code that did the work. It alone has the browser, the platform login for the project it deployed into, the credentials it created and the whole history, so use this for a change of plan while a job runs AND for anything afterwards about what a job built: its deployment, the data it made, its accounts, its PR. Do not try to do those yourself from here, where none of that is logged in or reachable. A running job is interrupted and resumed with the message and keeps what it has done; a finished one is picked back up in the same session. Pass the person's own words, then follow it with follow_job from the offset and stages in the reply. A question costs a turn too, so answer from read_job when that is enough.",
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
      "Ask the review bots to look at a template pull request, by posting one line in the review channel. Only when a person has said to: this wakes real reviewers, so never do it on your own because a job finished. The usual order is 'review', then review_status to tell them what Codex found, then 'approve' when they say so. Their word is what counts, not the review's result: when they ask for approve, send it even with Critical findings open, and mention those in the same sentence.",
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'https://github.com/owner/repo/pull/123' },
        stage: {
          type: 'string',
          enum: ['review', 'approve'],
          description: "'review' asks Codex to look at it. 'approve' asks Claude to approve it, whenever the person says so.",
        },
      },
      required: ['pr_url', 'stage'],
    },
  },
  {
    name: 'review_status',
    description:
      "What people have said on a template PR since you asked for a review. Pass the `asked at` time from ask_for_review's reply as `after`: it waits up to two minutes for any review or comment newer than that and returns each one in full, with who wrote it, when, its state and whether it read the current head. Accounts GitHub marks as bots, such as cubic, are left out; Codex and Claude post as the ordinary account jwfing. If nothing has come yet, call again with the same `after`. Read what came and tell the person, in a sentence or two, what the reviewer concluded and how many Critical findings it raised. This is for telling them where things stand, not a gate: approve is sent when they say so, and never on your own.",
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'https://github.com/owner/repo/pull/123' },
        after: { type: 'string', description: "The `asked at` time from ask_for_review's reply, to wait for the review it asked for." },
      },
      required: ['pr_url'],
    },
  },
  {
    name: 'offer_template_upstream',
    description:
      "Open a pull request on the ORIGINAL project's repository adding ONE line to their README: a Deploy on InstaCloud button linking to the template's gallery page. Nothing else, and nothing for them to maintain, because the template lives in our registry. Takes the template's code and derives everything else from it: the code must already be PUBLISHED (a button pointing at a page that does not exist yet is the one way this becomes rude), and the project it goes to comes from that template's own manifest, never from a caller. Only when a person has said to send it: this reaches a repository that is not ours, cannot be taken back, and is opened under the account whose credential this holds. Never because a job finished or a template published.",
    inputSchema: {
      type: 'object',
      properties: { template_code: { type: 'string' } },
      required: ['template_code'],
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
    feed = jobFeed,
    steer = steerJob,
    stop = stopJob,
    running = listRunningJobs,
    review = askForReview,
    reviews = reviewStatus,
    openPr = openUpstreamPr,
  } = deps;

  // The job never posts anywhere itself. Whoever started it follows it and does
  // the talking, so the conversation has one voice that can also hear the reply.
  const follow = (jobId) =>
    ` It says nothing on its own. Follow it now with follow_job(job_id: "${jobId}", offset: 0, stages: 0), in a loop until it is done.`;

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
      const { jobId } = await start(config, { url, extra: args?.instructions, slack: {} });
      return text(`Started job ${jobId} on ${url}.${follow(jobId)}`);
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
      const { jobId } = await start(config, { pr, extra: args?.instructions, slack: {} });
      return text(`Started job ${jobId} on PR #${pr}.${follow(jobId)}`);
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
            steps: (state.steps ?? []).slice(-30),
            result,
            logTail: (state.log ?? '').slice(-4000),
          },
          null,
          1,
        ),
      );
    }

    case 'follow_job': {
      try {
        const f = await feed(config, String(args?.job_id ?? ''), { offset: args?.offset, stages: args?.stages });
        const body = f.activity.length > 0 ? f.activity.join('\n') : '(nothing new since the last call)';
        // The last thing read before deciding what to do next, so it is where
        // the loop is spelled out. A follower that saw an early answer used to
        // add a sleep of its own, which only delays what the person hears.
        const next = f.done
          ? 'Next: call read_job for the result, and report it.'
          : `Next: call follow_job(job_id: "${args?.job_id}", offset: ${f.offset}, stages: ${f.stages}) straight away. It waits on the box by itself and answers early only when something happened; sleeping first only delays what the person hears.`;
        return text(
          `${body}\n\noffset: ${f.offset}\nstages: ${f.stages}\ndone: ${f.done}${f.done ? ` (exit ${f.exitCode})` : ''}\n${next}`,
        );
      } catch (error) {
        // A dropped channel is ordinary on a busy box. Say so, and say to go on.
        return text(`No answer from the box this time (${error.message.slice(0, 120)}). Call follow_job again with the same offset and stages.`);
      }
    }

    case 'steer_job': {
      const message = String(args?.message ?? '').trim();
      if (!message) return failure('steer_job needs the message to pass on.');
      const jobId = String(args?.job_id ?? '');
      const outcome = await steer(config, jobId, message);
      const m = outcome.match(/^(steered|resumed) (\d+) (\d+)$/);
      if (!m) return failure(`Could not pass that on: ${outcome}`);
      const [, mode, offset, stages] = m;
      const how =
        mode === 'resumed'
          ? 'The job had finished, so its agent has been picked back up in the same session with that.'
          : 'Passed it on. The job picks up from where it was, keeping what it has done.';
      return text(`${how} Follow it with follow_job(job_id: "${jobId}", offset: ${offset}, stages: ${stages}).`);
    }

    case 'ask_for_review': {
      const outcome = await review(config, { prUrl: args?.pr_url, stage: args?.stage });
      return /^Asked/.test(outcome) ? text(outcome) : failure(outcome);
    }

    case 'review_status': {
      let r;
      try {
        r = await reviews(config, { prUrl: args?.pr_url, after: args?.after });
      } catch (error) {
        return failure(`Could not read that PR: ${error.message.slice(0, 160)}`);
      }
      if (r.waiting) {
        return text(`Nothing from a person since ${args.after} yet. Call review_status again with the same after.`);
      }
      if (r.activity.length === 0) return text('No one has reviewed or commented on this PR yet.');
      const blocks = r.activity.map((a) => {
        const what = a.kind === 'review' ? `review, ${a.state}, ${a.onHead ? 'on the current head' : 'on an OLDER commit'}` : 'comment';
        return `--- ${what}, by ${a.author} at ${a.at}\n${a.body}`;
      });
      const heading = args?.after ? `${r.activity.length} new since ${args.after}:` : 'Most recent:';
      return text(`${heading}\n\n${blocks.join('\n\n')}`);
    }

    case 'offer_template_upstream': {
      const code = String(args?.template_code ?? '');
      // The code is the ONLY input, and every other value is derived from it: the catalog says
      // whether it is published, and its own manifest names the project. The credential is broad,
      // so nothing a caller writes may decide which repository gets written to.
      try {
        const pr = await openPr(config, { code });
        return text(
          `Opened ${pr.url} on ${pr.upstream}, from ${pr.fork} on branch ${pr.branch}. One line in their README, pointing at https://instacloud.com/templates/${code}. It is theirs to accept or refuse.`,
        );
      } catch (error) {
        return failure(`Could not offer ${code || '(no code)'} upstream: ${error.message.slice(0, 300)}`);
      }
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

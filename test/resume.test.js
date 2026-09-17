import test from 'node:test';
import assert from 'node:assert/strict';
import { startJob, listUnreportedJobs } from '../src/agent.js';
import { resumeOrphanedJobs } from '../src/server.js';

const config = {
  instaBin: 'insta',
  agentProjectId: 'proj-1',
  agentService: 'claude-code',
  instaApiKey: 'insta_x',
  slackBotToken: 'xoxb-test',
  jobTimeoutMs: 1000,
  pollIntervalMs: 5,
};

function ticketOf(script) {
  const m = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \S+slack\.json/);
  assert.ok(m, 'the script must write a slack.json ticket');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

test('starting a job records who to answer, on the volume', async () => {
  // The bot's memory does not survive a redeploy while the agent keeps running,
  // so the thread has to live next to the job rather than in this process.
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: 'started' };
  };
  await startJob(
    config,
    { url: 'https://github.com/a/b', slack: { channel: 'C1', threadTs: '111.222' } },
    { run, jobId: 'J1' },
  );
  const t = ticketOf(script);
  assert.equal(t.jobId, 'J1');
  assert.equal(t.channel, 'C1');
  assert.equal(t.threadTs, '111.222');
  assert.equal(t.url, 'https://github.com/a/b');
});

test('a follow-up job records the PR as its subject', async () => {
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: 'started' };
  };
  await startJob(config, { pr: 145, slack: { channel: 'C1', threadTs: '9' } }, { run, jobId: 'J2' });
  assert.equal(ticketOf(script).url, 'PR #145');
});

test('listUnreportedJobs skips jobs already answered', async () => {
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: '{"jobId":"J1","channel":"C1","threadTs":"1","url":"u"}\n' };
  };
  const jobs = await listUnreportedJobs(config, { run });
  assert.match(script, /reported/, 'must skip jobs marked reported');
  assert.match(script, /slack\.json/, 'must only consider jobs carrying a ticket');
  assert.deepEqual(jobs, [{ jobId: 'J1', channel: 'C1', threadTs: '1', url: 'u' }]);
});

test('listUnreportedJobs survives a corrupt ticket instead of crashing the boot', async () => {
  const run = async () => ({ stdout: 'not json\n{"jobId":"J2","channel":"C1"}\n' });
  const jobs = await listUnreportedJobs(config, { run });
  assert.deepEqual(jobs, [{ jobId: 'J2', channel: 'C1' }]);
});

test('resume re-attaches to an orphan and answers its thread', async () => {
  const said = [];
  const marked = [];
  const n = await resumeOrphanedJobs(config, {
    list: async () => [{ jobId: 'J1', channel: 'C1', threadTs: '1', url: 'u' }],
    follow: async () => ({ finished: true, text: 'the job finished while you were away' }),
    post: async ({ channel, threadTs, text }) => said.push({ channel, threadTs, text }),
    mark: async (_c, id) => marked.push(id),
  });
  assert.equal(n, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(said, [
    { channel: 'C1', threadTs: '1', text: 'the job finished while you were away' },
  ]);
  assert.deepEqual(marked, ['J1'], 'must mark it so the next restart does not answer twice');
});

test('a ticket with no channel is ignored rather than posted into the void', async () => {
  let posted = 0;
  await resumeOrphanedJobs(config, {
    list: async () => [{ jobId: 'J1' }],
    follow: async () => ({ finished: true, text: 'x' }),
    post: async () => posted++,
    mark: async () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted, 0);
});

test('one orphan that throws does not stop the others', async () => {
  const said = [];
  await resumeOrphanedJobs(config, {
    list: async () => [
      { jobId: 'bad', channel: 'C1', threadTs: '1', url: 'u' },
      { jobId: 'good', channel: 'C1', threadTs: '2', url: 'v' },
    ],
    follow: async ({ job }) => {
      if (job.jobId === 'bad') throw new Error('gone');
      return { finished: true, text: 'good finished' };
    },
    post: async ({ text }) => said.push(text),
    mark: async () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(said, ['good finished']);
});

test('a failed scan boots the bot anyway', async () => {
  // Refusing to start because the box was briefly unreachable would be worse
  // than starting without resuming.
  const n = await resumeOrphanedJobs(config, {
    list: async () => {
      throw new Error('exec channel down');
    },
    follow: async () => ({ finished: true, text: 'x' }),
    post: async () => {},
    mark: async () => {},
  });
  assert.equal(n, 0);
});

test('a timed-out job keeps its ticket so a later boot can still answer it', async () => {
  // Observed 2026-09-17: the bot reported a timeout at 45 minutes and the job
  // finished four minutes later. Marking it answered threw that result away.
  const marked = [];
  await resumeOrphanedJobs(config, {
    list: async () => [{ jobId: 'J1', channel: 'C1', threadTs: '1', url: 'u' }],
    follow: async () => ({ finished: false, text: 'still running past the timeout' }),
    post: async () => {},
    mark: async (_c, id) => marked.push(id),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(marked, [], 'a job that did not finish must stay unanswered');
});

test('a finished job is marked so it is not answered twice', async () => {
  const marked = [];
  await resumeOrphanedJobs(config, {
    list: async () => [{ jobId: 'J1', channel: 'C1', threadTs: '1', url: 'u' }],
    follow: async () => ({ finished: true, text: 'done' }),
    post: async () => {},
    mark: async (_c, id) => marked.push(id),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(marked, ['J1']);
});

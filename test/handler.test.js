import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMention, followJob, describeResult, describeTimeout, formatStage } from '../src/handler.js';

const config = {
  allowedChannels: ['C_OK'],
  jobTimeoutMs: 1000,
  pollIntervalMs: 10,
};

const mention = (text, channel = 'C_OK') => ({ channel, text, ts: '1.0' });

test('stays silent in a channel it does not serve', async () => {
  const out = await handleMention({
    event: mention('https://github.com/a/b', 'C_OTHER'),
    config,
    deps: { start: async () => assert.fail('must not start work') },
  });
  assert.equal(out.reply, null);
  assert.equal(out.job, null);
});

test('explains itself when there is no url', async () => {
  const out = await handleMention({ event: mention('hello'), config, deps: {} });
  assert.match(out.reply, /start a new template/);
  assert.equal(out.job, null);
});

test('refuses two repos in one message instead of guessing', async () => {
  const out = await handleMention({
    event: mention('https://github.com/a/b https://github.com/c/d'),
    config,
    deps: { start: async () => assert.fail('must not start work') },
  });
  assert.match(out.reply, /one at a time/);
  assert.equal(out.job, null);
});

test('starts the job and says what will happen', async () => {
  let started = null;
  const out = await handleMention({
    event: mention('<@U1> https://github.com/a/b'),
    config,
    deps: {
      start: async (_c, req) => {
        started = req;
        return { jobId: 'J9' };
      },
    },
  });
  assert.equal(started.url, 'https://github.com/a/b');
  assert.equal(out.job.jobId, 'J9');
  assert.match(out.reply, /J9/);
  assert.match(out.reply, /draft PR/i);
});

test('posts each new stage line exactly once as it appears', async () => {
  // The whole point: a job runs for tens of minutes and silence looks like death.
  const snapshots = [
    { done: false, stages: ['triage: thin-shell — no HTTP face'], log: '' },
    { done: false, stages: ['triage: thin-shell — no HTTP face'], log: '' },
    { done: false, stages: ['triage: thin-shell — no HTTP face', 'pr: https://x/1 — waiting on CI'], log: '' },
    { done: true, exitCode: 0, stages: ['triage: thin-shell — no HTTP face', 'pr: https://x/1 — waiting on CI'], log: 'RESULT\nverdict: thin-shell' },
  ];
  let i = 0;
  const said = [];
  await followJob({
    config,
    job: { jobId: 'J9', url: 'u' },
    say: async (t) => said.push(t),
    deps: { read: async () => snapshots[i++], sleep: async () => {} },
  });
  assert.deepEqual(said, [
    '• *triage* thin-shell — no HTTP face',
    '• *pr* https://x/1 — waiting on CI',
  ], 'each stage posted once, the repeated snapshot posted nothing');
});

test('the stage name carries the bold, and an odd line still gets posted', () => {
  // Four landmarks you can skim down the thread beat four paragraphs. But a line
  // the agent wrote in some other shape must still reach the human unchanged.
  assert.equal(formatStage('build: green — amd64 and arm64'), '• *build* green — amd64 and arm64');
  assert.equal(formatStage('note: the port probe needed a slower entrypoint'), '• *note* the port probe needed a slower entrypoint');
  assert.equal(formatStage('no colon here at all'), '• no colon here at all');
  assert.equal(
    formatStage('verify: signed up, created a record, restarted: still there'),
    '• *verify* signed up, created a record, restarted: still there',
    'only the first colon is the stage name',
  );
});

test('a failure to post a stage does not end the watch', async () => {
  const snapshots = [
    { done: false, stages: ['triage: out'], log: '' },
    { done: true, exitCode: 0, stages: ['triage: out'], log: 'RESULT\nverdict: out' },
  ];
  let i = 0;
  const { text } = await followJob({
    config,
    job: { jobId: 'J9', url: 'u' },
    say: async () => {
      throw new Error('slack down');
    },
    deps: { read: async () => snapshots[i++], sleep: async () => {} },
  });
  assert.match(text, /out/, 'the final report still arrives');
});

test('reports the result once the job finishes', async () => {
  const read = async () => ({
    done: true,
    exitCode: 0,
    log: 'RESULT\nverdict: directly-usable\npr: https://example.com/pr/1\nservice: https://svc.example.com\nproject: p1\nasks: none',
  });
  const { text } = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.match(text, /directly-usable/);
  assert.match(text, /example\.com\/pr\/1/);
  assert.match(text, /Nothing was published/);
});

test('says plainly when the agent finished without a RESULT block', async () => {
  const read = async () => ({ done: true, exitCode: 1, log: 'it crashed somewhere' });
  const { text } = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.match(text, /did not print a RESULT block/);
  assert.match(text, /exit code 1/);
  assert.ok(!/verdict/i.test(text), 'must not invent a verdict');
});

test('a dropped exec channel does not end the watch', async () => {
  let calls = 0;
  const read = async () => {
    calls += 1;
    if (calls < 3) throw new Error('exec channel dropped');
    return { done: true, exitCode: 0, log: 'RESULT\nverdict: out' };
  };
  const { text } = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: { read, sleep: async () => {} },
  });
  assert.ok(calls >= 3);
  assert.match(text, /out/);
});

test('a timeout is reported as still running, not as failure', async () => {
  let t = 0;
  const { text } = await followJob({
    config,
    job: { jobId: 'J9', url: 'https://github.com/a/b' },
    deps: {
      read: async () => ({ done: false, exitCode: null, log: 'still going' }),
      sleep: async () => {},
      now: () => (t += 400),
    },
  });
  assert.match(text, /still running/);
  assert.match(text, /NOT been killed/);
});

test('describeResult omits links the agent did not provide', () => {
  const text = describeResult({
    url: 'https://github.com/a/b',
    jobId: 'J1',
    exitCode: 0,
    result: { verdict: 'out', project: null, service: null, pr: null, asks: null },
    log: '',
  });
  assert.match(text, /out/);
  assert.ok(!text.includes('Draft PR'), 'no PR line when there is no PR');
  assert.ok(!text.includes('undefined'));
});

test('describeTimeout never claims the job failed', () => {
  const text = describeTimeout({ url: 'u', jobId: 'J1', log: 'tail' });
  assert.ok(!/failed/i.test(text));
});

test('followJob distinguishes finishing from running out of patience', async () => {
  const done = await followJob({
    config,
    job: { jobId: 'J9', url: 'u' },
    deps: { read: async () => ({ done: true, exitCode: 0, stages: [], log: 'RESULT\nverdict: out' }), sleep: async () => {} },
  });
  assert.equal(done.finished, true);

  let t = 0;
  const timedOut = await followJob({
    config,
    job: { jobId: 'J9', url: 'u' },
    deps: {
      read: async () => ({ done: false, exitCode: null, stages: [], log: 'still going' }),
      sleep: async () => {},
      now: () => (t += 400),
    },
  });
  assert.equal(timedOut.finished, false, 'a timeout is not a result');
  assert.match(timedOut.text, /NOT been killed/);
});

test('each thing to settle gets its own line, never one run-on paragraph', () => {
  // Five asks in one paragraph is a wall nobody reads. A reader has to be able
  // to count them down the left edge.
  const text = describeResult({
    url: 'https://github.com/twentyhq/twenty',
    jobId: 'J1',
    exitCode: 0,
    result: {
      verdict: 'thin-shell',
      project: 'p1 (tpl-twenty)',
      service: 'https://svc.example.com',
      pr: 'https://example.com/pr/149',
      asks: ['crm is a new meta.category', 'sign-up is open to anyone', 'alwaysOn bills continuously'],
    },
  });

  const bullets = text.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, 3, 'one line per thing to settle');
  assert.match(text, /\*Needs you to settle\*/);
  assert.ok(!/•.*•/.test(text), 'never two on one line');
});

test('the headline is the repo name and the verdict, not a bare URL', () => {
  const text = describeResult({
    url: 'https://github.com/twentyhq/twenty',
    jobId: 'J1',
    exitCode: 0,
    result: { verdict: 'thin-shell', project: null, service: null, pr: null, asks: [] },
  });
  const headline = text.split('\n')[0];
  assert.match(headline, /twentyhq\/twenty.*thin-shell/);
  assert.ok(!headline.includes('https://'), 'the URL is noise in a headline');
  assert.ok(!/Needs you to settle/.test(text), 'no empty section when there is nothing to settle');
  assert.match(text, /job `J1`/, 'the job id stays reachable, just out of the way');
});

test('what the agent created reaches Slack, labelled as not for the PR', () => {
  // Template variable values are write-only, so a report that drops these leaves
  // the reviewer unable to sign in and the platform unable to tell them either.
  const text = describeResult({
    url: 'https://github.com/twentyhq/twenty',
    jobId: 'J1',
    exitCode: 0,
    result: {
      verdict: 'thin-shell',
      project: 'p1',
      service: 'https://svc.example.com',
      pr: 'https://example.com/pr/149',
      created: [
        'Signed up the first user as admin@example.com / 12345678 (Twenty rejects 6 characters)',
        'Seeded one contact named "Acme Test" so search had something to find',
      ],
      asks: ['crm is a new meta.category'],
    },
  });

  const bullets = text.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, 3, 'two created lines and one ask');
  assert.match(text, /\*What it created\*/);
  assert.match(text, /never the PR/, 'the reader must know this is not public');
  assert.ok(
    text.indexOf('What it created') < text.indexOf('Needs you to settle'),
    'what you need to get in comes before what you have to decide',
  );
});

test('nothing created means no empty section', () => {
  const text = describeResult({
    url: 'https://github.com/a/b',
    jobId: 'J1',
    exitCode: 0,
    result: { verdict: 'out', project: null, service: null, pr: null, created: [], asks: [] },
  });
  assert.ok(!/What it created/.test(text));
});

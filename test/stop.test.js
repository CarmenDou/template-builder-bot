import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopRequest } from '../src/command.js';
import { stopJob, steerJob } from '../src/agent.js';
import { handleMention, describeResult } from '../src/handler.js';

const config = { allowedChannels: ['C_OK'], slackBotToken: 'xoxb-test', agentService: 'claude-code' };
const ev = (text, extra = {}) => ({ channel: 'C_OK', text, ts: '2', ...extra });

test('recognises the ways a person asks for a stop', () => {
  for (const t of ['<@U1> stop', '<@U1> Stop', '<@U1> cancel', '<@U1> abort it', '<@U1> halt']) {
    assert.equal(isStopRequest(t), true, t);
  }
  for (const t of ['<@U1> https://github.com/a/b', '<@U1> #147 change the model', '<@U1> do not stop']) {
    assert.equal(isStopRequest(t), false, t);
  }
});

test('"stop #147" is a stop, never work on 147', async () => {
  let stopped = null;
  const out = await handleMention({
    event: ev('<@U1> stop #147'),
    config,
    deps: {
      running: async () => [{ jobId: 'J1', url: 'PR #147', threadTs: '1' }],
      stop: async (_c, id) => {
        stopped = id;
        return 'stopped';
      },
      start: async () => assert.fail('a stop must never start work'),
    },
  });
  assert.equal(stopped, 'J1');
  assert.match(out.reply, /Stopped it/);
});

test('in a thread it stops that thread job, not everything', async () => {
  const stopped = [];
  await handleMention({
    event: ev('<@U1> stop', { thread_ts: 'T2' }),
    config,
    deps: {
      running: async () => [
        { jobId: 'J1', url: 'PR #147', threadTs: 'T1' },
        { jobId: 'J2', url: 'PR #148', threadTs: 'T2' },
      ],
      stop: async (_c, id) => {
        stopped.push(id);
        return 'stopped';
      },
    },
  });
  assert.deepEqual(stopped, ['J2'], 'only the job belonging to this thread');
});

test('with nothing running it says so instead of pretending', async () => {
  const out = await handleMention({
    event: ev('<@U1> stop'),
    config,
    deps: { running: async () => [], stop: async () => assert.fail('nothing to stop') },
  });
  assert.match(out.reply, /Nothing is running/);
});

test('the reply is honest about what a stop does not undo', async () => {
  const out = await handleMention({
    event: ev('<@U1> stop'),
    config,
    deps: {
      running: async () => [{ jobId: 'J1', url: 'PR #147', threadTs: 'T1' }],
      stop: async () => 'stopped',
    },
  });
  assert.match(out.reply, /already pushed stays pushed/);
  assert.match(out.reply, /nothing is reverted/i);
});

test('stopJob kills the group and leaves a finished marker', async () => {
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: 'stopped' };
  };
  const out = await stopJob(config, 'J1', { run });
  assert.equal(out, 'stopped');
  assert.match(script, /kill -TERM -"\$\(cat \S+pid\)"/, 'kills the whole process group');
  assert.match(script, /pkill -TERM -f/, 'falls back for jobs started before pids were recorded');
  assert.match(script, /echo 143 > \S+exit\.code/, 'leaves a terminal marker so nobody waits forever');
  assert.match(script, /already finished/, 'a finished job is not killed');
});

// The two prompts a steer can hand over, in the order the script writes them:
// the one for a finished job, then the one for a running one.
const steerPrompts = (script) =>
  [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \S+steer\.txt/g)].map((m) =>
    Buffer.from(m[1], 'base64').toString(),
  );

test('steerJob restarts a running agent on the same session and leaves the job open', async () => {
  let script = null;
  const run = async (_c, s) => {
    script = s;
    return { stdout: 'steered 100 2' };
  };
  const out = await steerJob(config, 'J1', 'stop using ttyd, it serves HTTP already', { run });
  assert.equal(out, 'steered 100 2');

  assert.match(script, /kill -TERM -"\$\(cat \S+pid\)"/, 'the in-flight step is killed');
  assert.ok(
    !/echo \d+ > \S+exit\.code/.test(script),
    'writing exit.code would tell the follower the job finished and orphan the restart',
  );

  const runner = Buffer.from(
    script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \S+run\.sh/)[1],
    'base64',
  ).toString();
  assert.match(runner, /claude --resume "\$\(cat \S+session\)"/, 'resumes the same conversation');
  assert.match(
    runner,
    /\| node \S+steps\.js \S+ >> \S+out\.jsonl/,
    'the resumed run goes through the same splitter and appends, so the trace spans both runs',
  );

  const [, during] = steerPrompts(script);
  assert.match(during, /stop using ttyd/, 'carries what the person said');
  assert.match(during, /carry on with the same job/i, 'and the instruction to continue');
  assert.match(during, /before you act/i, 'and to look at what it left behind before acting');
});

test('a finished job is picked back up by its own agent, which owns what it built', async () => {
  let script = null;
  await steerJob(config, 'J1', 'delete the seed company you created', {
    run: async (_c, s) => ((script = s), { stdout: 'resumed 5000 9' }),
  });
  assert.match(script, /if \[ -f \S+exit\.code \]; then\n {2}mode=resumed/, 'a finished job is resumed, not refused');
  assert.match(script, /rm -f \S+exit\.code \S+claude\.exit/, 'so a follower sees the new stretch as running');
  const resumedBranch = script.slice(script.indexOf('mode=resumed'), script.indexOf('else'));
  assert.doesNotMatch(resumedBranch, /kill/, 'there is nothing to interrupt');

  const [after] = steerPrompts(script);
  assert.match(after, /delete the seed company you created/, 'carries what the person said');
  assert.match(after, /has finished/, 'tells it the job is over rather than interrupted');
  assert.match(after, /Check the state they\s+are actually in/, 'and to look before it touches anything');
  assert.match(after, /RESULT section again/, 'and to report again');
  assert.match(script, /echo "\$mode \$\(wc -c/, 'and says where a follower should pick up');
});

test('steerJob says so when there is no job or no session to resume', async () => {
  let script = null;
  await steerJob(config, 'J1', 'anything', {
    run: async (_c, s) => ((script = s), { stdout: 'no such job' }),
  });
  assert.match(script, /no such job/, 'a missing directory says so');
  assert.match(script, /no session to resume/, 'a job from before session ids says so');
});

test('a stopped job reads as stopped, not as a mysterious failure', () => {
  const text = describeResult({
    url: 'https://github.com/a/b',
    jobId: 'J1',
    exitCode: 143,
    result: null,
    log: '',
  });
  assert.match(text, /was stopped/);
  assert.ok(!/did not print a RESULT block/.test(text), 'a stop is not a missing-result bug');
});

test('the help lists every command, including the ones added later', async () => {
  // A command nobody can discover may as well not exist. This fails the moment
  // a new one is added without documenting it.
  const out = await handleMention({
    event: ev('<@U1> what can you do'),
    config,
    deps: { running: async () => [] },
  });

  assert.match(out.reply, /start a new template/, 'the new-template command');
  assert.match(out.reply, /change one I already drafted/, 'the follow-up command');
  assert.match(out.reply, /stop/, 'the stop command');
  assert.match(out.reply, /I read the thread for it/, 'the bare-reply shortcut');
  assert.match(out.reply, /never publish/, 'says where its authority ends');
});

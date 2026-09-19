import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/command.js';
import { buildFollowupTask } from '../src/agent.js';
import { handleMention } from '../src/handler.js';

test('a PR link is a follow-up, not a request to template our own monorepo', () => {
  // This is the trap: a PR url is also a github.com/owner/repo url, and reading it
  // as "new" would restart from scratch against instacloud-oss itself.
  const out = parseCommand('<@U1> https://github.com/InsForge/instacloud-oss/pull/145 use the small model');
  assert.equal(out.kind, 'followup');
  assert.equal(out.pr, 145);
  assert.deepEqual(out.repos, []);
  assert.equal(out.extra, 'use the small model');
});

test('a slack-wrapped PR link still reads as a follow-up', () => {
  const out = parseCommand('<https://github.com/InsForge/instacloud-oss/pull/145>');
  assert.equal(out.kind, 'followup');
  assert.equal(out.pr, 145);
});

test('a bare #number is a follow-up', () => {
  const out = parseCommand('<@U1> #145 bump the default model');
  assert.equal(out.kind, 'followup');
  assert.equal(out.pr, 145);
  assert.equal(out.extra, 'bump the default model');
});

test('a plain repo url is still a new job', () => {
  const out = parseCommand('<@U1> https://github.com/openai/whisper');
  assert.equal(out.kind, 'new');
  assert.equal(out.pr, null);
  assert.equal(out.repos[0].repo, 'whisper');
});

test('nothing actionable reads as none', () => {
  assert.equal(parseCommand('<@U1> hello there').kind, 'none');
});

test('a hash inside a word is not a PR reference', () => {
  // "issue#145" or a colour "#145" mid-sentence should not hijack the message
  const out = parseCommand('<@U1> https://github.com/openai/whisper color#145');
  assert.equal(out.kind, 'new');
});

test('the follow-up task recovers context from the PR, not from memory', () => {
  const task = buildFollowupTask({ pr: 145, extra: 'use small' });
  assert.match(task, /gh pr view 145/, 'must read the PR to find the branch');
  assert.match(task, /FRESH job directory/, 'must not reuse another job clone');
  assert.match(task, /use small/);
  assert.match(task, /Keep it a draft/);
  assert.match(task, /do not merge/i);
});

test('with no instructions the follow-up task tells the agent to read the PR comments', () => {
  const task = buildFollowupTask({ pr: 7, extra: '' });
  assert.match(task, /gh pr view 7 --comments/);
});

test('handler routes a PR mention into a follow-up job', async () => {
  let got = null;
  const out = await handleMention({
    event: { channel: 'C_OK', text: '<@U1> #145 use the small model', ts: '1' },
    config: { allowedChannels: ['C_OK'] },
    deps: {
      start: async (_c, req) => {
        got = req;
        return { jobId: 'JF1' };
      },
    },
  });
  assert.equal(got.pr, 145);
  assert.equal(got.url, undefined, 'a follow-up carries no repo url');
  assert.match(out.reply, /Picking `PR #145` back up/);
  assert.match(out.reply, /stays a draft/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseList, stripMention } from '../src/command.js';

test('finds a plain repo url', () => {
  const { repos } = parseCommand('<@U123> https://github.com/openai/whisper');
  assert.deepEqual(repos, [
    { owner: 'openai', repo: 'whisper', url: 'https://github.com/openai/whisper' },
  ]);
});

test('unwraps the angle brackets Slack adds around urls', () => {
  // Slack rewrites bare urls as <url>; without unwrapping, the ">" lands in the repo name
  const { repos } = parseCommand('<@U123> <https://github.com/openai/whisper>');
  assert.equal(repos[0].repo, 'whisper');
});

test('unwraps a slack link that carries a label', () => {
  const { repos } = parseCommand('<https://github.com/openai/whisper|whisper>');
  assert.equal(repos[0].url, 'https://github.com/openai/whisper');
});

test('drops a .git suffix', () => {
  const { repos } = parseCommand('https://github.com/openai/whisper.git');
  assert.equal(repos[0].repo, 'whisper');
});

test('ignores deep paths, refs and query strings', () => {
  // GitHub's own copy button appends ?tab=readme-ov-file
  const { repos } = parseCommand('https://github.com/ahmetoner/whisper-asr-webservice/tree/main?tab=readme-ov-file');
  assert.equal(repos[0].url, 'https://github.com/ahmetoner/whisper-asr-webservice');
});

test('does not lose a repo name that ends in a dot-word', () => {
  const { repos } = parseCommand('https://github.com/foo/bar.baz');
  assert.equal(repos[0].repo, 'bar.baz');
});

test('deduplicates the same repo mentioned twice', () => {
  const { repos } = parseCommand('https://github.com/a/b and again https://github.com/a/b');
  assert.equal(repos.length, 1);
});

test('reports two distinct repos so the caller can refuse', () => {
  const { repos } = parseCommand('https://github.com/a/b https://github.com/c/d');
  assert.equal(repos.length, 2);
});

test('keeps the human text as extra, without the mention or the url', () => {
  const { extra } = parseCommand('<@U123> https://github.com/a/b use the tiny model please');
  assert.equal(extra, 'use the tiny model please');
});

test('no url at all yields no repos', () => {
  const { repos } = parseCommand('<@U123> hello');
  assert.deepEqual(repos, []);
});

test('a non-github url is not a repo', () => {
  const { repos } = parseCommand('https://gitlab.com/a/b');
  assert.deepEqual(repos, []);
});

test('stripMention removes every mention', () => {
  assert.equal(stripMention('<@U1> hi <@U2>').trim(), 'hi');
});

test('parseList splits on commas and whitespace', () => {
  assert.deepEqual(parseList('C1, C2  C3'), ['C1', 'C2', 'C3']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

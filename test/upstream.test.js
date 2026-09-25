import test from 'node:test';
import assert from 'node:assert/strict';
import { deployButton, openUpstreamPr, parseRepo, UpstreamError, withButton } from '../src/upstream.js';

const config = { githubPrToken: 'ghp_test' };
const REPO = 'https://github.com/louislam/uptime-kuma';

test('parseRepo takes the shapes a job is started with', () => {
  for (const url of [REPO, `${REPO}/`, `${REPO}.git`]) {
    assert.deepEqual(parseRepo(url), { owner: 'louislam', repo: 'uptime-kuma' });
  }
  for (const bad of ['', 'louislam/uptime-kuma', 'https://gitlab.com/o/r', `${REPO}/pulls/1`]) {
    assert.throws(() => parseRepo(bad), UpstreamError, bad);
  }
});

test('the button points at the repository it is going into, not at our registry', () => {
  const line = deployButton('louislam', 'uptime-kuma');
  assert.match(line, /console\.instacloud\.com\/deploy\?repo=https:\/\/github\.com\/louislam\/uptime-kuma/);
  assert.match(line, /deploy-button\.svg/);
  assert.doesNotMatch(line, /templates\/uptime-kuma/, 'a repository template is not a registry code');
});

test('the button joins the badge row a project already has', () => {
  const readme = ['# Uptime Kuma', '', '[![Deploy on Railway](x)](y)', '', 'Text.'].join('\n');
  const line = deployButton('o', 'r');
  const out = withButton(readme, line).split('\n');
  assert.equal(out[3], line, 'directly under the badge it is one of');
  assert.equal(out[0], '# Uptime Kuma', 'their title is untouched');
});

test('with no badge row it goes under the first heading, where a reader looks', () => {
  const out = withButton('# Title\n\nText.', deployButton('o', 'r')).split('\n');
  assert.equal(out[0], '# Title');
  assert.equal(out[2], deployButton('o', 'r'));
});

test('adding the button twice changes nothing', () => {
  const line = deployButton('o', 'r');
  const once = withButton('# Title\n\nText.', line);
  assert.equal(withButton(once, line), once);
});

/** A GitHub that answers from a script of [method, path] → body. */
function github(script, seen = []) {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    seen.push(`${method} ${path}`);
    const key = Object.keys(script).find((k) => k === `${method} ${path}`);
    const entry = key ? script[key] : undefined;
    if (entry === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (entry.status && entry.status >= 400) {
      return new Response(JSON.stringify({ message: entry.message }), { status: entry.status });
    }
    return new Response(JSON.stringify(entry), { status: 200 });
  };
}

const HAPPY = {
  'GET /user': { login: 'CarmenDou' },
  'GET /repos/louislam/uptime-kuma': { default_branch: 'master' },
  'POST /repos/louislam/uptime-kuma/forks': {},
  'GET /repos/CarmenDou/uptime-kuma': { default_branch: 'master' },
  'GET /repos/louislam/uptime-kuma/git/ref/heads/master': { object: { sha: 'BASE' } },
  'POST /repos/CarmenDou/uptime-kuma/git/refs': {},
  'PUT /repos/CarmenDou/uptime-kuma/contents/insta.template.yaml': {},
  'GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE': {
    content: Buffer.from('# Uptime Kuma\n\nText.').toString('base64'),
    sha: 'READMESHA',
  },
  'PUT /repos/CarmenDou/uptime-kuma/contents/README.md': {},
  'POST /repos/louislam/uptime-kuma/pulls': { html_url: 'https://github.com/louislam/uptime-kuma/pull/9', number: 9 },
};

const offer = {
  repoUrl: REPO,
  manifest: 'code: uptime-kuma\nversion: 1.0.0\n',
  readmeLine: deployButton('louislam', 'uptime-kuma'),
  title: 'Add an InstaCloud deploy button',
  body: 'One file and one line.',
};

test('the pull request goes to THEM, from a branch on our fork', async () => {
  const seen = [];
  const out = await openUpstreamPr(config, offer, { fetchImpl: github(HAPPY, seen), wait: async () => {} });
  assert.equal(out.url, 'https://github.com/louislam/uptime-kuma/pull/9');
  assert.equal(out.fork, 'CarmenDou/uptime-kuma');
  assert.ok(seen.includes('POST /repos/louislam/uptime-kuma/forks'));
  assert.ok(seen.includes('POST /repos/louislam/uptime-kuma/pulls'), 'opened on theirs');
  assert.ok(
    seen.every((call) => !/^(PUT|PATCH) \/repos\/louislam/.test(call)),
    'nothing is ever written into their repository directly',
  );
});

test('the branch starts from UPSTREAM head, so an old fork cannot carry a stale base', async () => {
  const seen = [];
  await openUpstreamPr(config, offer, { fetchImpl: github(HAPPY, seen), wait: async () => {} });
  assert.ok(seen.includes('GET /repos/louislam/uptime-kuma/git/ref/heads/master'));
  assert.ok(!seen.includes('GET /repos/CarmenDou/uptime-kuma/git/ref/heads/master'));
  // And the README it edits is theirs at that commit, not whatever the fork held.
  assert.ok(seen.includes('GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE'));
});

test('a repository with no README gets the manifest and no button, rather than failing', async () => {
  const noReadme = { ...HAPPY };
  delete noReadme['GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE'];
  await assert.rejects(
    () => openUpstreamPr(config, offer, { fetchImpl: github(noReadme), wait: async () => {} }),
    /README/,
    'it says which step failed rather than half-finishing silently',
  );
});

test('it waits for the fork, which GitHub creates asynchronously', async () => {
  let reads = 0;
  const slow = { ...HAPPY };
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/repos/CarmenDou/uptime-kuma') && (init?.method ?? 'GET') === 'GET') {
      reads += 1;
      if (reads < 3) return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return github(slow)(url, init);
  };
  let waited = 0;
  const out = await openUpstreamPr(config, offer, { fetchImpl, wait: async () => void (waited += 1) });
  assert.equal(reads, 3);
  assert.equal(waited, 2);
  assert.equal(out.number, 9);
});

test('the scope failure is named, because it is the one with a fix', async () => {
  const refused = { ...HAPPY, 'POST /repos/louislam/uptime-kuma/forks': { status: 403, message: 'Resource not accessible by personal access token' } };
  await assert.rejects(
    () => openUpstreamPr(config, offer, { fetchImpl: github(refused), wait: async () => {} }),
    /classic token with public_repo/,
  );
});

test('without a credential it refuses before touching GitHub', async () => {
  await assert.rejects(
    () => openUpstreamPr({}, offer, { fetchImpl: async () => assert.fail('must not call GitHub') }),
    /No GitHub credential/,
  );
});

test('an empty manifest is refused: there would be nothing to offer', async () => {
  await assert.rejects(
    () => openUpstreamPr(config, { ...offer, manifest: '  ' }, { fetchImpl: async () => assert.fail('must not call GitHub') }),
    /no insta\.template\.yaml/,
  );
});

test('it refuses to fork a repository the credential already owns', async () => {
  const mine = { ...HAPPY, 'GET /user': { login: 'louislam' } };
  await assert.rejects(
    () => openUpstreamPr(config, offer, { fetchImpl: github(mine), wait: async () => {} }),
    /belongs to the account/,
  );
});

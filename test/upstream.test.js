import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deployButton,
  offerText,
  openUpstreamPr,
  parseRepo,
  publishedTemplate,
  upstreamLink,
  upstreamOffer,
  UpstreamError,
  withButton,
} from '../src/upstream.js';

const config = { githubPrToken: 'ghp_test' };
const REPO = 'https://github.com/louislam/uptime-kuma';
const CODE = 'uptime-kuma';

test('parseRepo takes the shapes a manifest links to', () => {
  for (const url of [REPO, `${REPO}/`, `${REPO}.git`]) {
    assert.deepEqual(parseRepo(url), { owner: 'louislam', repo: 'uptime-kuma' });
  }
  assert.throws(() => parseRepo('https://gitlab.com/o/r'), UpstreamError);
  assert.throws(() => parseRepo(''), UpstreamError);
});

test('the button points at the gallery page, not at the console', () => {
  const line = deployButton(CODE);
  assert.match(line, /\]\(https:\/\/instacloud\.com\/templates\/uptime-kuma\)$/);
  // The console is behind the auth gate and is not indexed. A badge that lands there spends its
  // link on a page no crawler can read and shows a stranger a sign-in form first.
  assert.ok(!line.includes('console.instacloud.com'), 'never the console');
  assert.ok(!line.includes('?repo='), 'and not a manifest-in-their-repo deploy link either');
});

test('the button joins the badge row a project already has', () => {
  const line = deployButton(CODE);
  const readme = '# Kuma\n\n[![Deploy on Railway](a.svg)](b)\n\nText.';
  const out = withButton(readme, line).split('\n');
  assert.equal(out[3], line, 'directly under the row it belongs to');
});

test('with no badge row it goes under the first heading, where a reader looks', () => {
  const out = withButton('# Title\n\nText.', deployButton(CODE)).split('\n');
  assert.equal(out[0], '# Title');
  assert.equal(out[2], deployButton(CODE));
});

test('adding the button twice changes nothing', () => {
  const line = deployButton(CODE);
  const once = withButton('# Title\n\nText.', line);
  assert.equal(withButton(once, line), once);
});

test('a # inside a code fence is a comment, not a heading to sit under', () => {
  // Caught on the real NandhaKishorM/laya README, which has no ATX heading at all and whose first
  // `# ` is a Python comment 700 lines down. The button landed inside the sample.
  const readme = [
    '<p align="center"><img src="logo.png" /></p>',
    '',
    'Some prose.',
    '',
    '```python',
    '# multilingual billing',
    'r = router.predict(text)',
    '```',
  ].join('\n');
  const out = withButton(readme, deployButton(CODE)).split('\n');
  const at = out.indexOf(deployButton(CODE));
  assert.ok(at >= 0, 'the button is somewhere');
  assert.ok(at < out.indexOf('```python'), `the button went inside the fence, at line ${at}`);
});

test('a closing fence is not read as a second opening one', () => {
  const readme = ['```', '# not a heading', '```', '', '# Real Heading', '', 'Text.'].join('\n');
  const out = withButton(readme, deployButton(CODE)).split('\n');
  assert.equal(out[out.indexOf('# Real Heading') + 2], deployButton(CODE));
});

test('it joins a badge row that is not made of deploy buttons', () => {
  // laya's row is Colab, PyPI, Docs, Hugging Face. Matching vendor names in the alt text found
  // nothing there and fell through to the heading search, which is how the fence bug was reached.
  const readme = [
    '<div align="center">',
    '',
    '[![Open In Colab](colab.svg)](https://colab.research.google.com/x)',
    '[![PyPI version](pypi.svg)](https://pypi.org/project/laya/)',
    '',
    '</div>',
  ].join('\n');
  const out = withButton(readme, deployButton(CODE)).split('\n');
  assert.equal(out[4], deployButton(CODE), 'appended after the LAST badge, not inserted into their order');
  assert.equal(out[2], '[![Open In Colab](colab.svg)](https://colab.research.google.com/x)', 'their order is untouched');
});

test('a line that merely mentions a badge is not a badge row', () => {
  const readme = ['# Title', '', 'We use [![CI](ci.svg)](ci) to check builds.', ''].join('\n');
  const out = withButton(readme, deployButton(CODE)).split('\n');
  assert.equal(out[2], deployButton(CODE), 'it went under the heading, not after the prose');
});

// ---- reading the registry's own manifest -----------------------------------

const MANIFEST = `code: uptime-kuma
version: 1.0.0
upstream:
  package: uptime-kuma
  pinned: "1.23.0"
services:
  web:
    type: web
meta:
  name: Uptime Kuma
  links:
    documentation: https://uptime.kuma.pet
    upstream: ${REPO}
`;

test('upstreamLink reads meta.links.upstream', () => {
  assert.equal(upstreamLink(MANIFEST), REPO);
});

test('upstreamLink never answers with the version pin at the top level', () => {
  // `upstream:` also exists as a top-level block, where it names a package and a version rather
  // than a repository. Answering with anything out of it would aim the credential at nothing.
  const pinOnly = 'code: x\nupstream:\n  package: x\n  pinned: "1"\nmeta:\n  name: X\n';
  assert.equal(upstreamLink(pinOnly), '');
});

test('upstreamLink ignores a links block that is not under meta', () => {
  const elsewhere = 'code: x\nsomething:\n  links:\n    upstream: https://github.com/evil/repo\nmeta:\n  name: X\n';
  assert.equal(upstreamLink(elsewhere), '');
});

test('upstreamLink unwraps a quoted value', () => {
  const quoted = `meta:\n  links:\n    upstream: "${REPO}"\n`;
  assert.equal(upstreamLink(quoted), REPO);
});

test('upstreamLink answers empty rather than guessing', () => {
  assert.equal(upstreamLink('meta:\n  name: X\n'), '');
  assert.equal(upstreamLink(''), '');
  assert.equal(upstreamLink(undefined), '');
});

// ---- the fakes --------------------------------------------------------------

const CATALOG = 'https://api.instacloud.com/templates';
const RAW = 'https://raw.githubusercontent.com/InsForge/instacloud-oss/main/templates';

const TEMPLATE = { code: CODE, name: 'Uptime Kuma', version: '1.0.0' };

const HAPPY = {
  'GET /user': { login: 'CarmenDou' },
  'GET /repos/louislam/uptime-kuma': { default_branch: 'master' },
  'POST /repos/louislam/uptime-kuma/forks': {},
  'GET /repos/CarmenDou/uptime-kuma': { default_branch: 'master' },
  'GET /repos/louislam/uptime-kuma/git/ref/heads/master': { object: { sha: 'BASE' } },
  'POST /repos/CarmenDou/uptime-kuma/git/refs': {},
  'GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE': {
    content: Buffer.from('# Uptime Kuma\n\nText.').toString('base64'),
    sha: 'READMESHA',
  },
  'PUT /repos/CarmenDou/uptime-kuma/contents/README.md': {},
  'POST /repos/louislam/uptime-kuma/pulls': { html_url: 'https://github.com/louislam/uptime-kuma/pull/9', number: 9 },
};

/**
 * All three sources this reads: the catalog (is it published), the registry's raw manifest (whose
 * project is it), and GitHub's API (the fork and the pull request). `seen` records every call in
 * order, which is how the tests below assert that nothing is written before the gate passes.
 */
function world({ script = HAPPY, catalog = { status: 200, body: { template: TEMPLATE } }, manifest = MANIFEST } = {}, seen = []) {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith(CATALOG)) {
      seen.push(`CATALOG ${url.slice(CATALOG.length)}`);
      return new Response(catalog.body === undefined ? '' : JSON.stringify(catalog.body), { status: catalog.status });
    }
    if (url.startsWith(RAW)) {
      seen.push(`RAW ${url.slice(RAW.length)}`);
      if (manifest === null) return new Response('404: Not Found', { status: 404 });
      return new Response(manifest, { status: 200 });
    }
    const path = url.replace('https://api.github.com', '');
    seen.push(`${method} ${path}`);
    const entry = script[`${method} ${path}`];
    if (entry === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (entry.status && entry.status >= 400) {
      return new Response(JSON.stringify({ message: entry.message }), { status: entry.status });
    }
    return new Response(JSON.stringify(entry), { status: 200 });
  };
}

const run = (opts, seen) => openUpstreamPr(config, { code: CODE }, { fetchImpl: world(opts, seen), wait: async () => {} });

// ---- the published gate -----------------------------------------------------

test('a published code answers with the catalog entry', async () => {
  assert.deepEqual(await publishedTemplate(CODE, { fetchImpl: world() }), TEMPLATE);
});

test('a draft or unknown code is refused, naming the page that would be broken', async () => {
  await assert.rejects(
    () => publishedTemplate(CODE, { fetchImpl: world({ catalog: { status: 404, body: { error: 'template not found' } } }) }),
    (e) => e instanceof UpstreamError && /not published/.test(e.message) && /instacloud\.com\/templates\/uptime-kuma/.test(e.message),
  );
});

test('something that is not a code is refused before any request', async () => {
  for (const bad of ['', '../../etc', 'Has Caps', 'trailing-']) {
    const seen = [];
    await assert.rejects(() => publishedTemplate(bad, { fetchImpl: world({}, seen) }), UpstreamError);
    assert.deepEqual(seen, [], `${bad || '(empty)'} reached the network`);
  }
});

test('the gate runs BEFORE anything is created on anyone else', async () => {
  const seen = [];
  await assert.rejects(() => run({ catalog: { status: 404, body: {} } }, seen), /not published/);
  assert.deepEqual(seen, ['CATALOG /uptime-kuma'], 'no fork, no branch, not even a GET on their repo');
});

// ---- deriving the target ----------------------------------------------------

test('the project comes from the template manifest, never from a caller', async () => {
  const out = await upstreamOffer(CODE, { fetchImpl: world() });
  assert.equal(out.repoUrl, REPO);
  assert.equal(out.owner, 'louislam');
  assert.equal(out.line, deployButton(CODE));
});

test('a caller cannot aim this at a repository of their choosing', async () => {
  const seen = [];
  // Extra fields on the argument are not read: the only input is the code.
  await openUpstreamPr(
    config,
    { code: CODE, repoUrl: 'https://github.com/someone/else', owner: 'someone', repo: 'else' },
    { fetchImpl: world({}, seen), wait: async () => {} },
  );
  assert.ok(
    seen.every((call) => !call.includes('someone')),
    `a caller-supplied repository was reached: ${seen.filter((c) => c.includes('someone')).join(', ')}`,
  );
  assert.ok(seen.includes('POST /repos/louislam/uptime-kuma/pulls'), 'it went to the manifest\'s project');
});

test('a manifest the registry does not carry is refused', async () => {
  await assert.rejects(() => run({ manifest: null }), /carries no manifest/);
});

test('a manifest naming no upstream is refused rather than guessed at', async () => {
  await assert.rejects(() => run({ manifest: 'code: x\nmeta:\n  name: X\n' }), /names no meta\.links\.upstream/);
});

// ---- the pull request -------------------------------------------------------

// ---- through a fork to the project ------------------------------------------

/** The manifest's link is a fork; the project is one hop up, under a different owner. */
const FORKED = {
  ...HAPPY,
  'GET /repos/louislam/uptime-kuma': { default_branch: 'master', fork: true, source: { full_name: 'kuma-org/uptime-kuma' } },
  'GET /repos/kuma-org/uptime-kuma': { default_branch: 'main' },
  'GET /repos/kuma-org/uptime-kuma/git/ref/heads/main': { object: { sha: 'ROOTSHA' } },
  'GET /repos/kuma-org/uptime-kuma/contents/README.md?ref=ROOTSHA': {
    content: Buffer.from('# Uptime Kuma\n\nText.').toString('base64'),
    sha: 'ROOTREADME',
  },
  'POST /repos/kuma-org/uptime-kuma/forks': {},
  'POST /repos/kuma-org/uptime-kuma/pulls': { html_url: 'https://github.com/kuma-org/uptime-kuma/pull/4', number: 4 },
};

test('a manifest link that is a fork sends the offer to the project instead', async () => {
  // meta.links.upstream records where the packaged code came from, which for some templates is a
  // fork of the project. Offering the button to that fork means offering it to whoever made it,
  // often one of us, while the project it belongs to never hears about it.
  const seen = [];
  const out = await run({ script: FORKED }, seen);
  assert.equal(out.upstream, 'kuma-org/uptime-kuma');
  assert.equal(out.declared, 'louislam/uptime-kuma', 'the answer still says what the manifest named');
  assert.equal(out.url, 'https://github.com/kuma-org/uptime-kuma/pull/4');
  assert.ok(seen.includes('POST /repos/kuma-org/uptime-kuma/forks'), 'the project is what gets forked');
  assert.ok(seen.includes('POST /repos/kuma-org/uptime-kuma/pulls'), 'and what receives the pull request');
  assert.ok(!seen.some((c) => /^POST \/repos\/louislam.*(forks|pulls)/.test(c)), 'the fork receives nothing');
  // The base comes from the project's own default branch, which need not match the fork's.
  assert.ok(seen.includes('GET /repos/kuma-org/uptime-kuma/git/ref/heads/main'));
  assert.ok(seen.includes('GET /repos/kuma-org/uptime-kuma/contents/README.md?ref=ROOTSHA'));
});

test('a repository that is not a fork is left exactly where the manifest put it', async () => {
  const seen = [];
  const out = await run({}, seen);
  assert.equal(out.upstream, 'louislam/uptime-kuma');
  assert.equal(out.declared, 'louislam/uptime-kuma');
  assert.equal(seen.filter((c) => c === 'GET /repos/louislam/uptime-kuma').length, 1, 'no second lookup');
});

test('a fork GitHub names no source for is refused rather than offered to the fork', async () => {
  const orphan = { ...HAPPY, 'GET /repos/louislam/uptime-kuma': { default_branch: 'master', fork: true } };
  const seen = [];
  await assert.rejects(() => run({ script: orphan }, seen), /names no project it was forked from/);
  assert.ok(!seen.some((c) => c.includes('/forks')));
});

test('the own-account guard is applied to the project, not to the fork it went through', async () => {
  // A fork of someone else's project can perfectly well be ours. Checking the declared owner would
  // refuse that outright; checking the resolved one is the question that matters, and the reverse
  // case, our own project behind someone else's fork, is what must still be refused.
  const ours = {
    ...FORKED,
    'GET /repos/louislam/uptime-kuma': { default_branch: 'master', fork: true, source: { full_name: 'CarmenDou/uptime-kuma' } },
    'GET /repos/CarmenDou/uptime-kuma': { default_branch: 'main' },
  };
  await assert.rejects(() => run({ script: ours }), /belongs to the account this would fork it into/);

  // And the other direction, which is laya's: the manifest names a fork that IS ours, while the
  // project behind it is not. The guard ran before the redirect until now and would have refused
  // this outright, which is the one case the whole feature exists for.
  const oursIsTheFork = {
    ...FORKED,
    'GET /user': { login: 'louislam' },
    'GET /repos/louislam/uptime-kuma': { default_branch: 'master', fork: true, source: { full_name: 'kuma-org/uptime-kuma' } },
    'GET /repos/louislam/uptime-kuma-root': { default_branch: 'main' },
    'POST /repos/louislam/uptime-kuma/git/refs': {},
    'PUT /repos/louislam/uptime-kuma/contents/README.md': {},
  };
  const out = await run({ script: oursIsTheFork });
  assert.equal(out.upstream, 'kuma-org/uptime-kuma', 'it reached the project behind our own fork');
  assert.equal(out.declared, 'louislam/uptime-kuma');
});

test('the pull request goes to THEM, from a branch on our fork', async () => {
  const seen = [];
  const out = await run({}, seen);
  assert.equal(out.url, 'https://github.com/louislam/uptime-kuma/pull/9');
  assert.equal(out.upstream, 'louislam/uptime-kuma');
  assert.equal(out.fork, 'CarmenDou/uptime-kuma');
  assert.ok(seen.includes('POST /repos/louislam/uptime-kuma/forks'));
  assert.ok(seen.includes('POST /repos/louislam/uptime-kuma/pulls'), 'opened on theirs');
  assert.ok(
    seen.every((call) => !/^(PUT|PATCH) \/repos\/louislam/.test(call)),
    'nothing is ever written into their repository directly',
  );
});

test('the whole contribution is one README line and nothing else', async () => {
  const seen = [];
  await run({}, seen);
  const writes = seen.filter((c) => c.startsWith('PUT '));
  assert.deepEqual(writes, ['PUT /repos/CarmenDou/uptime-kuma/contents/README.md']);
  // The manifest is READ, out of our own registry, and never written into theirs: it is ours to
  // keep working, which is the whole reason this is a one-line ask.
  assert.ok(seen.includes('RAW /uptime-kuma/insta.template.yaml'), 'ours is read');
  assert.ok(
    !seen.some((c) => /^(PUT|POST|PATCH) .*insta\.template\.yaml/.test(c)),
    'and a manifest in their repository is not part of the offer any more',
  );
});

test('the branch starts from UPSTREAM head, so an old fork cannot carry a stale base', async () => {
  const seen = [];
  await run({}, seen);
  assert.ok(seen.includes('GET /repos/louislam/uptime-kuma/git/ref/heads/master'));
  assert.ok(!seen.includes('GET /repos/CarmenDou/uptime-kuma/git/ref/heads/master'));
  // And the README it edits is theirs at that commit, not whatever the fork held.
  assert.ok(seen.includes('GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE'));
});

test('a repository with no README is refused, and nothing is forked for it', async () => {
  const noReadme = { ...HAPPY };
  delete noReadme['GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE'];
  const seen = [];
  await assert.rejects(() => run({ script: noReadme }, seen), /no README\.md at its root/);
  assert.ok(!seen.some((c) => c.includes('/forks')), 'no fork left behind for a PR that cannot exist');
});

test('a README that already carries the button is refused, and nothing is forked', async () => {
  const already = {
    ...HAPPY,
    'GET /repos/louislam/uptime-kuma/contents/README.md?ref=BASE': {
      content: Buffer.from(`# Uptime Kuma\n\n${deployButton(CODE)}\n`).toString('base64'),
      sha: 'READMESHA',
    },
  };
  const seen = [];
  await assert.rejects(() => run({ script: already }, seen), /already carries this button/);
  assert.ok(!seen.some((c) => c.includes('/forks')));
  assert.ok(!seen.some((c) => c.startsWith('PUT ')));
});

test('it waits for the fork, which GitHub creates asynchronously', async () => {
  let tries = 0;
  const late = {
    ...HAPPY,
    get 'GET /repos/CarmenDou/uptime-kuma'() {
      tries += 1;
      return tries < 3 ? { status: 404, message: 'Not Found' } : { default_branch: 'master' };
    },
  };
  let waited = 0;
  const out = await openUpstreamPr(config, { code: CODE }, {
    fetchImpl: world({ script: late }),
    wait: async () => { waited += 1; },
  });
  assert.equal(out.number, 9);
  assert.ok(waited >= 2, 'it waited rather than failing on the first 404');
});

test('the scope failure is named, because it is the one with a fix', async () => {
  const denied = { ...HAPPY, 'POST /repos/louislam/uptime-kuma/forks': { status: 403, message: 'Resource not accessible by personal access token' } };
  await assert.rejects(() => run({ script: denied }), /classic token with public_repo/);
});

test('without a credential it refuses before touching anything, and names both places', async () => {
  const seen = [];
  const rejected = openUpstreamPr({}, { code: CODE }, { fetchImpl: world({}, seen), wait: async () => {} });
  await assert.rejects(rejected, /GITHUB_PR_TOKEN is not in this process/);
  // The first version of this message said only that no credential was configured, and was read as
  // the agent box being unconfigured. The secret on the service and the env map hermes launches
  // this with are two different places, and a reader who is told about one will check that one.
  await assert.rejects(rejected, /secret on the hermes service/);
  await assert.rejects(rejected, /env map of ~\/\.hermes\/config\.yaml/);
  assert.deepEqual(seen, [], 'not even the catalog read');
});

test('it refuses to fork a repository the credential already owns', async () => {
  const mine = { ...HAPPY, 'GET /user': { login: 'louislam' } };
  await assert.rejects(() => run({ script: mine }), /belongs to the account/);
});

// ---- what the maintainer reads ---------------------------------------------

test('the pull request says what it is, where it goes, and that there is nothing to maintain', () => {
  const { title, body } = offerText(TEMPLATE);
  assert.match(title, /Deploy on InstaCloud button/);
  assert.match(body, /Uptime Kuma/);
  assert.match(body, /https:\/\/instacloud\.com\/templates\/uptime-kuma/);
  assert.match(body, /Nothing else in this repository changes/);
  assert.match(body, /nothing here for you to maintain/);
  // A maintainer who owes us nothing is told so plainly.
  assert.match(body, /closing this is a fine answer/);
});

test('a template with no display name falls back to its code rather than saying undefined', () => {
  assert.match(offerText({ code: 'bare' }).body, /^bare is published/);
});

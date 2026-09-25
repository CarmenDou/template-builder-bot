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

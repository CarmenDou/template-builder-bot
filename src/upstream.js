// Offering a published template back to the project it was built from.
//
// The whole contribution is ONE README line. Nothing about the template lives in
// their repository: it is in our registry, the button points at its gallery page,
// and we keep it working. That is what makes this a reasonable thing to send a
// stranger, and it is why the template has to be published before the offer can
// be made at all. A button pointing at a page that does not exist yet is the one
// way this becomes rude.
//
// The agent box cannot do this and must not be able to: a token that can open a
// pull request on anyone's repository is a token that can push to every public
// repository its owner can write to, and the box runs whatever a job decides to
// run. So the credential lives out here, and everything the tool acts on is
// DERIVED from one template code through reads anyone can make: the catalog says
// whether it is published, and the registry's own manifest says whose project it
// is. A caller never names the repository to be written to.

const API = 'https://api.github.com';

/**
 * Prod, deliberately, and not configurable: the button this opens points at
 * prod's gallery page, so prod's catalog is the only one that can answer whether
 * that page exists.
 */
const CATALOG = 'https://api.instacloud.com/templates';
/** The registry repo, where a published template's manifest is readable raw. */
const REGISTRY_MANIFEST = (code) =>
  `https://raw.githubusercontent.com/InsForge/instacloud-oss/main/templates/${code}/insta.template.yaml`;

/** Long enough for a fork to exist; GitHub creates one asynchronously. */
const FORK_ATTEMPTS = 10;
const FORK_DELAY_MS = 3000;

const REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
/** A template code as the registry spells it, which is also its directory name. */
const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class UpstreamError extends Error {}

/** owner/repo from a GitHub repository URL. */
export function parseRepo(url) {
  const m = REPO.exec(String(url ?? '').trim());
  if (!m) throw new UpstreamError(`${url || '(nothing)'} is not a GitHub repository URL.`);
  return { owner: m[1], repo: m[2] };
}

/**
 * The one line that goes into their README, pointing at the template's gallery
 * page.
 *
 * The gallery page and not the console's deploy route, for the same two reasons
 * our own template READMEs carry: it is the indexed page, so the badge spends its
 * link somewhere a crawler can read, and whoever clicks a badge in someone else's
 * repository has usually never heard of us, so the first screen should say what
 * this is rather than ask them to sign in.
 */
export function deployButton(code) {
  const badge = 'https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg';
  return `[![Deploy on InstaCloud](${badge})](https://instacloud.com/templates/${code})`;
}

/**
 * The upstream project's repository, out of the template's own manifest.
 *
 * Not out of the catalog: `meta.links` is not part of what it serves, and the
 * `upstream` object it does serve names a repository for only some templates
 * (n8n carries `upstream.repo`, claude-code carries a package instead). Every
 * manifest carries `meta.links.upstream`, so that is the single field read here.
 *
 * Scanned rather than parsed, because this process has no dependencies. The scan
 * is therefore deliberately narrow, and a manifest it cannot read is refused
 * rather than guessed at: the `upstream:` key two levels under a top-level
 * `meta:`, and nothing else. A `links:` block elsewhere in the document, or an
 * `upstream:` at the top level (which is the version pin, not a repository),
 * must not answer.
 */
export function upstreamLink(manifest) {
  let inMeta = false;
  let inLinks = false;
  for (const line of String(manifest ?? '').split('\n')) {
    if (/^\S/.test(line)) {
      inMeta = /^meta:\s*(#.*)?$/.test(line);
      inLinks = false;
      continue;
    }
    if (!inMeta) continue;
    if (/^ {2}\S/.test(line)) {
      inLinks = /^ {2}links:\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inLinks) continue;
    const m = /^ {4}upstream:\s*(\S.*?)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

/** A line that is nothing but badges: one or more linked images, and whitespace. */
const BADGE_ONLY = /^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/;
/** The fence that opens or closes a code block, at most three spaces in, any length. */
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * Every line of a README paired with whether it is inside a fenced code block.
 *
 * Needed because both of the things this looks for have a twin inside a code
 * block that means something else. `# something` in a shell or Python sample is
 * a comment, not a heading, and laya's README has one 700 lines down: placing
 * the button there put it inside the sample.
 */
function outsideFences(readme) {
  let fence = null;
  return readme.split('\n').map((text) => {
    const m = FENCE.exec(text);
    if (m && (fence === null || text.trimStart().startsWith(fence))) {
      fence = fence === null ? m[1] : null;
      return { text, open: false };
    }
    return { text, open: fence === null };
  });
}

/**
 * Where the button goes in a README that already has some.
 *
 * Beside the badges it is one of, rather than at the top: a repository that
 * carries a row of badges has already decided where these live, and a maintainer
 * reading the diff should see one line join a row, not a new section above their
 * title. Any badge row, not only a row of deploy buttons: laya's is Colab, PyPI,
 * Docs and Hugging Face, and matching on vendor names in the alt text missed it
 * entirely. With no row to join it goes after the first heading, which is where
 * a reader looks first, and with neither it goes at the top.
 */
export function withButton(readme, line) {
  if (readme.includes(line)) return readme;
  const scanned = outsideFences(readme);
  const lines = scanned.map((l) => l.text);
  const find = (test) => scanned.findIndex((l) => l.open && test(l.text));

  const badgeRow = find((t) => BADGE_ONLY.test(t));
  if (badgeRow >= 0) {
    // AFTER the row, not inside it. A project that lists Colab, then PyPI, then docs has put them
    // in an order, and appending is the difference between adding a line and rearranging theirs.
    let end = badgeRow;
    while (end + 1 < scanned.length && scanned[end + 1].open && BADGE_ONLY.test(lines[end + 1])) end += 1;
    return [...lines.slice(0, end + 1), line, ...lines.slice(end + 1)].join('\n');
  }
  const heading = find((t) => /^#{1,6}\s/.test(t));
  const at = heading >= 0 ? heading + 1 : 0;
  return [...lines.slice(0, at), '', line, ...lines.slice(at)].join('\n');
}

function gh(token, fetchImpl) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from GitHub is an outage page, not an answer we can read.
    }
    if (!response.ok) {
      const said = data?.message ?? `${response.status}`;
      // The scope answer, named rather than passed through: it is the one failure with a fix.
      const hint = response.status === 403 && /not accessible by personal access token/i.test(said)
        ? ' The token cannot reach repositories it does not own: opening a pull request on someone else\'s repository needs a classic token with public_repo.'
        : '';
      throw new UpstreamError(`GitHub refused ${method} ${path}: ${said}.${hint}`);
    }
    return data;
  };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The catalog's entry for a code, and the gate on everything below it.
 *
 * 200 means published, because the route reads a row and refuses one that is not
 * (`getTemplate`, insta-platform). 404 covers a draft and a code that was never a
 * template alike, and both mean the same thing here: the page the button would
 * point at does not exist, so there is nothing to offer yet.
 */
export async function publishedTemplate(code, deps = {}) {
  const { fetchImpl = fetch } = deps;
  if (!CODE.test(String(code ?? ''))) {
    throw new UpstreamError(`'${code ?? ''}' is not a template code.`);
  }
  const response = await fetchImpl(`${CATALOG}/${code}`, { headers: { accept: 'application/json' } });
  if (response.status === 404) {
    throw new UpstreamError(
      `${code} is not published, so https://instacloud.com/templates/${code} does not exist and the button would be broken. Publish it first, then offer it.`,
    );
  }
  if (!response.ok) throw new UpstreamError(`The catalog answered ${response.status} for ${code}.`);
  const template = (await response.json().catch(() => null))?.template;
  if (!template?.code) throw new UpstreamError(`The catalog's answer for ${code} carried no template.`);
  return template;
}

/**
 * Everything the offer is made of, derived from the code alone: the published
 * template, and the project its manifest names as upstream. A caller supplies no
 * repository, so a broad credential still has exactly one place it can be aimed.
 */
export async function upstreamOffer(code, deps = {}) {
  const { fetchImpl = fetch } = deps;
  const template = await publishedTemplate(code, deps);
  const response = await fetchImpl(REGISTRY_MANIFEST(code), { headers: { accept: 'text/plain' } });
  if (!response.ok) {
    throw new UpstreamError(`The registry carries no manifest for ${code} (GitHub answered ${response.status}).`);
  }
  const link = upstreamLink(await response.text());
  if (!link) {
    throw new UpstreamError(
      `${code}'s manifest names no meta.links.upstream, so there is no project to offer it to. Add that link to the manifest first.`,
    );
  }
  const { owner, repo } = parseRepo(link);
  return { template, owner, repo, repoUrl: `https://github.com/${owner}/${repo}`, line: deployButton(code) };
}

/**
 * What the pull request says, written from what the catalog already serves.
 *
 * Generated rather than authored, because the change is one line and the honest
 * description of it is always the same three facts: it is published, here is the
 * page, nothing else in your repository changes. An agent writing prose here
 * would add length without adding any of that.
 */
export function offerText(template) {
  const code = template.code;
  const name = template.name || code;
  const page = `https://instacloud.com/templates/${code}`;
  return {
    title: 'Add a Deploy on InstaCloud button to the README',
    body: [
      `${name} is published as a template on InstaCloud, so this adds one line to the README: a button linking to ${page}.`,
      '',
      'That page reads without an account. It lists the services the template creates and the variables it asks for, and deploying from it provisions all of them in one step.',
      '',
      `Nothing else in this repository changes. The template itself lives in our registry at https://github.com/InsForge/instacloud-oss/tree/main/templates/${code} and we keep it working, so there is nothing here for you to maintain. If you would rather not carry the button, closing this is a fine answer.`,
    ].join('\n'),
  };
}

/**
 * Fork, commit the one README edit onto a branch of the fork, and open the pull
 * request. Everything through the REST API: this process has no clone of
 * anything, and a fork plus one file write is the whole change.
 *
 * Idempotent where GitHub lets it be. Forking again returns the existing fork,
 * and a second call with the same branch name fails at the branch rather than
 * opening a duplicate pull request.
 */
export async function openUpstreamPr(config, { code }, deps = {}) {
  const { fetchImpl = fetch, wait = sleep } = deps;
  if (!config.githubPrToken) {
    // Names BOTH places, because there are two and the obvious one is not enough. Setting the
    // secret on the hermes service puts the name in that CONTAINER's environment; hermes then
    // launches this server with an explicit env map in ~/.hermes/config.yaml, and a name missing
    // from that map is absent here regardless. The first time this fired, the message said only
    // "no credential is configured" and was read as the agent box being unconfigured, which sent
    // the reader somewhere the problem was not.
    throw new UpstreamError(
      'GITHUB_PR_TOKEN is not in this process\'s environment, so there is no credential to open a pull request with. '
      + 'When this runs as hermes\' MCP server it has to be in TWO places: a secret on the hermes service, AND a name in '
      + 'the env map of ~/.hermes/config.yaml, which is a whitelist. Restart hermes after adding it there.',
    );
  }
  // Published first, and before the fork: every write below is on someone else's
  // account, and none of it should happen for a template with no page to link to.
  const offer = await upstreamOffer(code, deps);
  const { template, line } = offer;
  // Reassigned below when the manifest's link turns out to be a fork.
  let { owner, repo } = offer;
  const { title, body } = offerText(template);
  const call = gh(config.githubPrToken, fetchImpl);

  const me = (await call('GET', '/user')).login;

  // Through a fork to the project itself.
  //
  // `meta.links.upstream` records where the packaged code came from, and for some templates that
  // is a FORK: laya's manifest points at tonychang04/laya-template because the image bakes that
  // fork's deploy/app.py at a pinned commit. Correct for what the field is for, and the wrong
  // place to send this: the fork's owner is one of us, so the offer would go to ourselves while
  // the project it belongs to never hears about it. GitHub's `source` is the root of the fork
  // network, which is the project a reader of that README would say they are looking at.
  //
  // The manifest is left alone on purpose, since the gallery renders that same link as "where this
  // came from" and that answer is still the fork.
  let target = await call('GET', `/repos/${owner}/${repo}`);
  const declared = `${owner}/${repo}`;
  if (target.fork) {
    const root = target.source?.full_name ?? target.parent?.full_name;
    if (!root) throw new UpstreamError(`${declared} is a fork, but GitHub names no project it was forked from.`);
    ({ owner, repo } = parseRepo(`https://github.com/${root}`));
    target = await call('GET', `/repos/${owner}/${repo}`);
  }
  // After the redirect, never before: the fork this would be pointed through may be ours even when
  // the project on the far side is not.
  if (me.toLowerCase() === owner.toLowerCase()) {
    throw new UpstreamError(`${owner}/${repo} belongs to the account this would fork it into.`);
  }

  const base = target.default_branch;
  // Branch from UPSTREAM's head, not the fork's: a fork made long ago sits on an old commit.
  const baseSha = (await call('GET', `/repos/${owner}/${repo}/git/ref/heads/${base}`)).object.sha;

  // The whole change, decided from UPSTREAM's own README and BEFORE anything is created. This edit
  // is the only commit the branch will carry, so a README that already has the line, or a
  // repository with none to edit, means there is no pull request to open at all. Deciding that
  // after forking would leave a fork and a branch behind and then fail at the pull request with
  // GitHub's own "no commits between", which says nothing about why.
  let file;
  try {
    file = await call('GET', `/repos/${owner}/${repo}/contents/README.md?ref=${baseSha}`);
  } catch {
    throw new UpstreamError(`${owner}/${repo} has no README.md at its root, so there is nowhere to put the button.`);
  }
  const current = Buffer.from(file.content, 'base64').toString('utf8');
  const updated = withButton(current, line);
  if (updated === current) {
    throw new UpstreamError(`${owner}/${repo}'s README already carries this button. Nothing to offer.`);
  }

  await call('POST', `/repos/${owner}/${repo}/forks`, {});
  // The fork is created asynchronously, and reading it too early 404s.
  let fork = null;
  for (let i = 0; i < FORK_ATTEMPTS && !fork; i += 1) {
    try {
      fork = await call('GET', `/repos/${me}/${repo}`);
    } catch {
      await wait(FORK_DELAY_MS);
    }
  }
  if (!fork) throw new UpstreamError(`The fork of ${owner}/${repo} did not appear in time. Try again.`);

  const branch = 'instacloud-deploy-button';
  await call('POST', `/repos/${me}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  await call('PUT', `/repos/${me}/${repo}/contents/README.md`, {
    message: 'Add a Deploy on InstaCloud button',
    content: b64(updated),
    sha: file.sha,
    branch,
  });

  const pr = await call('POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head: `${me}:${branch}`,
    base,
    maintainer_can_modify: true,
  });
  return { url: pr.html_url, number: pr.number, upstream: `${owner}/${repo}`, declared, fork: `${me}/${repo}`, branch };
}

// Offering a template back to the repository it was built from.
//
// The agent box cannot do this and must not be able to: a token that can open a
// pull request on anyone's repository is a token that can push to every public
// repository its owner can write to, and the box runs whatever a job decides to
// run. So the box prepares the contribution as files in its job directory, and
// the credential lives out here, reachable only through one tool that names one
// repository. Same reason the platform key is on this side.

const API = 'https://api.github.com';

/** Long enough for a fork to exist; GitHub creates one asynchronously. */
const FORK_ATTEMPTS = 10;
const FORK_DELAY_MS = 3000;

const REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

export class UpstreamError extends Error {}

/** owner/repo from the URL a job was started with. */
export function parseRepo(url) {
  const m = REPO.exec(String(url ?? '').trim());
  if (!m) throw new UpstreamError(`${url || '(nothing)'} is not a GitHub repository URL.`);
  return { owner: m[1], repo: m[2] };
}

/**
 * The one line that goes into their README, pointing at the console route that
 * reads the manifest out of their own repository.
 */
export function deployButton(owner, repo) {
  const badge = 'https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg';
  const target = `https://console.instacloud.com/deploy?repo=https://github.com/${owner}/${repo}`;
  return `[![Deploy on InstaCloud](${badge})](${target})`;
}

/**
 * Where the button goes in a README that already has some.
 *
 * Beside the badges it is one of, rather than at the top: a repository that
 * carries Deploy on Railway or Deploy to Render has already decided where these
 * live, and a maintainer reading the diff should see one line join a row, not a
 * new section above their title. With no row to join it goes after the first
 * heading, which is where a reader looks first.
 */
export function withButton(readme, line) {
  if (readme.includes(line)) return readme;
  const lines = readme.split('\n');
  const badgeRow = lines.findIndex((l) => /\[!\[[^\]]*(deploy|railway|render|heroku|vercel|netlify)/i.test(l));
  if (badgeRow >= 0) return [...lines.slice(0, badgeRow + 1), line, ...lines.slice(badgeRow + 1)].join('\n');
  const heading = lines.findIndex((l) => /^#\s/.test(l));
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
 * Fork, commit the two files onto a branch of the fork, and open the pull
 * request. Everything through the REST API: this process has no clone of
 * anything, and a fork plus two file writes is the whole change.
 *
 * Idempotent where GitHub lets it be. Forking again returns the existing fork,
 * and a second call with the same branch name fails at the branch rather than
 * opening a duplicate pull request.
 */
export async function openUpstreamPr(config, { repoUrl, manifest, readmeLine, title, body }, deps = {}) {
  const { fetchImpl = fetch, wait = sleep } = deps;
  if (!config.githubPrToken) {
    throw new UpstreamError('No GitHub credential is configured for opening pull requests upstream.');
  }
  const { owner, repo } = parseRepo(repoUrl);
  if (!manifest?.trim()) throw new UpstreamError('The job left no insta.template.yaml to offer.');
  const call = gh(config.githubPrToken, fetchImpl);

  const me = (await call('GET', '/user')).login;
  if (me.toLowerCase() === owner.toLowerCase()) {
    throw new UpstreamError(`${owner}/${repo} belongs to the account this would fork it into.`);
  }

  const upstream = await call('GET', `/repos/${owner}/${repo}`);
  const base = upstream.default_branch;

  await call('POST', `/repos/${owner}/${repo}/forks`, {});
  // The fork is created asynchronously, and reading its default branch too early 404s.
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
  // Branch from UPSTREAM's head, not the fork's: a fork made long ago sits on an old commit.
  const baseSha = (await call('GET', `/repos/${owner}/${repo}/git/ref/heads/${base}`)).object.sha;
  await call('POST', `/repos/${me}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });

  await call('PUT', `/repos/${me}/${repo}/contents/insta.template.yaml`, {
    message: 'Add an InstaCloud template manifest',
    content: b64(manifest),
    branch,
  });

  if (readmeLine?.trim()) {
    // Read the README off UPSTREAM at the commit branched from, so the edit is against what a
    // maintainer has, not against whatever an old fork carried.
    const file = await call('GET', `/repos/${owner}/${repo}/contents/README.md?ref=${baseSha}`);
    const current = Buffer.from(file.content, 'base64').toString('utf8');
    const updated = withButton(current, readmeLine.trim());
    if (updated !== current) {
      await call('PUT', `/repos/${me}/${repo}/contents/README.md`, {
        message: 'Add a Deploy on InstaCloud button',
        content: b64(updated),
        sha: file.sha,
        branch,
      });
    }
  }

  const pr = await call('POST', `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head: `${me}:${branch}`,
    base,
    maintainer_can_modify: true,
  });
  return { url: pr.html_url, number: pr.number, fork: `${me}/${repo}`, branch };
}

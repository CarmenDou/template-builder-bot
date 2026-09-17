// Parsing a mention into a job request. The bot answers to exactly one shape:
// a GitHub repository URL somewhere in the message. Everything else is ignored,
// which keeps "@bot can you look at https://github.com/x/y" working.

const GITHUB_URL = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?]\S*)?(?=\s|$)/g;

// A follow-up names the PR, not the thread. Threads are convenient but fragile:
// a different channel, a restarted bot or a conversation resumed days later all
// lose them, while a PR number is enough to recover the branch and therefore the
// whole context from GitHub itself.
const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;
const PR_HASH = /(?:^|\s)#(\d{1,6})(?=\s|$)/g;

export function parseList(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Slack wraps bare URLs as <https://...> and may add a |label. Strip that first,
// otherwise the trailing ">" ends up inside the repo name.
function unwrapSlackLinks(text) {
  return String(text ?? '').replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, '$1');
}

export function stripMention(text) {
  return unwrapSlackLinks(text).replace(/<@[A-Z0-9]+>/g, ' ');
}

/**
 * Returns { kind, repos, pr, extra }.
 *
 *   kind 'new'      -> repos[0] is the repository to template
 *   kind 'followup' -> pr is the PR number to keep working on
 *   kind 'none'     -> nothing actionable in the message
 *
 * `extra` is whatever the human wrote besides the mention and the link, passed
 * through to the agent so "use the small model" style feedback is not lost.
 */
export function parseCommand(text) {
  const cleaned = stripMention(text);

  // A PR reference wins over a repo url: a PR link is also a github.com/owner/repo
  // url, and reading it as "template this repository" would restart from scratch
  // on our own monorepo instead of continuing the work.
  const prUrls = [...cleaned.matchAll(PR_URL)];
  if (prUrls.length > 0) {
    const pr = Number(prUrls[0][3]);
    const extra = cleaned.replace(PR_URL, ' ').replace(/\s+/g, ' ').trim();
    return { kind: 'followup', repos: [], pr, extra };
  }

  const hashes = [...cleaned.matchAll(PR_HASH)];
  if (hashes.length > 0) {
    const pr = Number(hashes[0][1]);
    const extra = cleaned.replace(PR_HASH, ' ').replace(/\s+/g, ' ').trim();
    return { kind: 'followup', repos: [], pr, extra };
  }

  const repos = [];
  const seen = new Set();
  for (const match of cleaned.matchAll(GITHUB_URL)) {
    const owner = match[1];
    const repo = match[2];
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ owner, repo, url: `https://github.com/${owner}/${repo}` });
  }

  const extra = cleaned.replace(GITHUB_URL, ' ').replace(/\s+/g, ' ').trim();
  return { kind: repos.length > 0 ? 'new' : 'none', repos, pr: null, extra };
}

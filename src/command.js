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

/**
 * The PR this thread is about, read from the messages themselves. The bot's own
 * earlier reply carries the link, so a human can say "change the model" with no
 * number and still be understood.
 * Takes the LAST one mentioned: a thread that moved on to a second PR is about
 * the second one.
 */
export function findPrInThread(messages) {
  let found = null;
  for (const m of messages ?? []) {
    const text = unwrapSlackLinks(m?.text ?? '');
    for (const match of text.matchAll(/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)/g)) {
      found = Number(match[1]);
    }
  }
  return found;
}

/** The thread as plain text for the agent, newest last, bot lines labelled. */
export function renderThread(messages, { botUserId, max = 4000 } = {}) {
  const lines = (messages ?? [])
    .map((m) => {
      const who = m?.bot_id || (botUserId && m?.user === botUserId) ? 'bot' : 'human';
      const text = stripMention(m?.text ?? '').replace(/\s+/g, ' ').trim();
      return text ? `${who}: ${text}` : null;
    })
    .filter(Boolean);

  const joined = lines.join('\n');
  return joined.length > max ? joined.slice(-max) : joined;
}

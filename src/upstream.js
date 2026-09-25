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

/** A markdown table row, and the rule under a table's header. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
/**
 * A deploy button: a LINKED IMAGE whose label names a host or says deploy.
 *
 * The whole `[![label](img)](href)` shape is required, not the words on their own.
 * laya's README has a table comparing "Deployment Mode" against latency, and a
 * looser test read that as a row of deploy buttons and added a column to it.
 */
const DEPLOY_BADGE = /\[!\[[^\]]*(?:deploy|railway|zeabur|sealos|repocloud|render|heroku|vercel|netlify|koyeb)[^\]]*\]\([^)]*\)\]\([^)]*\)/i;

/** The runs of consecutive badge-only lines, outside fences. */
function badgeRuns(scanned) {
  const runs = [];
  for (let i = 0; i < scanned.length; i += 1) {
    if (!scanned[i].open || !BADGE_ONLY.test(scanned[i].text)) continue;
    const start = i;
    while (i + 1 < scanned.length && scanned[i + 1].open && BADGE_ONLY.test(scanned[i + 1].text)) i += 1;
    runs.push({ start, end: i });
  }
  return runs;
}

/** A table of deploy buttons: a header, its rule, and a body row carrying a vendor's button. */
function deployTable(scanned) {
  for (let i = 0; i + 2 < scanned.length; i += 1) {
    if (!scanned[i].open || !TABLE_ROW.test(scanned[i].text) || TABLE_RULE.test(scanned[i].text)) continue;
    if (!TABLE_RULE.test(scanned[i + 1].text)) continue;
    let end = i + 1;
    while (end + 1 < scanned.length && scanned[end + 1].open && TABLE_ROW.test(scanned[end + 1].text)) end += 1;
    const body = scanned.slice(i + 2, end + 1).map((l) => l.text);
    const carries = body.some((t) => DEPLOY_BADGE.test(t));
    if (carries) return { header: i, rule: i + 1, bodyStart: i + 2, end };
  }
  return null;
}

/** How much of a README the briefing shows: the opening, and around anything deploy-shaped. */
const BRIEF_HEAD = 50;
const BRIEF_PAD = 4;
const BRIEF_MAX = 200;
/** A host named in prose, which is how a README that has no buttons still has a deploy section. */
const VENDOR_WORD = /\b(railway|zeabur|sealos|repocloud|render\.com|heroku|vercel|netlify|koyeb|one-click)\b/i;

/**
 * The parts of a README worth reading before deciding where a button goes.
 *
 * Not the whole file: laya's is 1131 lines and the answer is always near the top
 * or beside whatever deploy affordance already exists. Numbered from 1, with gaps
 * marked, so a caller can name a region back.
 */
export function readmeBriefing(readme) {
  const scanned = outsideFences(readme);
  const lines = scanned.map((l) => l.text);
  const want = new Set();
  const add = (a, b) => {
    for (let i = Math.max(0, a); i <= Math.min(lines.length - 1, b) && want.size < BRIEF_MAX; i += 1) want.add(i);
  };
  add(0, BRIEF_HEAD - 1);
  const t = deployTable(scanned);
  if (t) add(t.header - BRIEF_PAD, t.end + BRIEF_PAD);
  for (const r of badgeRuns(scanned)) {
    if (lines.slice(r.start, r.end + 1).some((x) => DEPLOY_BADGE.test(x))) add(r.start - BRIEF_PAD, r.end + BRIEF_PAD);
  }
  scanned.forEach((l, i) => { if (l.open && VENDOR_WORD.test(l.text)) add(i - BRIEF_PAD, i + BRIEF_PAD); });

  const show = [...want].sort((a, b) => a - b);
  const width = String(lines.length).length;
  const out = [];
  let last = -1;
  for (const i of show) {
    if (i !== last + 1) out.push(`${' '.repeat(width)} | ...`);
    out.push(`${String(i + 1).padStart(width)} | ${lines[i]}`);
    last = i;
  }
  if (last < lines.length - 1) out.push(`${' '.repeat(width)} | ... (${lines.length} lines in all)`);
  return out.join('\n');
}

/** Every URL in a piece of text, as a set. */
const urlsIn = (text) => new Set(String(text ?? '').match(/https?:\/\/[^\s)\]<>"'`]+/g) ?? []);

/**
 * The one stretch of lines an edit changed, found from both ends.
 *
 * Matching by VALUE rather than by position is what a first version did, and a
 * blank line the edit added made every blank line in the file look edited. Equal
 * prefixes and suffixes cannot do that, and they carry a second property worth
 * having: whatever is outside the stretch is identical, byte for byte, so an edit
 * that touches two distant places is reported as one enormous one and refused.
 */
function changedRegion(o, p) {
  let head = 0;
  while (head < o.length && head < p.length && o[head] === p[head]) head += 1;
  let tail = 0;
  while (tail < o.length - head && tail < p.length - head && o[o.length - 1 - tail] === p[p.length - 1 - tail]) tail += 1;
  return { removed: o.slice(head, o.length - tail), added: p.slice(head, p.length - tail) };
}

/** The most lines an edit that adds one button may add or change. */
const EDIT_MAX_LINES = 14;
/** How much of the original's length an edit may drop, as a fraction. */
const EDIT_MIN_KEPT = 0.98;

/**
 * Refuse an edit that is not the small, additive thing it is supposed to be.
 *
 * The text comes from a model, and it is pushed to a repository belonging to
 * someone who never asked us for anything, so the question is not whether the
 * model wrote something sensible but whether it can have destroyed anything. Each
 * check below is about destruction, not taste: taste is why a model writes this
 * at all, and no check here can or should second-guess it.
 */
export function verifyEdit(original, proposed, line) {
  const ours = urlsIn(line);
  const target = [...ours].find((u) => u.includes('/templates/'));
  const has = (text, url) => text.split(url).length - 1;

  if (target && has(original, target)) throw new UpstreamError('That README already links to this template.');
  if (!target || has(proposed, target) !== 1) {
    throw new UpstreamError(`The edit has to add the button exactly once, and it appears ${target ? has(proposed, target) : 0} time(s).`);
  }

  const before = urlsIn(original);
  const gone = [...before].filter((u) => !proposed.includes(u));
  if (gone.length) throw new UpstreamError(`The edit drops ${gone.length} link(s) the README had, starting with ${gone[0]}.`);

  if (proposed.length < Math.floor(original.length * EDIT_MIN_KEPT)) {
    throw new UpstreamError(`The edit is ${original.length - proposed.length} characters shorter than the README it edits, so something was cut rather than added.`);
  }

  const { added, removed } = changedRegion(original.split('\n'), proposed.split('\n'));
  if (added.length + removed.length > EDIT_MAX_LINES) {
    throw new UpstreamError(`The edit changes ${added.length + removed.length} lines, and adding one button should change at most ${EDIT_MAX_LINES}. An edit in two separate places counts as everything between them.`);
  }

  // It may not bring in links of its own. Ours, or ones the README already had.
  const foreign = [...urlsIn(added.join('\n'))].filter((u) => !before.has(u) && !ours.has(u));
  if (foreign.length) throw new UpstreamError(`The edit adds ${foreign.length} link(s) that are neither ours nor already in the README: ${foreign.slice(0, 2).join(', ')}.`);

  return { added: added.length, removed: removed.length };
}

/**
 * Replace one region of a README, and nothing outside it.
 *
 * The region is named by a caller and the splice is done here, so an edit cannot
 * reach past the lines it asked for however the replacement text is written.
 * `from` and `to` count from 1 and both ends are included, the way the briefing
 * numbers them.
 */
export function spliceRegion(readme, from, to, text) {
  const lines = readme.split('\n');
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= lines.length;
  if (!ok(from) || !ok(to) || to < from) {
    throw new UpstreamError(`from and to have to be lines between 1 and ${lines.length}, with to at or after from. Got ${JSON.stringify(from)} and ${JSON.stringify(to)}.`);
  }
  return [...lines.slice(0, from - 1), ...String(text ?? '').split('\n'), ...lines.slice(to)].join('\n');
}

/**
 * What a README offers as somewhere to put the button, for a caller that has to
 * choose between them.
 *
 * Reported rather than decided, because the choice is a judgement and the shapes
 * are not: a table of deploy buttons wants a column, a row of badges wants one
 * more badge, and a README with neither wants a section of its own rather than a
 * button wedged under whatever heading happens to be first.
 */
export function readmePlaces(readme) {
  const scanned = outsideFences(readme);
  const heading = scanned.findIndex((l) => l.open && /^#{1,6}\s/.test(l.text));
  return {
    table: deployTable(scanned),
    badges: badgeRuns(scanned),
    heading: heading >= 0 ? heading : null,
    lines: scanned.length,
  };
}

/** Append one cell to a table row, keeping whatever trailing whitespace it had. */
const withCell = (row, cell) => row.replace(/\|(\s*)$/, `| ${cell} |$1`);

/**
 * The button written into a README at a chosen place.
 *
 * The CALLER chooses where, out of what readmePlaces reported, and this writes
 * what goes there. Nothing a caller passes becomes text in the file: the mode
 * picks a shape and the line says which one of that shape, so the worst a wrong
 * choice can do is put the right line somewhere odd, never put something else in
 * someone's README.
 */
export function placeButton(readme, line, placement = {}) {
  if (readme.includes(line)) return readme;
  const { mode = 'auto', line: at } = placement;
  const scanned = outsideFences(readme);
  const lines = scanned.map((l) => l.text);
  const insert = (i, ...text) => [...lines.slice(0, i), ...text, ...lines.slice(i)].join('\n');
  // A block goes in with exactly one blank line on each side, however many were already there.
  // Without the trailing one the heading below runs straight into the button and the two render
  // as one paragraph; with an unconditional leading one, a README that already ends its section
  // with a blank gets two.
  const block = (i, ...text) => insert(
    i,
    ...(i > 0 && lines[i - 1].trim() !== '' ? [''] : []),
    ...text,
    ...(lines[i] !== undefined && lines[i].trim() !== '' ? [''] : []),
  );
  const needs = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > lines.length) {
      throw new UpstreamError(`${mode} needs a line between 1 and ${lines.length}, not ${JSON.stringify(at)}.`);
    }
    return n - 1; // the caller counts from 1, the way readmePlaces reports
  };

  if (mode === 'table-column') {
    const t = deployTable(scanned);
    if (!t) throw new UpstreamError('There is no table of deploy buttons in this README to add a column to.');
    const out = [...lines];
    out[t.header] = withCell(out[t.header], 'InstaCloud');
    out[t.rule] = withCell(out[t.rule], '---');
    // The button goes in the first body row, which is where the other buttons are. Any row below
    // it gets an empty cell, because a table with a short row renders as a broken one.
    for (let i = t.bodyStart; i <= t.end; i += 1) out[i] = withCell(out[i], i === t.bodyStart ? line : '');
    return out.join('\n');
  }

  if (mode === 'badge-row') {
    const runs = badgeRuns(scanned);
    const want = at === undefined ? runs[0] : runs.find((r) => at - 1 >= r.start && at - 1 <= r.end);
    if (!want) throw new UpstreamError(`No row of badges at line ${at ?? '(none given)'} in this README.`);
    return insert(want.end + 1, line);
  }

  if (mode === 'new-section') {
    const i = at === undefined ? 0 : needs(at);
    // Heading and button, nothing else. A paragraph explaining our product in someone else's
    // README is the thing a maintainer would have to edit or delete.
    return block(i, '## One-click Deployment', '', line);
  }

  if (mode === 'after-line') return block(needs(at) + 1, line);

  if (mode !== 'auto') throw new UpstreamError(`No such placement: ${mode}.`);

  // Where a project already put the others, or a section of our own. Those are the only two
  // answers: joining a row of Colab, PyPI and docs badges is not "where the deploy buttons live",
  // it is the middle of somebody's links, which is what laya's first offer looked like.
  if (deployTable(scanned)) return placeButton(readme, line, { mode: 'table-column' });
  const vendorRun = badgeRuns(scanned).find((r) => lines.slice(r.start, r.end + 1).some((t) => DEPLOY_BADGE.test(t)));
  if (vendorRun) return insert(vendorRun.end + 1, line);
  return block(sectionAt(scanned), '## One-click Deployment', '', line);
}

/**
 * Where a section of our own goes: at the end of whatever opens the README, just
 * before its first real section.
 *
 * A reader meets the pitch, then the ways to run it, which is where a one-click
 * deploy belongs. Above the title it would be the first thing in someone else's
 * project, and at the bottom nobody would find it.
 */
function sectionAt(scanned) {
  const sub = scanned.findIndex((l) => l.open && /^#{2,6}\s/.test(l.text));
  if (sub > 0) return sub;
  const first = scanned.findIndex((l) => l.open && /^#{1,6}\s/.test(l.text));
  return first >= 0 ? first + 1 : scanned.length;
}

/** Where the button goes when nobody chose. See `auto` in placeButton. */
export function withButton(readme, line) {
  return placeButton(readme, line, { mode: 'auto' });
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
export async function openUpstreamPr(config, { code, edit, preview }, deps = {}) {
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
  if (current.includes(line)) {
    throw new UpstreamError(`${owner}/${repo}'s README already carries this button. Nothing to offer.`);
  }

  // The look before the leap. Answering here rather than from a second tool keeps one resolution
  // path: what this reports is the repository and the text the send would act on, not a second
  // guess at them.
  if (preview) {
    return {
      preview: true,
      upstream: `${owner}/${repo}`,
      declared,
      line,
      lines: current.split('\n').length,
      briefing: readmeBriefing(current),
    };
  }

  // The caller's own text when it named a region, and the built-in placement otherwise. Either way
  // the splice happens here and verifyEdit runs on the result, so a written edit cannot reach past
  // the lines it asked for and neither one can push something that is not a small addition.
  const updated = edit
    ? spliceRegion(current, edit.from, edit.to, edit.text)
    : withButton(current, line);
  if (updated === current) throw new UpstreamError('That edit changes nothing.');
  const checked = verifyEdit(current, updated, line);

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
  // Created, or reset to the base it should be on. The second is what makes a second call a
  // REVISION: the branch goes back to upstream's current head and the write below replaces the
  // commit, so an offer that landed in the wrong place is corrected in the pull request that is
  // already open rather than by closing it and sending them another.
  try {
    await call('POST', `/repos/${me}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch {
    await call('PATCH', `/repos/${me}/${repo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  }
  await call('PUT', `/repos/${me}/${repo}/contents/README.md`, {
    message: 'Add a Deploy on InstaCloud button',
    content: b64(updated),
    // The branch now sits exactly on baseSha, so their README at that commit is what is being
    // replaced, whatever an older attempt left here.
    sha: file.sha,
    branch,
  });

  let pr;
  try {
    pr = await call('POST', `/repos/${owner}/${repo}/pulls`, {
      title,
      body,
      head: `${me}:${branch}`,
      base,
      maintainer_can_modify: true,
    });
  } catch (error) {
    // GitHub refuses a second pull request from the same branch, which on a revision is the right
    // answer: the one that exists has just been updated by the push above.
    const open = await call('GET', `/repos/${owner}/${repo}/pulls?head=${me}:${branch}&state=open`);
    pr = Array.isArray(open) ? open[0] : null;
    if (!pr) throw error;
  }
  return {
    url: pr.html_url,
    number: pr.number,
    upstream: `${owner}/${repo}`,
    declared,
    fork: `${me}/${repo}`,
    branch,
    ...checked,
  };
}

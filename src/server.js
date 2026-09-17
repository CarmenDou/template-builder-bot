import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { handleMention, followJob } from './handler.js';
import { ensureLogin, listUnreportedJobs, markReported } from './agent.js';
import { postMessage, verifySlackSignature } from './slack.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEDUPE_TTL_MS = 60 * 60 * 1000;

const seenEvents = new Map();

function alreadyHandled(eventId) {
  const now = Date.now();
  for (const [id, at] of seenEvents) {
    if (now - at > DEDUPE_TTL_MS) seenEvents.delete(id);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

/**
 * Picks up jobs whose watcher died with a previous process. The agent keeps
 * running on the box when the bot restarts, so without this a job finishes with
 * nobody listening and the requester is left waiting forever.
 */
export async function resumeOrphanedJobs(config, deps = {}) {
  const {
    list = listUnreportedJobs,
    follow = followJob,
    post = postMessage,
    mark = markReported,
  } = deps;

  const orphans = await list(config).catch((error) => {
    log({ status: 'resume_scan_failed', error: error.message });
    return [];
  });

  for (const o of orphans) {
    if (!o?.jobId || !o?.channel) continue;
    log({ status: 'resuming', job: o.jobId, url: o.url });
    const say = (text) =>
      post({ token: config.slackBotToken, channel: o.channel, threadTs: o.threadTs, text });
    // Deliberately not awaited: one slow job must not hold up the others or the listener.
    follow({ config, job: { jobId: o.jobId, url: o.url }, say })
      .then((report) => say(report))
      .then(() => mark(config, o.jobId))
      .catch((error) => log({ status: 'resume_failed', job: o.jobId, error: error.message }));
  }
  return orphans.length;
}

export function createServer(config, deps = {}) {
  const { post = postMessage, mention = handleMention, follow = followJob, mark = markReported } = deps;

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/slack/events')) {
      res.writeHead(404).end();
      return;
    }

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }

    const signed = verifySlackSignature({
      signingSecret: config.slackSigningSecret,
      signature: req.headers['x-slack-signature'],
      timestamp: req.headers['x-slack-request-timestamp'],
      rawBody,
    });
    if (!signed) {
      log({ status: 'bad_signature' });
      res.writeHead(401).end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400).end();
      return;
    }

    log({
      status: 'received',
      type: payload.type,
      event_type: payload.event?.type,
      channel: payload.event?.channel,
      slack_user: payload.event?.user,
      retry: req.headers['x-slack-retry-num'] ?? undefined,
    });

    if (payload.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(payload.challenge);
      return;
    }

    // Slack gives us three seconds. A template job takes tens of minutes, so the
    // only correct thing to do here is acknowledge and work afterwards.
    res.writeHead(200).end();

    const event = payload.event;
    if (payload.type !== 'event_callback' || event?.type !== 'app_mention') return;

    // Slack retries on any slow ack; without this a retry starts a second agent
    // on the same repo and we get two PRs.
    if (payload.event_id && alreadyHandled(payload.event_id)) {
      log({ status: 'duplicate', event_id: payload.event_id });
      return;
    }

    const threadTs = event.thread_ts ?? event.ts;
    const say = (text) => post({ token: config.slackBotToken, channel: event.channel, threadTs, text });

    let job = null;
    try {
      const outcome = await mention({ event, config });
      job = outcome.job;
      if (outcome.reply) await say(outcome.reply);
    } catch (error) {
      log({ status: 'start_failed', error: error.message });
      await say(`I could not start that job: ${error.message}`).catch(() => {});
      return;
    }

    if (!job) return;
    log({ status: 'job_started', job: job.jobId, url: job.url });

    try {
      const report = await follow({ config, job, say });
      await say(report);
      await mark(config, job.jobId).catch(() => {});
      log({ status: 'job_reported', job: job.jobId });
    } catch (error) {
      log({ status: 'follow_failed', job: job.jobId, error: error.message });
      await say(
        `I lost track of job \`${job.jobId}\`: ${error.message}. It may still be running on the box.`,
      ).catch(() => {});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  // Log in once at boot. The container filesystem is not persistent, so this
  // has to happen on every start, not just the first.
  ensureLogin(config)
    .then(() => log({ status: 'insta_login_ok' }))
    .catch((error) => {
      log({ status: 'insta_login_failed', error: error.message });
      process.exit(1);
    })
    .then(() => resumeOrphanedJobs(config))
    .then((n) => {
      if (n) log({ status: 'resumed', jobs: n });
      createServer(config).listen(config.port, () => {
        log({
          status: 'listening',
          port: config.port,
          channels: config.allowedChannels.length,
          agent_project: config.agentProjectId,
          agent_service: config.agentService,
        });
      });
    });
}

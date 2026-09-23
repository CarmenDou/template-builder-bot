// Turning what the agent did into what a person would say about it.
//
// Every earlier attempt at this was string rules over shell commands, and it
// produced a log: `searching for healthz in packages/twenty-server/src`, twenty
// times, which says what was typed and not what is going on. There is a model
// on the other end of a key this process already holds, so ask it.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Small and fast: this runs once a minute for the length of a job, and the
// answer is one sentence. Opus would cost more and read no better.
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `You are watching an agent build a deployment template from a GitHub repository, and telling
one person, in Slack, what it is up to. You see the actions it has taken since you last spoke.

Answer with ONE sentence, under 25 words, in the present tense, saying what it is doing and, when the
actions make it clear, why. Name the thing it is working on. Do not list the commands, do not use
bullet points, do not open with "The agent" or "It looks like", and do not congratulate anyone.

If the new actions are only more of what you already described, or are too scattered to mean anything
yet, answer with exactly NOTHING. Repeating yourself is worse than staying quiet.`;

/**
 * One sentence about what has happened since the last one, or '' for nothing
 * worth saying. Never throws: a job that loses its narration still finishes,
 * and the raw trace is still there through read_job.
 */
export async function narrate(config, { repo, stages, activity, previous }, deps = {}) {
  const { fetchImpl = fetch } = deps;
  if (!config.anthropicApiKey || activity.length === 0) return '';

  const prompt = [
    `Repository: ${repo}`,
    stages.length > 0 ? `\nMilestones it has recorded:\n${stages.join('\n')}` : '',
    previous ? `\nWhat you said last time:\n${previous}` : '',
    `\nWhat it has done since:\n${activity.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await response.json();
    const said = (body?.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim();
    // The model was told to answer NOTHING rather than repeat itself.
    return /^nothing\.?$/i.test(said) ? '' : said;
  } catch {
    return '';
  }
}

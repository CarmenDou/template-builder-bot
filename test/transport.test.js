import test from 'node:test';
import assert from 'node:assert/strict';
import { boxCommand, execInBox } from '../src/agent.js';
import { loadConfig } from '../src/config.js';

const base = {
  INSTA_API_KEY: 'insta_x',
  AGENT_PROJECT_ID: 'P1',
  AGENT_SERVICE: 'claude-code',
  INSTA_BIN: '/bin/insta',
};

test('without a certificate the box is driven through the CLI', () => {
  const config = loadConfig(base, { needsSlack: false });
  const { file, args } = boxCommand(config, 'echo hi');
  assert.equal(file, '/bin/insta');
  assert.deepEqual(args, ['compute', 'exec', 'claude-code', '--', 'sh', '-c', 'echo hi']);
});

test('SSH_CONFIG switches the transport, and names the config file explicitly', () => {
  const config = loadConfig({ ...base, SSH_CONFIG: '/data/.hermes/.ssh/config' }, { needsSlack: false });
  const { file, args } = boxCommand(config, 'echo hi');
  assert.equal(file, 'ssh');
  assert.deepEqual(args, [
    '-F',
    '/data/.hermes/.ssh/config',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=25',
    'claude-code.insta',
    'echo hi',
  ]);
});

test('the alias follows the service name, and can be overridden', () => {
  const guessed = loadConfig({ ...base, AGENT_SERVICE: 'builder', SSH_CONFIG: '/c' }, { needsSlack: false });
  assert.equal(boxCommand(guessed, 'x').args.at(-2), 'builder.insta');

  const named = loadConfig({ ...base, SSH_CONFIG: '/c', SSH_ALIAS: 'somewhere.else' }, { needsSlack: false });
  assert.equal(boxCommand(named, 'x').args.at(-2), 'somewhere.else');
});

test('a script goes over ssh whole, because argv is no longer the limit', () => {
  const config = loadConfig({ ...base, SSH_CONFIG: '/c' }, { needsSlack: false });
  const script = ['set -e', 'mkdir -p /data/work/jobs/J1', "printf '%s' 'x' > /data/work/jobs/J1/task.txt"].join('\n');
  const { args } = boxCommand(config, script);
  assert.equal(args.at(-1), script, 'not chunked, not re-encoded');
});

test('ssh never inherits the project override, which is a CLI notion', () => {
  const config = loadConfig({ ...base, SSH_CONFIG: '/c' }, { needsSlack: false });
  assert.equal(boxCommand(config, 'x').env.INSTA_PROJECT_ID, undefined);
  const viaCli = loadConfig(base, { needsSlack: false });
  assert.equal(boxCommand(viaCli, 'x').env.INSTA_PROJECT_ID, 'P1');
});

test('an ssh failure renews the certificate and tries once more', async () => {
  const config = loadConfig({ ...base, SSH_CONFIG: '/c' }, { needsSlack: false });
  let attempts = 0;
  let renewals = 0;
  const run = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Permission denied (publickey)');
    return { stdout: 'ok', stderr: '' };
  };
  const out = await execInBox(config, 'uname -n', {}, { run, renew: async () => void (renewals += 1) });
  assert.equal(out.stdout, 'ok');
  assert.equal(attempts, 2, 'exactly one retry');
  assert.equal(renewals, 1);
});

test('when renewal itself fails the caller sees the ssh error, not the renewal one', async () => {
  const config = loadConfig({ ...base, SSH_CONFIG: '/c' }, { needsSlack: false });
  const run = async () => {
    throw new Error('Permission denied (publickey)');
  };
  const renew = async () => {
    throw new Error('not logged in');
  };
  await assert.rejects(() => execInBox(config, 'x', {}, { run, renew }), /publickey/);
});

test('the CLI transport never retries, because there is no certificate to renew', async () => {
  const config = loadConfig(base, { needsSlack: false });
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    throw new Error('502');
  };
  await assert.rejects(() => execInBox(config, 'x', {}, { run, renew: async () => assert.fail('must not renew') }));
  assert.equal(attempts, 1);
});

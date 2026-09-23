import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ensureLogin } from './agent.js';
import { handleRpc } from './mcp.js';

// Diagnostics go to stderr, never stdout: stdout is the JSON-RPC channel and
// one stray log line there corrupts it for whatever spawned this process.
function log(fields) {
  console.error(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

/**
 * The stdio transport for the same handleRpc the HTTP transport used: one
 * JSON-RPC message per line in, one line out. Exported so tests can drive it
 * with plain streams instead of a real child process.
 */
export function serve(config, input, output, deps = {}) {
  const rl = createInterface({ input, terminal: false });
  const pending = [];

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that never parsed has no id to echo, so this is the one reply
      // that bypasses handleRpc's own id handling.
      output.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
      );
      return;
    }

    const p = handleRpc(config, message, deps)
      .then((reply) => {
        if (reply) output.write(JSON.stringify(reply) + '\n');
      })
      .catch((error) => log({ status: 'rpc_failed', error: error.message }));
    pending.push(p);
  });

  return new Promise((resolve) => rl.on('close', () => Promise.all(pending).then(resolve)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(process.env, { needsSlack: false });
  // Same login server.js does at boot: the container filesystem is not
  // persistent, so this has to happen on every start, not just the first.
  ensureLogin(config)
    .then(() => log({ status: 'insta_login_ok' }))
    .catch((error) => {
      log({ status: 'insta_login_failed', error: error.message });
      process.exit(1);
    })
    .then(() => serve(config, process.stdin, process.stdout));
}

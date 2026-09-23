import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { serve } from '../src/mcp-stdio.js';

const config = { agentService: 'claude-code' };

const lines = (...ls) => Readable.from(ls.map((l) => l + '\n'));
const sink = () => {
  const written = [];
  return { write: (chunk) => written.push(chunk), written };
};

test('a full tools/call message round-trips through the line protocol', async () => {
  const input = lines('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_running_jobs","arguments":{}}}');
  const output = sink();
  await serve(config, input, output, { running: async () => [] });
  assert.equal(output.written.length, 1, 'one request in must produce one line out');
  assert.deepEqual(JSON.parse(output.written[0]), {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'Nothing is running.' }] },
  });
});

test('a notification produces no output line at all', async () => {
  const input = lines('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  const output = sink();
  await serve(config, input, output, {});
  assert.deepEqual(output.written, [], 'a body here would be a protocol error, same as the HTTP transport');
});

test('malformed JSON on a line is answered with a parse error, not a crash', async () => {
  const input = lines('{not json', '{"jsonrpc":"2.0","id":2,"method":"ping"}');
  const output = sink();
  await serve(config, input, output, {});
  assert.equal(output.written.length, 2, 'the bad line must not take the rest of the stream down with it');
  assert.deepEqual(JSON.parse(output.written[0]), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  });
  assert.deepEqual(JSON.parse(output.written[1]), { jsonrpc: '2.0', id: 2, result: {} });
});

test('every write to the output stream is exactly one JSON-RPC line, even on failure paths', async () => {
  // Diagnostics for a thrown tool, a bad line, and a dropped notification all
  // have somewhere to go that is not this stream (see log(), which uses
  // stderr). This exercises all three at once and checks what actually
  // reached the protocol channel: only well-formed replies, one per write.
  const input = lines(
    '{not json',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_running_jobs","arguments":{}}}',
  );
  const output = sink();
  await serve(config, input, output, {
    running: async () => {
      throw new Error('the box is unreachable');
    },
  });
  assert.equal(output.written.length, 2, 'the parse error and the tool failure; nothing for the notification');
  for (const chunk of output.written) {
    assert.equal((chunk.match(/\n/g) ?? []).length, 1, 'exactly one newline: one message, one line');
    assert.doesNotThrow(() => JSON.parse(chunk), 'every write is valid JSON-RPC and nothing else');
  }
});

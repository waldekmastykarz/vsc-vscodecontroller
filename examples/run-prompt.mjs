// Example flow that runs a prompt in Copilot Chat using the controller socket.
//
// Usage (reads VSCODE_CONTROLLER_PORT and VSCODE_CONTROLLER_TOKEN):
//   node examples/run-prompt.mjs "<prompt>" [--harness <type>] [--model "<model name>"] [--model-id <id>] [--model-vendor <vendor>] [--mode <agent>] [--timeout <ms>]
//
// Use --model-id when several models share a display name. Without --model-vendor, the
// extension derives the vendor from the harness.
import { parseArgs } from 'node:util';
import { connect } from './client.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: 'string' },
    model: { type: 'string' },
    'model-id': { type: 'string' },
    'model-vendor': { type: 'string' },
    mode: { type: 'string' },
    timeout: { type: 'string', default: String(30 * 60_000) },
  },
});
const prompt = positionals[0];
if (!prompt) {
  console.error('Usage: node examples/run-prompt.mjs "<prompt>" [--harness <type>] [--model "<name>"] [--model-id <id>] [--model-vendor <vendor>] [--mode <agent>] [--timeout <ms>]');
  process.exit(2);
}
const timeoutMs = Number(values.timeout);
const log = (message, details) => console.error(`[${new Date().toISOString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ''}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Connecting succeeds once VS Code has finished starting up.
const client = await connect({
  port: Number(process.env.VSCODE_CONTROLLER_PORT),
  token: process.env.VSCODE_CONTROLLER_TOKEN,
  timeoutMs: 120_000,
});
log('Connected', await client.call('getStatus'));

try {
  await client.call('chat.open');
  log('New chat', await client.call('chat.newChat', values.harness ? { harness: values.harness } : undefined));

  const modelSelector = Object.fromEntries(
    Object.entries({ name: values.model, id: values['model-id'], vendor: values['model-vendor'] }).filter(([, value]) => value !== undefined),
  );
  if (modelSelector.name || modelSelector.id) {
    // Models load asynchronously after startup, so retry.
    for (let attempt = 1; ; attempt++) {
      try {
        log('Model selected', await client.call('chat.selectModel', modelSelector));
        break;
      } catch (error) {
        const notLoaded = /^No language model(s found matching| named)/.test(error.message);
        if (attempt >= 10 || !notLoaded) throw error;
        log(`Model not available yet (attempt ${attempt}/10)`, { error: error.message });
        await sleep(2_000);
      }
    }
  }
  if (values.mode) await client.call('chat.setMode', { mode: values.mode });

  // Send and wait. Cancel on timeout; the socket handles requests concurrently.
  log('Sending prompt');
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      await client.call('chat.cancel').catch(() => undefined);
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const result = await Promise.race([client.call('chat.sendPrompt', { prompt }), timedOut]).finally(() => clearTimeout(timer));
  log('Response finished', result);

  if (result?.type === 'confirmation') {
    log('The response is waiting for a confirmation. Enable auto-approval settings to avoid this.', result);
  }

  await client.call('notifications.clearAll');
  await client.call('chat.keepAllEdits');
  log('Done');
} finally {
  client.close();
}

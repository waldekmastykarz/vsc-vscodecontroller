// Minimal zero-dependency client for the VS Code Controller extension.
//
// Library use:
//   import { connect } from './client.mjs';
//   const client = await connect({ port, token });
//   await client.call('chat.open');
//
// CLI use (reads VSCODE_CONTROLLER_PORT and VSCODE_CONTROLLER_TOKEN):
//   node examples/client.mjs <method> ['{"json":"params"}']
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export class ControllerClient {
  #socket;
  #buffer = '';
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => {
      for (const { reject } of this.#pending.values()) reject(new Error('Connection closed'));
      this.#pending.clear();
    });
  }

  call(method, params) {
    const id = this.#nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  close() {
    this.#socket.end();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      for (const response of [JSON.parse(line)].flat()) {
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        if (response.error) {
          const error = new Error(response.error.message);
          error.code = response.error.code;
          error.data = response.error.data;
          pending.reject(error);
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }
}

/**
 * Connects and authenticates. Retries until `timeoutMs` elapses because the
 * extension only opens the socket once VS Code has finished starting up.
 */
export async function connect({ port, token, host = '127.0.0.1', timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, host, () => resolve(s));
        s.once('error', reject);
      });
      const client = new ControllerClient(socket);
      await client.call('authenticate', { token });
      return client;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [method, paramsText] = process.argv.slice(2);
  if (!method) {
    console.error('Usage: node examples/client.mjs <method> [jsonParams]');
    process.exit(2);
  }
  let client;
  try {
    client = await connect({
      port: Number(process.env.VSCODE_CONTROLLER_PORT),
      token: process.env.VSCODE_CONTROLLER_TOKEN,
    });
    const result = await client.call(method, paramsText ? JSON.parse(paramsText) : undefined);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error ${error.code}: ${error.message}`);
    if (error.data !== undefined) console.error(JSON.stringify(error.data, null, 2));
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

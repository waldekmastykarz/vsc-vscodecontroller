import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ControllerServer, ErrorCodes, RpcError } from '../server';

const TOKEN = 'secret-token';

class Client {
  private buffer = '';
  private readonly lines: unknown[] = [];
  private waiters: ((value: unknown) => void)[] = [];
  closed = false;

  private constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = JSON.parse(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
    socket.on('close', () => (this.closed = true));
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => resolve(new Client(socket)));
      socket.once('error', reject);
    });
  }

  sendRaw(text: string): void {
    this.socket.write(text);
  }

  send(message: unknown): void {
    this.sendRaw(`${JSON.stringify(message)}\n`);
  }

  next(): Promise<any> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async request(method: string, params?: unknown, id: string | number = Math.random()): Promise<any> {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.next();
  }

  async authenticate(): Promise<void> {
    const response = await this.request('authenticate', { token: TOKEN });
    assert.deepEqual(response.result, { authenticated: true });
  }

  close(): void {
    this.socket.destroy();
  }
}

describe('ControllerServer', () => {
  let server: ControllerServer;
  let port: number;
  let releaseSlow: () => void = () => undefined;
  const notified: unknown[] = [];

  before(async () => {
    server = new ControllerServer({
      port: 0,
      token: TOKEN,
      maxMessageBytes: 1024,
      handlers: {
        echo: (params) => params,
        nothing: () => undefined,
        fail: () => {
          throw new Error('boom');
        },
        invalid: () => {
          throw new RpcError(ErrorCodes.InvalidParams, 'bad params', { field: 'x' });
        },
        slow: () => new Promise((resolve) => (releaseSlow = () => resolve('slow done'))),
        notify: (params) => {
          notified.push(params);
        },
      },
    });
    port = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it('rejects calls before authentication', async () => {
    const client = await Client.connect(port);
    const response = await client.request('echo', { a: 1 }, 1);
    assert.equal(response.id, 1);
    assert.equal(response.error.code, ErrorCodes.Unauthorized);
    client.close();
  });

  it('closes the connection after an invalid token', async () => {
    const client = await Client.connect(port);
    const response = await client.request('authenticate', { token: 'wrong' }, 1);
    assert.equal(response.error.code, ErrorCodes.Unauthorized);
    await new Promise((resolve) => client.socket.once('close', resolve));
    assert.equal(client.closed, true);
  });

  it('dispatches requests after authentication', async () => {
    const client = await Client.connect(port);
    await client.authenticate();
    const response = await client.request('echo', { a: 1 }, 'abc');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 'abc', result: { a: 1 } });
    client.close();
  });

  it('returns null for handlers without a result', async () => {
    const client = await Client.connect(port);
    await client.authenticate();
    const response = await client.request('nothing', undefined, 2);
    assert.deepEqual(response, { jsonrpc: '2.0', id: 2, result: null });
    client.close();
  });

  it('maps handler errors to JSON-RPC errors', async () => {
    const client = await Client.connect(port);
    await client.authenticate();
    const failed = await client.request('fail', undefined, 1);
    assert.deepEqual(failed.error, { code: ErrorCodes.CommandFailed, message: 'boom' });
    const invalid = await client.request('invalid', undefined, 2);
    assert.deepEqual(invalid.error, { code: ErrorCodes.InvalidParams, message: 'bad params', data: { field: 'x' } });
    const missing = await client.request('missing', undefined, 3);
    assert.equal(missing.error.code, ErrorCodes.MethodNotFound);
    client.close();
  });

  it('reports parse errors and invalid requests', async () => {
    const client = await Client.connect(port);
    client.sendRaw('{not json}\n');
    assert.equal((await client.next()).error.code, ErrorCodes.ParseError);
    client.send({ id: 1, method: 'echo' });
    assert.equal((await client.next()).error.code, ErrorCodes.InvalidRequest);
    client.send({ jsonrpc: '2.0', id: 2, method: 'echo', params: 'text' });
    assert.equal((await client.next()).error.code, ErrorCodes.InvalidRequest);
    client.send([]);
    assert.equal((await client.next()).error.code, ErrorCodes.InvalidRequest);
    client.close();
  });

  it('handles messages split across chunks and multiple messages per chunk', async () => {
    const client = await Client.connect(port);
    const auth = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'authenticate', params: { token: TOKEN } });
    client.sendRaw(auth.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.sendRaw(`${auth.slice(10)}\r\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: [1] })}\n`);
    assert.equal((await client.next()).id, 1);
    assert.deepEqual((await client.next()).result, [1]);
    client.close();
  });

  it('runs batches in order and skips notifications', async () => {
    const client = await Client.connect(port);
    client.send([
      { jsonrpc: '2.0', id: 1, method: 'authenticate', params: { token: TOKEN } },
      { jsonrpc: '2.0', method: 'notify', params: { n: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'echo', params: { b: 2 } },
    ]);
    const responses = await client.next();
    assert.deepEqual(responses.map((r: { id: number }) => r.id), [1, 2]);
    assert.deepEqual(responses[1].result, { b: 2 });
    assert.deepEqual(notified, [{ n: 1 }]);
    client.close();
  });

  it('processes requests concurrently so long calls do not block others', async () => {
    const client = await Client.connect(port);
    await client.authenticate();
    client.send({ jsonrpc: '2.0', id: 'slow', method: 'slow' });
    const quick = await client.request('echo', { quick: true }, 'quick');
    assert.equal(quick.id, 'quick');
    releaseSlow();
    const slow = await client.next();
    assert.deepEqual(slow, { jsonrpc: '2.0', id: 'slow', result: 'slow done' });
    client.close();
  });

  it('closes connections that send oversized messages', async () => {
    const client = await Client.connect(port);
    client.sendRaw('x'.repeat(2048));
    assert.equal((await client.next()).error.code, ErrorCodes.InvalidRequest);
    await new Promise((resolve) => client.socket.once('close', resolve));
  });

  it('fails to start when the port is in use', async () => {
    const other = new ControllerServer({ port, token: TOKEN, handlers: {} });
    await assert.rejects(other.start(), /EADDRINUSE/);
  });
});

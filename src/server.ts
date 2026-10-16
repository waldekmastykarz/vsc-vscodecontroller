import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  CommandFailed: -32000,
  Unauthorized: -32001,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type Handler = (params: unknown) => unknown;

type RequestId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Connection {
  socket: net.Socket;
  authenticated: boolean;
}

export interface ControllerServerOptions {
  port: number;
  host?: string;
  token: string;
  handlers: Record<string, Handler>;
  log?: (message: string) => void;
  maxMessageBytes?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const AUTHENTICATE_METHOD = 'authenticate';

export class ControllerServer {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly tokenHash: Buffer;

  constructor(private readonly options: ControllerServerOptions) {
    if (!options.token) throw new Error('A token is required');
    this.tokenHash = hash(options.token);
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once('error', reject);
      server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (error) => this.log(`Server error: ${error.message}`));
        this.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    const connection: Connection = { socket, authenticated: false };
    const maxBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    let buffer = '';
    this.sockets.add(socket);
    this.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void this.processLine(connection, line);
      }
      if (Buffer.byteLength(buffer) > maxBytes) {
        this.send(connection, errorResponse(null, ErrorCodes.InvalidRequest, `Message exceeds ${maxBytes} bytes`));
        socket.end();
        buffer = '';
      }
    });
    socket.on('error', (error) => this.log(`Socket error: ${error.message}`));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.log('Client disconnected');
    });
  }

  private async processLine(connection: Connection, line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send(connection, errorResponse(null, ErrorCodes.ParseError, 'Parse error'));
      return;
    }

    if (Array.isArray(message)) {
      if (message.length === 0) {
        this.send(connection, errorResponse(null, ErrorCodes.InvalidRequest, 'Invalid Request: empty batch'));
        return;
      }
      // Batch items run in order so that an `authenticate` call can precede other calls in the same batch.
      const responses: JsonRpcResponse[] = [];
      for (const item of message) {
        const response = await this.processMessage(connection, item);
        if (response) responses.push(response);
      }
      if (responses.length) this.send(connection, responses);
      return;
    }

    const response = await this.processMessage(connection, message);
    if (response) this.send(connection, response);
  }

  private async processMessage(connection: Connection, message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return errorResponse(getId(message), ErrorCodes.InvalidRequest, 'Invalid Request');
    }
    const isNotification = !('id' in message);
    const id = getId(message);
    if (!isNotification && id === undefined) {
      return errorResponse(null, ErrorCodes.InvalidRequest, 'Invalid Request: id must be a string, number or null');
    }
    if (message.params !== undefined && !isObject(message.params) && !Array.isArray(message.params)) {
      return isNotification ? undefined : errorResponse(id, ErrorCodes.InvalidRequest, 'Invalid Request: params must be an object or array');
    }

    const method = message.method;
    try {
      const result = await this.dispatch(connection, method, message.params);
      return isNotification ? undefined : { jsonrpc: '2.0', id: id ?? null, result: result ?? null };
    } catch (error) {
      if (connection.authenticated || method === AUTHENTICATE_METHOD) {
        this.log(`${method} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (isNotification) return undefined;
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message, error.data);
      const messageText = error instanceof Error ? error.message : String(error);
      return errorResponse(id, ErrorCodes.CommandFailed, messageText);
    }
  }

  private async dispatch(connection: Connection, method: string, params: unknown): Promise<unknown> {
    if (method === AUTHENTICATE_METHOD) return this.authenticate(connection, params);
    if (!connection.authenticated) {
      throw new RpcError(ErrorCodes.Unauthorized, `Unauthorized: call '${AUTHENTICATE_METHOD}' first`);
    }
    const handler = Object.hasOwn(this.options.handlers, method) ? this.options.handlers[method] : undefined;
    if (!handler) throw new RpcError(ErrorCodes.MethodNotFound, `Method not found: ${method}`);
    return handler(params);
  }

  private authenticate(connection: Connection, params: unknown): { authenticated: true } {
    const token = isObject(params) ? params.token : undefined;
    if (typeof token !== 'string' || !timingSafeEqual(hash(token), this.tokenHash)) {
      // Drop the connection so the token can't be brute-forced over a single socket.
      setImmediate(() => connection.socket.end());
      throw new RpcError(ErrorCodes.Unauthorized, 'Unauthorized: invalid token');
    }
    connection.authenticated = true;
    return { authenticated: true };
  }

  private send(connection: Connection, payload: JsonRpcResponse | JsonRpcResponse[]): void {
    const { socket } = connection;
    if (socket.destroyed || !socket.writable) return;
    let text: string;
    try {
      text = JSON.stringify(payload);
    } catch (error) {
      const id = Array.isArray(payload) ? null : payload.id;
      text = JSON.stringify(errorResponse(id, ErrorCodes.InternalError, `Failed to serialize response: ${String(error)}`));
    }
    socket.write(`${text}\n`);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function errorResponse(id: RequestId | undefined, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

function getId(message: unknown): RequestId | undefined {
  if (!isObject(message)) return null;
  const id = message.id;
  if (id === null || typeof id === 'string' || typeof id === 'number') return id;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

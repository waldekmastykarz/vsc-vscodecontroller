import { ErrorCodes, RpcError } from './server';

export type Params = Record<string, unknown>;

export function asParams(params: unknown): Params {
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcError(ErrorCodes.InvalidParams, 'Invalid params: expected an object with named parameters');
  }
  return params as Params;
}

export function requireString(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params: '${name}' must be a non-empty string`);
  }
  return value;
}

export function optionalString(params: Params, name: string): string | undefined {
  if (params[name] === undefined) return undefined;
  return requireString(params, name);
}

export function optionalBoolean(params: Params, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params: '${name}' must be a boolean`);
  }
  return value;
}

export function optionalArray(params: Params, name: string): unknown[] | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params: '${name}' must be an array`);
  }
  return value;
}

export function optionalPositiveInteger(params: Params, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params: '${name}' must be a positive integer`);
  }
  return value;
}

/** Rejects with a `CommandFailed` error when `promise` doesn't settle within `timeoutMs`. */
export async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcError(ErrorCodes.CommandFailed, message, { timeoutMs })), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function rejectUnknown(params: Params, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params: unknown parameter(s) ${unknown.map((k) => `'${k}'`).join(', ')}`);
  }
}

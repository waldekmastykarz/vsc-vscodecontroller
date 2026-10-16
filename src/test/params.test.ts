import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { optionalPositiveInteger, withTimeout } from '../params';
import { ErrorCodes, RpcError } from '../server';

describe('withTimeout', () => {
  it('returns the result when the promise settles in time', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 100, 'late'), 42);
  });

  it('propagates the promise rejection', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100, 'late'), /boom/);
  });

  it('fails with a CommandFailed error after the timeout', async () => {
    await assert.rejects(withTimeout(new Promise(() => undefined), 20, 'too slow'), (error: unknown) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, ErrorCodes.CommandFailed);
      assert.equal(error.message, 'too slow');
      assert.deepEqual(error.data, { timeoutMs: 20 });
      return true;
    });
  });
});

describe('optionalPositiveInteger', () => {
  it('accepts positive integers and undefined', () => {
    assert.equal(optionalPositiveInteger({ t: 5 }, 't'), 5);
    assert.equal(optionalPositiveInteger({}, 't'), undefined);
  });

  it('rejects other values', () => {
    for (const value of [0, -1, 1.5, '5', Number.POSITIVE_INFINITY, null]) {
      assert.throws(() => optionalPositiveInteger({ t: value }, 't'), (error: unknown) => error instanceof RpcError && error.code === ErrorCodes.InvalidParams);
    }
  });
});

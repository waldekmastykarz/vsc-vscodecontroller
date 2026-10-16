import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readConfig, workspaceMatches } from '../config';

describe('readConfig', () => {
  it('is disabled without a port', () => {
    assert.deepEqual(readConfig({}), { status: 'disabled' });
  });

  it('rejects invalid ports', () => {
    for (const port of ['0', '65536', 'abc', '12.5', '-1']) {
      const result = readConfig({ VSCODE_CONTROLLER_PORT: port, VSCODE_CONTROLLER_TOKEN: 't' });
      assert.equal(result.status, 'invalid', port);
    }
  });

  it('requires a token', () => {
    const result = readConfig({ VSCODE_CONTROLLER_PORT: '7001' });
    assert.equal(result.status, 'invalid');
  });

  it('reads port, token and workspace', () => {
    const result = readConfig({
      VSCODE_CONTROLLER_PORT: '7001',
      VSCODE_CONTROLLER_TOKEN: 'abc',
      VSCODE_CONTROLLER_WORKSPACE: '/work',
    });
    assert.deepEqual(result, { status: 'ok', config: { port: 7001, token: 'abc', workspace: '/work' } });
  });
});

function makeTempDir(): string {
  const root = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'ws-'));
}

describe('workspaceMatches', () => {
  it('matches identical, trailing-slash and relative-segment paths', () => {
    const dir = makeTempDir();
    try {
      assert.equal(workspaceMatches(dir, [dir]), true);
      assert.equal(workspaceMatches(`${dir}${path.sep}`, [dir]), true);
      assert.equal(workspaceMatches(path.join(dir, 'sub', '..'), [dir]), true);
      assert.equal(workspaceMatches(dir, [os.homedir()]), false);
      assert.equal(workspaceMatches(dir, []), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves symlinks', () => {
    const dir = makeTempDir();
    try {
      const real = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link, 'junction');
      assert.equal(workspaceMatches(link, [real]), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compares case-insensitively only on Windows and macOS', () => {
    assert.equal(workspaceMatches('/Some/Missing/Path', ['/some/missing/path'], 'darwin'), true);
    assert.equal(workspaceMatches('/Some/Missing/Path', ['/some/missing/path'], 'win32'), true);
    assert.equal(workspaceMatches('/Some/Missing/Path', ['/some/missing/path'], 'linux'), false);
  });
});

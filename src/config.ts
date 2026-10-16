import fs from 'node:fs';
import path from 'node:path';

export const ENV_PORT = 'VSCODE_CONTROLLER_PORT';
export const ENV_TOKEN = 'VSCODE_CONTROLLER_TOKEN';
export const ENV_WORKSPACE = 'VSCODE_CONTROLLER_WORKSPACE';

export interface ControllerConfig {
  port: number;
  token: string;
  workspace?: string;
}

export type ConfigResult =
  | { status: 'disabled' }
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; config: ControllerConfig };

export function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const portText = env[ENV_PORT]?.trim();
  if (!portText) return { status: 'disabled' };

  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 'invalid', reason: `${ENV_PORT} must be an integer between 1 and 65535, got '${portText}'` };
  }
  const token = env[ENV_TOKEN];
  if (!token) {
    return { status: 'invalid', reason: `${ENV_TOKEN} must be set when ${ENV_PORT} is set` };
  }
  const workspace = env[ENV_WORKSPACE]?.trim() || undefined;
  return { status: 'ok', config: { port, token, workspace } };
}

/**
 * Returns true when `expected` points to the same location as one of the window's
 * workspace folders or its `.code-workspace` file.
 */
export function workspaceMatches(
  expected: string,
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const target = normalizePath(expected, platform);
  return candidates.some((candidate) => normalizePath(candidate, platform) === target);
}

function normalizePath(value: string, platform: NodeJS.Platform): string {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path doesn't exist; compare the resolved path as-is.
  }
  if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/, '');
  // Default file systems on Windows and macOS are case-insensitive.
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

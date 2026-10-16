import * as vscode from 'vscode';
import { ENV_PORT, ENV_WORKSPACE, readConfig, workspaceMatches } from './config';
import { createHandlers } from './methods';
import { ControllerServer } from './server';

let server: ControllerServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('VS Code Controller', { log: true });
  context.subscriptions.push(log);

  const result = readConfig(process.env);
  if (result.status === 'disabled') {
    log.info(`${ENV_PORT} is not set; the controller socket is disabled`);
    return;
  }
  if (result.status === 'invalid') {
    log.error(`Controller socket not started: ${result.reason}`);
    return;
  }

  const { config } = result;
  if (config.workspace) {
    const candidates = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile?.scheme === 'file') candidates.push(workspaceFile.fsPath);
    if (!workspaceMatches(config.workspace, candidates)) {
      log.info(`This window's workspace doesn't match ${ENV_WORKSPACE} (${config.workspace}); the controller socket is disabled`);
      return;
    }
  }

  server = new ControllerServer({
    port: config.port,
    token: config.token,
    handlers: createHandlers(context.globalStorageUri),
    log: (message) => log.info(message),
  });
  try {
    const port = await server.start();
    log.info(`Controller listening on 127.0.0.1:${port}`);
  } catch (error) {
    server = undefined;
    log.error(`Failed to start the controller socket on port ${config.port}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  context.subscriptions.push({ dispose: () => void server?.stop() });
}

export async function deactivate(): Promise<void> {
  await server?.stop();
  server = undefined;
}

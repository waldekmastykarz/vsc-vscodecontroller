import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { findHarnessMismatch, findModelMismatch, LOCAL_HARNESS, type ExpectedModel } from './requestVerification';
import { asParams, optionalArray, optionalBoolean, optionalPositiveInteger, optionalString, rejectUnknown, requireString, withTimeout } from './params';
import { ErrorCodes, RpcError, type Handler } from './server';

const COPILOT_CHAT_EXTENSION_ID = 'GitHub.copilot-chat';
const LOCAL_MODEL_VENDOR = 'copilot';
const AGENT_HOST_COPILOT_HARNESS = 'agent-host-copilotcli';
const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const Commands = {
  openChat: 'workbench.action.chat.open',
  newChat: 'workbench.action.chat.newChat',
  newChatSessionOfTypePrefix: 'workbench.action.chat.openNewChatSessionInPlace.',
  exportChat: 'workbench.action.chat.export',
  cancelChat: 'workbench.action.chat.cancel',
  acceptTool: 'workbench.action.chat.acceptTool',
  keepAllEdits: 'chatEditing.acceptAllFiles',
  startMcpServer: 'workbench.mcp.startServer',
  restartMcpServer: 'workbench.mcp.restartServer',
  killTerminal: 'workbench.action.terminal.kill',
  clearNotifications: 'notifications.clearAll',
} as const;

interface ModelSelector {
  id?: string;
  vendor?: string;
  family?: string;
  version?: string;
}

export function createHandlers(storageUri: vscode.Uri): Record<string, Handler> {
  // The harness set by the last `chat.newChat` call, used to pick the model vendor and verified after each prompt.
  let currentHarness: string | undefined;
  // The model set by the last `chat.selectModel` call, verified after each prompt.
  let expectedModel: ExpectedModel | undefined;

  return {
    // Reports readiness. The server only starts after VS Code finishes starting up.
    getStatus: (params) => {
      rejectUnknown(asParams(params), []);
      const copilotChat = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID);
      return {
        ready: true,
        appName: vscode.env.appName,
        vscodeVersion: vscode.version,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : null,
        copilotChat: {
          installed: Boolean(copilotChat),
          active: copilotChat?.isActive ?? false,
          version: (copilotChat?.packageJSON as { version?: string } | undefined)?.version ?? null,
        },
      };
    },

    executeCommand: async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['command', 'args']);
      const command = requireString(p, 'command');
      const args = optionalArray(p, 'args') ?? [];
      return vscode.commands.executeCommand(command, ...args);
    },

    getSetting: (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['key']);
      const key = requireString(p, 'key');
      const inspected = vscode.workspace.getConfiguration().inspect(key);
      return {
        key,
        value: vscode.workspace.getConfiguration().get(key) ?? null,
        defaultValue: inspected?.defaultValue ?? null,
        globalValue: inspected?.globalValue ?? null,
        workspaceValue: inspected?.workspaceValue ?? null,
      };
    },

    // Writes to workspace settings. Omit `value` to remove the setting.
    setSetting: async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['key', 'value']);
      const key = requireString(p, 'key');
      if (!vscode.workspace.workspaceFolders?.length) {
        throw new RpcError(ErrorCodes.CommandFailed, 'Cannot update workspace settings because no workspace is open');
      }
      await vscode.workspace.getConfiguration().update(key, p.value, vscode.ConfigurationTarget.Workspace);
      return { key, workspaceValue: vscode.workspace.getConfiguration().inspect(key)?.workspaceValue ?? null };
    },

    'chat.open': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.openChat);
    },

    // `serverId` defaults to '*', which starts all servers. Fails after `timeoutMs` because a
    // server that never answers `initialize` blocks the command forever; VS Code keeps starting it.
    'mcp.startServer': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['serverId', 'waitForLiveTools', 'timeoutMs']);
      const serverId = optionalString(p, 'serverId') ?? '*';
      const waitForLiveTools = optionalBoolean(p, 'waitForLiveTools') ?? false;
      const timeoutMs = optionalPositiveInteger(p, 'timeoutMs') ?? DEFAULT_MCP_TIMEOUT_MS;
      await withTimeout(
        vscode.commands.executeCommand(Commands.startMcpServer, serverId, { waitForLiveTools }),
        timeoutMs,
        `MCP server '${serverId}' didn't start within ${timeoutMs} ms. VS Code keeps starting it in the background.`,
      );
    },

    'mcp.restartServer': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['serverId', 'timeoutMs']);
      const serverId = requireString(p, 'serverId');
      const timeoutMs = optionalPositiveInteger(p, 'timeoutMs') ?? DEFAULT_MCP_TIMEOUT_MS;
      await withTimeout(
        vscode.commands.executeCommand(Commands.restartMcpServer, serverId),
        timeoutMs,
        `MCP server '${serverId}' didn't restart within ${timeoutMs} ms. VS Code keeps starting it in the background.`,
      );
    },

    // Without `harness`, VS Code picks the session type (it may reuse the current or last-used one).
    // With `harness` (a chat session type such as `local` or `agent-host-copilotcli`), the type is explicit.
    'chat.newChat': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['harness']);
      const harness = optionalString(p, 'harness');
      if (!harness) {
        await vscode.commands.executeCommand(Commands.newChat);
        currentHarness = undefined;
        return { harness: null };
      }
      const command = `${Commands.newChatSessionOfTypePrefix}${harness}`;
      if (!(await vscode.commands.getCommands(true)).includes(command)) {
        throw new RpcError(ErrorCodes.InvalidParams, `Unknown or unavailable harness '${harness}'`, {
          available: await getAvailableHarnesses(),
        });
      }
      await vscode.commands.executeCommand(command, 'sidebar');
      currentHarness = harness;
      return { harness };
    },

    // Lists the models that `chat.selectModel` can select.
    'chat.listModels': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['id', 'vendor', 'family', 'version']);
      const models = await vscode.lm.selectChatModels(readSelector(p));
      return models.map((model) => ({
        id: model.id,
        vendor: model.vendor,
        family: model.family,
        version: model.version,
        name: model.name,
        maxInputTokens: model.maxInputTokens,
      }));
    },

    // Select by display `name` (as shown in the model picker) or by selector fields.
    // Each harness only accepts models from its own vendor and silently ignores others, so
    // when `vendor` is omitted it's derived from the harness of the current chat.
    'chat.selectModel': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['name', 'id', 'vendor', 'family', 'version']);
      const name = optionalString(p, 'name');
      const selector = readSelector(p);
      if (!name && Object.keys(selector).length === 0) {
        throw new RpcError(ErrorCodes.InvalidParams, "Invalid params: specify 'name' or at least one of 'id', 'vendor', 'family', 'version'");
      }
      const vendor = selector.vendor ?? (await vendorForHarness(currentHarness));

      if (name) {
        // Agent host vendors aren't exposed through `vscode.lm`, but model names and IDs are
        // the same across vendors, so resolve the name to an ID using any vendor.
        const filters = { ...selector };
        delete filters.vendor;
        const matches = (await vscode.lm.selectChatModels(filters)).filter((model) => model.name === name);
        if (matches.length === 0) {
          throw new RpcError(ErrorCodes.CommandFailed, `No language model named '${name}' is available. The model list may still be loading.`);
        }
        let ids = [...new Set(matches.map((model) => model.id))];
        if (ids.length > 1) {
          ids = [...new Set(matches.filter((model) => model.vendor === vendor).map((model) => model.id))];
        }
        if (ids.length !== 1) {
          throw new RpcError(ErrorCodes.CommandFailed, `Multiple language models are named '${name}'. Add 'id' to disambiguate.`, {
            matches: matches.map((model) => ({ id: model.id, vendor: model.vendor, family: model.family })),
          });
        }
        selector.id = ids[0];
      }
      selector.vendor = vendor;
      // `chat.open` throws when nothing matches the selector, unlike `workbench.action.chat.changeModel`.
      await vscode.commands.executeCommand(Commands.openChat, { modelSelector: selector });
      if (selector.id) {
        expectedModel = { vendor, id: selector.id, name: name ?? (await vscode.lm.selectChatModels({ id: selector.id }))[0]?.name };
      } else {
        // Without an ID, the selector can match several models, so there's nothing exact to verify.
        expectedModel = undefined;
      }
      return { selector, harness: currentHarness ?? null };
    },

    // Accepts a built-in mode (`agent`, `ask`, `edit`) or a custom agent name/ID.
    'chat.setMode': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['mode']);
      // `workbench.action.chat.toggleAgentMode` falls back to the *next* mode for unknown IDs, so use `chat.open` instead.
      await vscode.commands.executeCommand(Commands.openChat, { mode: requireString(p, 'mode') });
    },

    // With `waitForResponse` (default true), resolves when the response completes,
    // fails, or needs a confirmation, and returns the chat result including confirmation details.
    // Fails when the request didn't run in the harness from `chat.newChat` or with the model from `chat.selectModel`.
    'chat.sendPrompt': async (params) => {
      const p = asParams(params);
      rejectUnknown(p, ['prompt', 'waitForResponse']);
      const prompt = requireString(p, 'prompt');
      const waitForResponse = optionalBoolean(p, 'waitForResponse') ?? true;
      const result = await vscode.commands.executeCommand(Commands.openChat, { query: prompt, blockOnResponse: waitForResponse });
      if (waitForResponse && (currentHarness || expectedModel)) {
        await verifyRequest(storageUri, prompt, { harness: currentHarness, model: expectedModel }, result);
      }
      return result;
    },

    // Accepts the pending tool confirmation, both before (`toolInvocation`) and after (`toolPostApproval`) execution.
    'chat.acceptTool': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.acceptTool);
    },

    // Kills the active terminal.
    'terminal.kill': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.killTerminal);
    },

    'chat.cancel': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.cancelChat);
    },

    'notifications.clearAll': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.clearNotifications);
    },

    'chat.keepAllEdits': async (params) => {
      rejectUnknown(asParams(params), []);
      await vscode.commands.executeCommand(Commands.keepAllEdits);
    },
  };
}

/**
 * Returns the model vendor accepted by the agent that serves the given harness (session type).
 * Each agent ignores models from other vendors and silently falls back to its default model.
 * The session type of a default chat isn't observable. VS Code uses the Copilot harness when
 * Copilot managed settings require it or the `chat.*CopilotHarness` settings opt in, so assume
 * it whenever it's available. `chat.sendPrompt` reports a wrong guess.
 */
async function vendorForHarness(harness: string | undefined): Promise<string> {
  if (harness === LOCAL_HARNESS) return LOCAL_MODEL_VENDOR;
  if (harness !== undefined) return harness;
  const agentHostAvailable = (await getAvailableHarnesses()).includes(AGENT_HOST_COPILOT_HARNESS);
  return agentHostAvailable ? AGENT_HOST_COPILOT_HARNESS : LOCAL_MODEL_VENDOR;
}

async function getAvailableHarnesses(): Promise<string[]> {
  return (await vscode.commands.getCommands(true))
    .filter((command) => command.startsWith(Commands.newChatSessionOfTypePrefix))
    .map((command) => command.slice(Commands.newChatSessionOfTypePrefix.length))
    .sort();
}

interface ExpectedRequest {
  harness?: string;
  model?: ExpectedModel;
}

/**
 * Exports the current chat and fails when its last request, the one just sent, didn't run in
 * the expected harness or with the expected model. The export is the only place VS Code exposes this.
 */
async function verifyRequest(storageUri: vscode.Uri, prompt: string, expected: ExpectedRequest, result: unknown): Promise<void> {
  const request = await readLastRequest(storageUri);
  const requestText = typeof request?.message === 'string' ? request.message : request?.message?.text;
  if (!request || requestText !== prompt) {
    throw new RpcError(ErrorCodes.CommandFailed, "Couldn't find the request in the chat to confirm which harness and model served it", { result });
  }
  const served = {
    modelId: request.modelId,
    agentId: request.agent?.id,
    details: typeof request.result?.details === 'string' ? request.result.details : undefined,
  };
  const mismatch =
    (expected.harness && findHarnessMismatch(expected.harness, served.agentId, await getAvailableHarnesses())) ||
    (expected.model && findModelMismatch(expected.model, served));
  if (mismatch) {
    throw new RpcError(ErrorCodes.CommandFailed, mismatch, { expected, served, result });
  }
}

interface ExportedRequest {
  message?: string | { text?: string };
  modelId?: string;
  agent?: { id?: string };
  result?: { details?: unknown };
}

async function readLastRequest(storageUri: vscode.Uri): Promise<ExportedRequest | undefined> {
  await vscode.workspace.fs.createDirectory(storageUri);
  const file = vscode.Uri.joinPath(storageUri, `chat-export-${randomUUID()}.json`);
  try {
    await vscode.commands.executeCommand(Commands.exportChat, file);
    const data = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as { requests?: ExportedRequest[] };
    return data.requests?.at(-1);
  } catch (error) {
    throw new RpcError(ErrorCodes.CommandFailed, `Couldn't export the chat to confirm which model served the request: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await Promise.resolve(vscode.workspace.fs.delete(file)).catch(() => undefined);
  }
}

function readSelector(p: Record<string, unknown>): ModelSelector {
  const selector: ModelSelector = {};
  for (const key of ['id', 'vendor', 'family', 'version'] as const) {
    const value = optionalString(p, key);
    if (value !== undefined) selector[key] = value;
  }
  return selector;
}

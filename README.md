# VS Code Controller

A VS Code extension that opens a local TCP socket so you can remotely control VS Code and GitHub Copilot Chat. It speaks [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over newline-delimited JSON. Each method maps to a VS Code command, so clients don't depend on the workbench DOM the way UI automation does.

## Requirements

- Stable VS Code 1.140 or newer (verified on 1.142)
- GitHub Copilot Chat signed in, for the chat methods

## Build and install

```sh
npm install
npm run package                                  # builds vscode-controller-0.1.0.vsix
code --install-extension vscode-controller-0.1.0.vsix
```

To run from source without installing, launch VS Code with `--extensionDevelopmentPath=/path/to/this/folder`.

## Enable the socket

The extension does nothing unless you set these environment variables on the VS Code process. The client that launches VS Code chooses the values, so it already knows which port and token belong to which instance.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VSCODE_CONTROLLER_PORT` | Yes | TCP port to listen on. The socket binds to `127.0.0.1` only. |
| `VSCODE_CONTROLLER_TOKEN` | Yes | Secret that clients must send in `authenticate` before any other call. Use a long random value. Without it, the socket doesn't start. |
| `VSCODE_CONTROLLER_WORKSPACE` | No | Folder or `.code-workspace` path. Only the window that has it open listens. Use it whenever the VS Code process can have more than one window, for example windows restored from the previous session or opened later. Those windows inherit the same environment variables and also try to open the port. Without it, whichever window starts first gets the socket, which may not be the workspace you launched. The others log `EADDRINUSE`. |

```sh
VSCODE_CONTROLLER_PORT=7001 \
VSCODE_CONTROLLER_TOKEN="$(openssl rand -hex 32)" \
VSCODE_CONTROLLER_WORKSPACE=/path/to/workspace \
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" /path/to/workspace
```

If VS Code is already running with the same user data directory, the launch is forwarded to the existing process. The new window gets that process's environment variables, not the ones you launched with. Close VS Code first or use a separate `--user-data-dir`.

Diagnostics appear in the **VS Code Controller** output channel.

## Protocol

Send one JSON-RPC message per line, terminated by `\n`. Responses arrive the same way. The server handles requests on a connection concurrently, so you can call `chat.cancel` while `chat.sendPrompt` is still waiting. Batches run in order, and notifications (messages without `id`) get no response.

```text
→ {"jsonrpc":"2.0","id":1,"method":"authenticate","params":{"token":"<token>"}}
← {"jsonrpc":"2.0","id":1,"result":{"authenticated":true}}
→ {"jsonrpc":"2.0","id":2,"method":"chat.selectModel","params":{"name":"Example Model"}}
← {"jsonrpc":"2.0","id":2,"result":{"selector":{"id":"example-model","vendor":"agent-host-copilotcli"},"harness":null}}
```

The extension opens the socket only after VS Code finishes starting up, so a successful connection means the workbench is ready. Retry the connection until it succeeds.

### Error codes

| Code | Meaning |
| --- | --- |
| `-32700` | Parse error |
| `-32600` | Invalid request, or a message over 10 MB, which also closes the connection |
| `-32601` | Method not found |
| `-32602` | Invalid params. Unknown parameters are rejected. |
| `-32000` | The VS Code command failed; `message` contains VS Code's error |
| `-32001` | Not authenticated, or invalid token. An invalid token also closes the connection. |

## Methods

All parameters are named (an object).

| Method | Params | VS Code command | Returns |
| --- | --- | --- | --- |
| `authenticate` | `token` | | `{ authenticated: true }` |
| `getStatus` | | | VS Code version, workspace folders, Copilot Chat state |
| `executeCommand` | `command`, `args?` (array) | any | The command's result |
| `getSetting` | `key` | | Effective, default, global and workspace values |
| `setSetting` | `key`, `value?` | | Writes to workspace settings. Omit `value` to remove the setting. |
| `chat.open` | | `workbench.action.chat.open` | `null` |
| `mcp.startServer` | `serverId?` (default `*` = all), `waitForLiveTools?`, `timeoutMs?` (default `30000`) | `workbench.mcp.startServer` | `null` |
| `mcp.restartServer` | `serverId`, `timeoutMs?` (default `30000`) | `workbench.mcp.restartServer` | `null` |
| `chat.newChat` | `harness?` | `workbench.action.chat.newChat` or `workbench.action.chat.openNewChatSessionInPlace.<harness>` | `{ harness }` |
| `chat.listModels` | `id?`, `vendor?`, `family?`, `version?` | `vscode.lm.selectChatModels` | Models with `id`, `vendor`, `family`, `name` |
| `chat.selectModel` | `name?` or `id?`, `vendor?`, `family?`, `version?` | `workbench.action.chat.open` with `modelSelector` | `{ selector, harness }` |
| `chat.setMode` | `mode` | `workbench.action.chat.open` with `mode` | `null` |
| `chat.sendPrompt` | `prompt`, `waitForResponse?` (default `true`) | `workbench.action.chat.open` with `query` and `blockOnResponse` | Chat result, or `null` when not waiting. Fails if the request didn't run in the requested harness or with the selected model. |
| `chat.acceptTool` | | `workbench.action.chat.acceptTool` | `null` |
| `terminal.kill` | | `workbench.action.terminal.kill` | `null` |
| `chat.cancel` | | `workbench.action.chat.cancel` | `null` |
| `notifications.clearAll` | | `notifications.clearAll` | `null` |
| `chat.keepAllEdits` | | `chatEditing.acceptAllFiles` | `null` |

### Harnesses and model selection

A chat runs in a *harness* (session type), such as `local` or `agent-host-copilotcli` (Copilot CLI). Each harness's agent only accepts models from its own vendor. If you select a model from another vendor, VS Code ignores it without an error and uses the agent's default model.

- `chat.newChat` without `harness` lets VS Code pick the session type. Pass `harness` to choose it explicitly. Calling it with an unknown harness returns the available ones in `error.data.available`.
- VS Code can silently replace the requested harness. When your GitHub account's Copilot managed settings contain `sandbox.enabled` or any `permissions.*` key, every new chat uses `agent-host-copilotcli`, even an explicit `local` one. An administrator can lift this only with the `chat.temporaryDefaultToLocalHarness` policy. Without such policy, the user settings `chat.defaultToCopilotHarness` and `chat.editor.preferCopilotHarness` and the session type you last picked decide the default harness.
- `chat.selectModel` with `name` matches the display name in the model picker and resolves it to a model ID. Without `vendor`, the extension uses `copilot` for `local`, and the harness name for other harnesses. For a chat started without `harness`, it uses `agent-host-copilotcli` when that harness is available, and `copilot` otherwise. Pass `vendor` to override this.
- Models load asynchronously after startup. If `chat.selectModel` fails with `No language model named…` or `No language models found matching selector…`, retry after a short delay.

### Request verification

VS Code doesn't report when it ignores the requested harness or model, and it doesn't expose either one before a request runs. So after `chat.sendPrompt` finishes, the extension exports the chat and checks the request:

- **Harness:** the agent that handled the request must belong to the harness passed to the last `chat.newChat`.
- **Model:** the model recorded on the request, the agent, and the model the agent reports in the response details must match the last `chat.selectModel`.

On a mismatch, `chat.sendPrompt` fails with `-32000`, and `error.data` contains `expected`, `served`, and the chat `result`. The prompt has already run when the check fails. The check is skipped when `waitForResponse` is `false`. The harness check is also skipped when `chat.newChat` was called without `harness`, and the model check when the model was selected without an `id` or `name`.

### Waiting for responses

`chat.sendPrompt` resolves when the response completes, fails, or needs user input. In the last case, the result has `type: "confirmation"` and a `kind`: `toolInvocation`, `toolPostApproval`, `confirmation`, `questionCarousel` or `elicitation`. VS Code has no command to resume waiting after you answer a confirmation. To keep runs unattended, configure auto-approval, for example the user settings `chat.tools.global.autoApprove` and `chat.agent.maxRequests`, or `chat.permissions.default`.

To enforce a timeout, call `chat.cancel` from the client; the pending `chat.sendPrompt` then resolves.

## Examples

[examples/client.mjs](examples/client.mjs) is a zero-dependency client library and CLI. Both examples read `VSCODE_CONTROLLER_PORT` and `VSCODE_CONTROLLER_TOKEN`.

```sh
node examples/client.mjs getStatus
node examples/client.mjs chat.selectModel '{"name":"Example Model"}'
```

[examples/run-prompt.mjs](examples/run-prompt.mjs) runs a complete prompt. It waits for readiness, opens a new chat, selects the model and agent with retries, sends the prompt, cancels on timeout, then clears notifications and keeps edits.

```sh
node examples/run-prompt.mjs "Add a README" --model "Example Model" --mode agent --timeout 600000
```

### Passing URIs to `executeCommand`

Arguments are plain JSON. For commands that expect a URI, pass a marshalled URI, which VS Code revives automatically:

```json
{"command":"workbench.action.chat.export","args":[{"$mid":1,"scheme":"file","path":"/path/to/chat.json"}]}
```

## Notes

- `mcp.startServer` and `mcp.restartServer` wait until the servers have started. A server that never answers `initialize` would block them forever, so they fail after `timeoutMs`. VS Code can't cancel a server start, so the server keeps starting in the background.
- VS Code has no command to enable or disable a single extension; `workbench.extensions.action.disableAll` also disables this controller. Change extension enablement before launching VS Code, for example with `--disable-extension <id>`.
- `setSetting` writes workspace settings only. Settings that VS Code restricts to user settings, such as `chat.tools.global.autoApprove`, return an error.
- `chat.setMode` can't confirm that VS Code applied the change. An unknown mode is ignored.

## Development

```sh
npm test        # builds and runs the unit tests
```

The `Run Extension` launch configuration starts an Extension Development Host with the socket enabled on port 7001 and token `dev-token`.

# VS Code Controller

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/waldek.vscode-controller.svg)](https://marketplace.visualstudio.com/items?itemName=waldek.vscode-controller)
[![Installs](https://vsmarketplacebadges.dev/installs-short/waldek.vscode-controller.svg)](https://marketplace.visualstudio.com/items?itemName=waldek.vscode-controller)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Script VS Code and GitHub Copilot Chat like an API.** Start a chat, pick the model and agent, send a prompt, wait for the result and keep the edits, all from your own code. No clicking through the UI and no fragile automation of the workbench DOM.

```text
→ {"jsonrpc":"2.0","id":1,"method":"authenticate","params":{"token":"<token>"}}
→ {"jsonrpc":"2.0","id":2,"method":"chat.selectModel","params":{"name":"Example Model"}}
→ {"jsonrpc":"2.0","id":3,"method":"chat.sendPrompt","params":{"prompt":"Add unit tests for src/utils.ts"}}
← {"jsonrpc":"2.0","id":3,"result":{ ... chat result ... }}
```

## Why

You want to run the same prompt against several models, benchmark agents, reproduce a Copilot bug or run Copilot Chat in CI. The usual way is UI automation that clicks through the workbench, and it breaks every time VS Code changes a selector or a layout.

VS Code Controller opens a local [JSON-RPC 2.0](https://www.jsonrpc.org/specification) socket inside VS Code. Each method maps to a VS Code command, so your scripts use the same stable entry points that the UI uses. Any language that can open a TCP socket can drive it.

## Features

- **Full Copilot Chat run from code**: start a new chat, choose the harness, model and mode, send a prompt and wait for the response
- **Verified runs**: after each prompt, the extension checks that the request really ran with the harness and model you asked for, because VS Code silently falls back when it can't use them
- **Unattended runs**: accept tool calls, cancel on timeout, kill terminals, clear notifications and keep all edits
- **MCP control**: start or restart MCP servers and wait until their tools are live
- **Any VS Code command**: call `executeCommand` with any command ID and JSON arguments, including URIs
- **Settings**: read effective setting values and write workspace settings
- **Many windows, many instances**: give each VS Code process its own port and token, and bind the socket to a specific workspace
- **Off by default and authenticated**: the socket starts only when you set the environment variables, listens on `127.0.0.1` only, and requires a token
- **Zero-dependency client**: a Node.js [client library and CLI](examples/client.mjs) and a complete [prompt runner](examples/run-prompt.mjs) to start from

## Getting started

### 1. Install the extension

Install [VS Code Controller](https://marketplace.visualstudio.com/items?itemName=waldek.vscode-controller) from the Marketplace, or run:

```sh
code --install-extension waldek.vscode-controller
```

Requirements: stable VS Code 1.140 or newer (verified on 1.142), and GitHub Copilot Chat signed in for the chat methods.

### 2. Launch VS Code with a port and token

The extension does nothing until you set these environment variables on the VS Code process:

```sh
export VSCODE_CONTROLLER_PORT=7001
export VSCODE_CONTROLLER_TOKEN="$(openssl rand -hex 32)"
VSCODE_CONTROLLER_WORKSPACE=/path/to/workspace \
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" /path/to/workspace &
```

### 3. Send commands

Clone this repository for the [example client](examples/client.mjs). In the same shell, check the connection and run a prompt:

```sh
git clone https://github.com/waldekmastykarz/vsc-vscodecontroller.git && cd vsc-vscodecontroller
node examples/client.mjs getStatus
node examples/run-prompt.mjs "Add a README" --model "Example Model" --mode agent --timeout 600000
```

Or connect from any language: open a TCP connection to `127.0.0.1:7001`, send one JSON-RPC message per line, and call `authenticate` first.

## Configuration

The client that launches VS Code chooses the values, so it already knows which port and token belong to which instance.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VSCODE_CONTROLLER_PORT` | Yes | TCP port to listen on. The socket binds to `127.0.0.1` only. |
| `VSCODE_CONTROLLER_TOKEN` | Yes | Secret that clients must send in `authenticate` before any other call. Use a long random value. Without it, the socket doesn't start. |
| `VSCODE_CONTROLLER_WORKSPACE` | No | Folder or `.code-workspace` path. Only the window that has it open listens. Use it whenever the VS Code process can have more than one window, for example windows restored from the previous session or opened later. Those windows inherit the same environment variables and also try to open the port. Without it, whichever window starts first gets the socket, which may not be the workspace you launched. The others log `EADDRINUSE`. |

If VS Code is already running with the same user data directory, the launch is forwarded to the existing process. The new window gets that process's environment variables, not the ones you launched with. Close VS Code first or use a separate `--user-data-dir`.

Diagnostics appear in the **VS Code Controller** output channel.

## Security

Anyone who has the token can do anything that VS Code can do: run any command, edit files, change settings, open terminals and run Copilot agents with your credentials. Treat the token like a password.

The extension limits who can connect:

- **Off by default.** Without `VSCODE_CONTROLLER_PORT` and `VSCODE_CONTROLLER_TOKEN`, the extension doesn't open a socket.
- **Local only.** The socket binds to `127.0.0.1`, so other machines on your network can't reach it.
- **Token required.** Every connection must call `authenticate` before any other method. The token is compared in constant time, and a wrong token closes the connection.
- **Message size limit.** Messages over 10 MB are rejected and close the connection.

What you should do:

- Generate a long random token for each launch, for example `openssl rand -hex 32`, and don't commit it or write it to logs.
- Don't forward or expose the port, for example with SSH tunnels, VS Code port forwarding, containers that publish ports or a reverse proxy.
- Remember that every process running as your user can connect to `127.0.0.1` and can usually read VS Code's environment variables. Use the controller on machines and accounts that you trust, such as your own workstation, a CI runner or a disposable VM.
- When you don't need the controller, launch VS Code without the environment variables or disable the extension.

To report a security issue, open an [issue](https://github.com/waldekmastykarz/vsc-vscodecontroller/issues) without exploit details, and ask for a private channel.

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

If several models share a display name, `--model` fails with `Multiple language models are named…` and lists the matches in `error.data.matches`. Pass `--model-id` with one of the listed IDs instead. The extension derives the vendor from the harness, or you can set it with `--model-vendor`.

```sh
node examples/run-prompt.mjs "Add a README" --harness local --model-id example-model --mode agent --timeout 600000
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
npm install
npm test           # builds and runs the unit tests
npm run package    # builds vscode-controller-<version>.vsix
```

The `Run Extension` launch configuration starts an Extension Development Host with the socket enabled on port 7001 and token `dev-token`. To run from source without the debugger, launch VS Code with `--extensionDevelopmentPath=/path/to/this/folder`.

## License

[MIT](LICENSE)

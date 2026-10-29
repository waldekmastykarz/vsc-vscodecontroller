# Change Log

All notable changes to the "vscode-controller" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.0] - 2026-10-29

### Added

- Local JSON-RPC 2.0 socket on `127.0.0.1`, enabled with `VSCODE_CONTROLLER_PORT` and `VSCODE_CONTROLLER_TOKEN`
- Token authentication, and `VSCODE_CONTROLLER_WORKSPACE` to choose which window listens
- `getStatus`, `executeCommand`, `getSetting` and `setSetting` methods
- Copilot Chat methods: `chat.open`, `chat.newChat`, `chat.listModels`, `chat.selectModel`, `chat.setMode`, `chat.sendPrompt`, `chat.acceptTool`, `chat.cancel` and `chat.keepAllEdits`
- `mcp.startServer`, `mcp.restartServer`, `terminal.kill` and `notifications.clearAll` methods
- Harness and model verification after `chat.sendPrompt`

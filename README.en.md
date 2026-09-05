<div align="center">

# AgentCodeGUI

### Build through conversation. Review it in code.

**A Windows desktop app for Claude Code and Codex**

Describe the work, inspect the changed files, and run agents side by side.

[한국어](README.md) · **English**

[![Release](https://img.shields.io/github/v/release/UnrealFactory/AgentCodeGUI?label=release&color=2ea44f)](https://github.com/UnrealFactory/AgentCodeGUI/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/UnrealFactory/AgentCodeGUI/total?color=blue)](https://github.com/UnrealFactory/AgentCodeGUI/releases)
[![Stars](https://img.shields.io/github/stars/UnrealFactory/AgentCodeGUI?color=e3b341&label=stars)](https://github.com/UnrealFactory/AgentCodeGUI/stargazers)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)

[**Download for Windows →**](https://github.com/UnrealFactory/AgentCodeGUI/releases/latest) · [Release notes](https://github.com/UnrealFactory/AgentCodeGUI/releases) · [Report a bug · Request a feature](https://github.com/UnrealFactory/AgentCodeGUI/issues)

<img src="docs/images/workspace.png" width="1100" alt="AgentCodeGUI 3 with the file explorer, chat, and an expanded multi-file Edit" />

<sub>Actual app, version 3.0.10 · Orbit example project · Korean UI shown; English is available in Settings</sub>

</div>

## From the first request to the final review

AgentCodeGUI brings **chat, file browsing, code review, and Git** to terminal coding agents. Use Claude Code and Codex while following exactly which files your agents change.

| What you want to do | In the app |
|---|---|
| Build a feature | Describe it in chat and follow replies and tool activity live |
| Review the changes | Open individual files from an Edit list and compare additions and deletions |
| Split up the work | Run up to six panels with separate folders, models, and accounts |
| Connect your tools | Browse Claude and Codex MCP servers and skills with Local/Global filters |
| Ship the result | Select changed files, write a commit message, commit, pull, and push |

## 01. Ask for a change. Open the files it touched.

Replies and tool activity stay together in the conversation. **Expand an Edit row** to open each changed file and see its added and removed line counts.

- **File explorer and code viewer** — search, edit, and compare changes
- **Code intelligence** — go to definition (`F12`), hover documentation, and completion
- **Previews** — open HTML as a rendered page and Markdown as a document

<img src="docs/images/preview.png" width="1100" alt="Opening index.html from the conversation in the built-in HTML preview" />

<sub>Click a file to inspect the result. The dashboard shown is an example project.</sub>

## 02. Put Claude and Codex side by side

Build the interface in one panel while connecting the API or reviewing code in another. Give each of **up to six panels** its own working folder, model, and account.

<img src="docs/images/multi-agent.png" width="1100" alt="Three panels using Claude and Codex for dashboard, API, and code review examples" />

- Change the panel count and drag panels into your preferred order
- Open an extra chat window (`Ctrl+Shift+N`) beside your other work
- Track tasks, subagents, background commands, and changed files in the work bar
- Follow stages and per-agent progress in Claude workflows

## 03. Bring your accounts and tools

| Engine | Sign in with | Per-chat settings |
|---|---|---|
| **Claude Code** · Anthropic | Claude subscription account or API key | Model, reasoning effort, and permission mode |
| **Codex CLI** · OpenAI | ChatGPT subscription account or API key | Model, reasoning effort, and supported speed options |

Install and update the engines from the app. Register multiple accounts, choose one per conversation, and check remaining usage limits.

Open **MCP & Skill** to browse tools for the selected engine. Narrow the list with Local/Global filters and toggle supported items. Insert skills with Claude's `/` or Codex's `$` completion. Codex configuration changes apply on the next run.

## Useful details, included

| Conversation | Code and workspace |
|---|---|
| Image and text attachments, `@` file mentions | Code intelligence for TypeScript, JavaScript, Python, C#, and C/C++ |
| `Ctrl+F` chat search and sent-message recall | HTML and Markdown previews, change comparison |
| Approval and question cards, queued messages | Git file selection, history, branch switching and creation |
| Mouse gestures, English and Korean UI | Open a working folder from its context menu |

## Install

1. Download `AgentCodeGUI3_<version>_x64-setup.exe` from the [**latest release**](https://github.com/UnrealFactory/AgentCodeGUI/releases/latest) and run it.
2. Complete engine installation in the app.
3. Sign in under **Settings → Account**, or add a key under **API**.
4. Pick a working folder and send your first message.

Supports **Windows 10/11 · x64**. Check for and install later versions from **Settings → Updates**.

<details>
<summary>If Windows SmartScreen appears during installation</summary>

Current releases do not carry a Windows code-signing certificate. After checking that the file came from the official release, use **More info → Run anyway** to install. In-app updates are verified with a separate updater signature.

</details>

## Development

Version 3.x uses **Tauri 2, Rust, React, and TypeScript**. You need Node.js 22 or later, Rust, and the Windows C++ build tools.

```bash
npm install
npm run tauri:dev              # launch the development app
npm run typecheck:app          # check the current app's types
cargo test --workspace         # run Rust tests
npm run tauri:build:unsigned   # build a local test installer
```

| Path | Purpose |
|---|---|
| `app/src` | React UI for 3.x |
| `src-tauri` | Tauri shell, windows, and IPC |
| `crates` | Engines, accounts, storage, files, and code intelligence |
| `src/shared` | Shared protocol and types |

For distribution, configure the updater signing key and use `npm run tauri:build`. Recapture the example-project screenshots with `node scripts/readme-screenshots.mjs`.

---

**Help make the app better.** Share [bugs and ideas](https://github.com/UnrealFactory/AgentCodeGUI/issues), or leave a [⭐ Star](https://github.com/UnrealFactory/AgentCodeGUI/stargazers) if you enjoy using it.

[MIT License](LICENSE)

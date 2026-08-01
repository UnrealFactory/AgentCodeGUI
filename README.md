<div align="center">

# AgentCodeGUI

**The all-in-one agent app for Claude Code and Codex CLI**

Code by conversation — then read and fix it right there.

**English** · [한국어](README.ko.md)

[![Release](https://img.shields.io/github/v/release/UnrealFactory/AgentCodeGUI?label=release&color=2ea44f)](https://github.com/UnrealFactory/AgentCodeGUI/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/UnrealFactory/AgentCodeGUI/total?color=blue)](https://github.com/UnrealFactory/AgentCodeGUI/releases)
[![Stars](https://img.shields.io/github/stars/UnrealFactory/AgentCodeGUI?color=e3b341&label=stars)](https://github.com/UnrealFactory/AgentCodeGUI/stargazers)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)

<img src="docs/chat.png" width="900" alt="AgentCodeGUI — chat" />

<img src="docs/multi.png" width="900" alt="AgentCodeGUI — multi-agent" />

<img src="docs/code.png" width="900" alt="AgentCodeGUI — explorer · code viewer" />

</div>

## Overview

AgentCodeGUI is a Windows app that brings the terminal coding agents (**Claude Code** · **Codex CLI**) into a single desktop app. Give it work by chat, read the code the agent touched in the **built-in explorer and LSP code viewer**, and run multiple agents **side by side**.

- **Start without an API key** — sign in with your Claude / ChatGPT subscription right in the app and run on it. API-key (pay-as-you-go) billing is available too.
- **Install once** — the app installs and updates the engines (Claude Code · Codex CLI) by itself, and never touches your system-wide terminal setup.
- **Flat dark design on Windows 11 acrylic** — English and Korean UI, switchable in Settings.

## Features

**Chat · Agents**

- Streaming replies · tool-call logs · approval/question cards (answered ones stay in the thread) · queue messages while a run is going
- **Claude workflows** — multi-agent orchestration runs to completion in the background and posts a wrap-up reply when done. Progress flows live from a pill into a stage/agent board
- **Background residency** — shells (dev servers), subagents, and workflows outlive the turn, and messages sent meanwhile continue in the same session
- Subagent cards — live narration and process logs · background shell tracking (live output, stop, `Ctrl+B` skip)
- Work bar — to-dos · subagents · background shells · changed files · context gauge in one line
- `Ctrl+F` chat search · image/text attachments · `/` commands & skills · `@` file mentions · `↑`/`↓` recall sent messages
- Right-drag **mouse gestures** — scroll, previous/next file, window control, even clearing the chat by hand

**Multi · Extra chats**

- Up to 6 panels working at once, each with its own **folder, model, and account** — inside, it's the main chat verbatim (composer, work bar, approval cards)
- **Extra chat** (`Ctrl+Shift+N`) — an independent OS window to keep beside your code; the conversation persists on close and restores on restart

**Code intelligence**

- Built-in explorer + LSP code viewer — **TS/JS · Python · C# (whole solutions) · C/C++ · Unreal Verse**
- `F12` go-to-definition · semantic coloring (JetBrains palette) · structured hover cards · kind-aware completion icons
- **Korean-translated hovers** for official API docs (Unreal C++ · Verse) · C# assembly symbols decompile on `F12`
- Diff viewer (additions = green rows · deletions = red ghost lines) · **HTML opens straight into a rendered preview** · markdown rendering
- Files the agent touched get colors and badges; right-click a folder → **collected changed files**

## Workflows

Claude Code's **Workflow tool** (multi-agent orchestration) works in the app as-is. Ask it to "audit this whole change with a workflow" and multiple agents work the stages in parallel — and unlike the terminal, the workflow **runs to completion in the background** even after the turn ends, delivering a wrap-up reply on its own.

<div align="center">
<img src="docs/workflow-run.png" width="900" alt="Workflow run — progress in the bottom pill" />

<img src="docs/workflow-board.png" width="900" alt="Workflow board — stage rail + per-agent model/tokens live" />
</div>

- The bottom **pill** summarizes progress; press it to unfold the **stage rail + agent board** (per-agent model, tokens, tool counts — live)
- You can **keep chatting** while a workflow runs — it continues in the same session
- **Stop** from the card, tuck it away with `Esc` or the `↓→` gesture — main chat, multi panels, and extra chats alike

## Git

<div align="center">
<img src="docs/git.png" width="900" alt="Built-in Git — changed-file checklist · AI commit message · pull/push" />
</div>

A built-in Git surface for reviewing and shipping what your agents produced — no terminal detour.

- **Changed-file checklist** — check exactly what goes into the commit, click any file to see its diff
- **AI commit message** — one button drafts the message from the staged changes
- Pull / push · history · branch switching and creation
- **Nested repos auto-discovered** (up to 3 levels deep) — monorepo-ish folders each get their own card

## Supported AI Models

| Engine | Models | Billing |
|---|---|---|
| **Claude Code** (Anthropic) | Fable 5 · Opus 5 · Sonnet 5 · Haiku 4.5 | Claude subscription (Pro/Max) or API key |
| **Codex CLI** (OpenAI) | GPT-5.6-Sol · GPT-5.6-Terra · GPT-5.6-Luna | ChatGPT subscription (Plus/Pro) or API key |

The model list loads live from the installed engine — when a new model ships, it just appears in the picker. Engine, model, reasoning effort, and permission mode are chosen per chat in the composer.

## Accounts

<div align="center">
<img src="docs/accounts.png" width="900" alt="Settings — Account" />
</div>

Register and manage subscription accounts per engine in Settings → **Account** — keep **several** Anthropic and OpenAI accounts and bind any chat to any of them (unbound chats use the **default** account). Each account shows a **remaining-limit gauge** (5-hour · weekly · Fable) so you can hop to whichever has headroom.

All credentials are stored encrypted (DPAPI) under `~/.agentcodegui`, **fully separated** from your terminal Claude Code (`~/.claude`) and codex (`~/.codex`) logins — neither side affects the other.

## Installation

1. Grab `AgentCodeGUI-Setup-<version>.exe` from [**Releases**](https://github.com/UnrealFactory/AgentCodeGUI/releases/latest) and run it.
2. If SmartScreen warns (the build is unsigned), continue via **"More info → Run anyway"**.
3. Engines install automatically on first launch. Sign in with a subscription account in Settings → **Account** (or add a key in Settings → **API**) and you're off.

- Requirements: **Windows 10/11**
- New versions **auto-update** — when the sidebar badge appears, one click installs quietly.
- Right-click a folder → **"Open with AgentCodeGUI"** to open it as the working folder directly.

### Code signing

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Development

```bash
npm install          # install dependencies
npm run dev          # electron-vite dev (HMR)
npm run typecheck    # tsc — main (node) + renderer (web)
npm run package      # build the NSIS installer (.exe)
npm run release      # build + publish to GitHub Releases (needs GH_TOKEN)
```

```
src/main      Electron main — claude/ · codex/ engine adapters, lsp/, persistence (~/.agentcodegui)
src/renderer  React UI — components/, store/session.ts (EngineEvent reducer)
src/shared    IPC protocol & types (the main ↔ renderer contract)
```

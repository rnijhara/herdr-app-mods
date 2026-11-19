---
name: herdr
description: Herdr desktop app and herdr-core (`hc`). Use when HC_TERMINAL_ID is set, or for managing agents/programs in persistent terminals, other machines, or the Herdr window (spaces, tabs, layouts, mods). Not the old `herdr` TUI.
---

Read the live manuals first: `hc --skill` (terminals, agents, machines) and `herdr-app --skill` (the window); mods and layouts: `~/.config/herdr-app/AGENTS.md`.

- The window uses the personal layout `layouts/herdr-plus.json`; edit it directly.
- Don't edit `*-synced` mods: `mods/mod-patches` regenerates them from Herdr's mods on every start; change its PATCHES.
- New mod: write `mod.json` before `main.js`; run `herdr-app check <mod>` after changes.
- Never stop or restart the core unless asked.
- Source of these mods, the layout and this skill: the herdr-app-mods repo (copy changes back there and commit).

## Delegating to worker agents

Templates in `~/.config/herdr-core/templates/`: `opus` (Claude Opus 5.5), `astra` (Codex GPT-6.2 Astra), `sol` (Codex GPT-6.2 Sol). Each already tells the worker to report with `hc send` (RESULT:/BLOCKED:), and stay in scope. `astra` and `sol` can use the computer (screen, mouse, keyboard): hand them manual UI testing.

- Launch: `hc run --bg --name <role> --cwd <dir> <template> "<scoped task>"`. Check `first_message.sent`; if false, `hc read` it before resending.
- Computer use needs the screen unlocked and the target window uncovered. Codex asks to allow each app, and hc reports the worker as blocked (permission): allow only the apps the task needs, with `hc keys <t> down enter` ("Allow for this session").
- Don't wait or poll: no `hc wait`, no sleep loops. Keep working or end the turn; reports arrive as `<hc from="tN name">` input. hc also tells you when a worker is blocked, errors, or exits.

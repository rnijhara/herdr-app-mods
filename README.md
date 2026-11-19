# herdr-app-mods

Mods and a layout for the [Herdr desktop app](https://herdr.dev), plus a small
setup for running coding agents as workers through herdr-core (`hc`).

Written against Herdr app 0.1.16 and herdr-core 0.1.21 on macOS. The `machines`
mod also reads Linux machines added with `hc machine add`.

![The herdr-plus layout](layouts/herdr-plus.svg)

## Install

```sh
git clone https://github.com/rnijhara/herdr-app-mods.git && cd herdr-app-mods
./install.sh           # installs what's missing, then switches Herdr to herdr-plus
./install.sh --force   # replaces installed copies with this repo's
```

`install.sh` never overwrites a file you changed unless you pass `--force`, and it
runs `herdr-app check` on every mod it installs.

To take a single mod, copy its folder to `~/.config/herdr-app/mods/` (`mod.json`
first: Herdr docks a folder it sees without one into the shown layout).

## Mods

| Mod | What it does |
|---|---|
| `machines` | CPU sparkline and memory bar for this computer and every `hc machine ls` machine, sampled every 3 s (`top`/`vm_stat` on macOS, `/proc` on Linux). A sidebar list, or with `"compact": true` one status-bar line. With `"show": "several"` or `"one"` a copy appears only while there is more than one machine, or only one, so a layout can hold both and show the right one. |
| `usage-limits` | Status bar: Claude Code and Codex plan limits (weekly, model-scoped, and the 5-hour window once it is 50% used). Uses each tool's own sign-in (keychain, `~/.codex/auth.json`) against its own provider's undocumented usage endpoint. |
| `keep-awake` | Status-bar cup: keeps the Mac and its display awake with `caffeinate -di -w <Herdr pid>` in an hc terminal named `keep-awake`, so the hold ends when Herdr quits. |
| `open-in` | Status-bar "Open in" split button: the left part opens the focused terminal's folder (the space's folder when no terminal has focus) in the default editor and shows its icon; the chevron lists the installed editors (Cursor, VS Code, VS Code Insiders, VSCodium, Zed, Trae, Kiro, Antigravity, JetBrains IDEs), then Finder, and the one you pick becomes the default. macOS only: an editor counts as installed when its command is on PATH or its CLI is inside its app in `/Applications` or `~/Applications`. Icons come from the installed apps, cached in the mod's hidden `.icons/`. Spaces on another machine are skipped. Keys in `keys.json` `global`: `"cmd-shift-e": "open-in.open"` (default editor), `open-in.menu` (the picker). |
| `cite` | Quote-reply across agents. Hold ⇧⌘ and drag over any terminal's text: a popup takes an optional note and the quote joins a numbered list in the **Citations** panel beside Files and Changes. Click a quote to jump back to it; **Send to** pastes the list into an agent's input without pressing Enter. **⌘⇧'** pastes into the focused terminal (needs `"cmd-shift-'": "cite.paste"` in `keys.json` `global`). The modifier is read by `modstate.c`, built with `cc` on first start (no permissions needed). Relies on copy-on-select, Herdr's default. |
| `tab-namer` | Names unnamed tabs: the agent's title, else the program and folder. Tabs you name are left alone; renaming one to "" hands it back. |
| `mod-patches` | Keeps patched copies of three of Herdr's own mods current (below). |

### mod-patches

On every start, `mod-patches` regenerates each `*-synced` mod from Herdr's latest
mod plus a small patch, so Herdr's fixes still arrive. If Herdr changed the patched
code, the copy falls back to Herdr's unpatched mod and a notification names the
patch. After an update rewrites a copy, it asks for a restart (a mod reloaded in
place can be left half-updated). Log: `~/.config/herdr-app/.mod-patches.log`.

| Herdr mod | Copy | Patch |
|---|---|---|
| `workspace-status` | `workspace-status-synced` | No "⌘⇧P commands" hint (the cup sits there) |
| `workspace-chrome` | `workspace-chrome-synced` | No "Add machine" row in the sidebar footer |
| `tabs` | `tabs-synced` | A Citations button, with a count, for `cite` |

The patches are `PATCHES` in `mods/mod-patches/main.js`. Change Herdr's mods only there.

## Layout: herdr-plus

Herdr's `main` layout plus:

- **Machines**: in the sidebar when you have several machines, as one status-bar line when this computer is the only one. Each copy sizes its own block, down to 0 px when it shouldn't show.
- **Status bar**: usage limits, the keep-awake cup and the Open in button.
- **Citations** in the right panel's stack, beside Files and Changes.
- Three 0 px helper blocks: `tab-namer`, `mod-patches` and `cite-watch`.

## Agents: hc worker templates and skills

`hc-templates/` holds herdr-core templates for worker agents, installed to
`~/.config/herdr-core/templates/`:

| Template | Agent |
|---|---|
| `opus` | Claude Code, Opus 5.5 (1M context), high effort |
| `astra` | Codex, GPT-6.2 Astra, high effort |
| `sol` | Codex, GPT-6.2 Sol, high effort |
| `neon` | OpenCode, Gemini 4 Neon through OpenRouter, xhigh effort |

A lead agent starts one with a task and keeps working:

```sh
hc run --bg --name review --cwd /path/to/repo astra "Review the diff on this branch. Read-only."
```

Each template tells the worker to stay in scope and report
with `hc send` (RESULT: or BLOCKED:). The report arrives as the lead's next input,
so the lead never polls.

- Codex runs with `--no-daemon`, as herdr-core requires. To let Codex report without
  a permission prompt, add `prefix_rule(pattern=["hc", "send"], decision="allow")` to
  `~/.codex/rules/default.rules`.
- OpenCode's interactive UI has no `--model` flag, so `neon` sets the model with
  `OPENCODE_CONFIG_CONTENT` and runs `--standalone`: without it the setting never
  reaches OpenCode's background service. It needs an OpenRouter sign-in in OpenCode
  and is billed per token.
- A Claude Code worker shows a trust prompt the first time it opens a folder; hc
  reports it to the lead as blocked.

`skills/` holds two Claude Code skills, installed to `~/.claude/skills/`: `herdr`
points agents at `hc --skill` and `herdr-app --skill` and covers delegating to the
templates; `orchestrate` leads a task by delegating to `opus`, `astra` and `sol`; name `neon`
yourself when you want it.

## Changing things

- Edit the installed copies in `~/.config/herdr-app` (Herdr reloads mods live), run
  `herdr-app check <mod folder>`, then copy the change back here.
- Create a new mod's `mod.json` before its `main.js`.
- Not in this repo: the generated `*-synced` mods (`install.sh` seeds them,
  `mod-patches` rewrites them) and files Herdr writes into mod folders
  (`jsconfig.json`, `*.d.ts`).

## License

[Apache-2.0](LICENSE). The cup, quote and code icons come from
[Lucide](https://lucide.dev) (ISC); see [NOTICE](NOTICE).

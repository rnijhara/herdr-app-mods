// The </> in the status bar: opens the focused terminal's folder in VS Code.
// With no terminal focused (a mod pane) it opens the space's folder, else home.
// A space on another machine (`hc machine`) is left alone: its folders aren't here.
// Runs VS Code's `code` command; without it on PATH, macOS opens the app directly.
// keys.json can bind it too: "cmd-shift-e": "open-vscode.open" in `global`.
import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { checking, exec, focused, home, nextCommand, notify, spaces, theme } from "herdr";

const ICON = "mods/open-vscode/code.svg";
const BUNDLE = "com.microsoft.VSCode"; // macOS fallback when `code` isn't on PATH

// The folder to open, and the machine it is on (null: this computer).
function target() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  return { dir: f?.cwd || space?.folder || home(), machine: space?.machine ?? null };
}

const tilde = (p) => (p === home() ? "~" : p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);

async function launch(dir) {
  let r;
  try {
    r = await exec("code", [dir], { timeout: 15000 });
  } catch {
    r = await exec("open", ["-b", BUNDLE, dir], { timeout: 15000 }).catch(() => null);
    if (!r) throw new Error("No `code` command: in VS Code, run \"Shell Command: Install 'code' command in PATH\".");
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exited with ${r.code}`);
}

export default class OpenVSCode extends View {
  init(_props, cx) {
    this.busy = false;
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "open") this.open(cx);
      }
    });
  }

  open(cx) {
    const { dir, machine } = target();
    if (machine || this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await launch(dir);
      } catch (e) {
        notify({ title: "Couldn't open VS Code", body: String(e?.message ?? e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const { dir, machine } = target();
    const tip = machine ? `${dir} is on ${machine}: VS Code opens folders on this computer` : `Open ${tilde(dir)} in VS Code`;
    return h_flex().id("root").size_full().items_center().justify_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("open").size(22).rounded(5).items_center().justify_center()
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_click((_e, cx) => this.open(cx))
        .child(svg(ICON).size(14).text_color(machine || this.busy ? t.dim : t.muted)));
  }
}

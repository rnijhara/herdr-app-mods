// "Open in": a split button in the status bar. The left part opens
// the focused terminal's folder (else the space's, else home) in the default editor and
// shows its icon; the chevron lists the installed editors, then Finder, and picking one
// opens the folder there and makes it the default. The default is the last one picked
// while it is installed, else the first installed in EDITORS' order, else Finder.
// A space on another machine (`hc machine`) is left alone: its folders aren't here.
//
// Installed (macOS): its command is on PATH, else its CLI is inside its app in
// ~/Applications or /Applications (Zed: the app's CLI first, OpenZFS has a `zed` too).
// Looked for at start and each time the menu opens. Icons come from the installed apps,
// cached once as 64 px PNGs in .icons/ here: a hidden folder, so writing them
// doesn't reload the mod. Without one, a </>.
// keys.json `global`: "cmd-shift-e": "open-in.open" (default editor), "open-in.menu".
//
// One mod, two roles: the bar (the layout block) and the menu (a popup it opens,
// props.menu). The bar copy does the launching: the popup hands it the pick through
// shared state and `open-in.pick`, because closing the popup cancels its tasks.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, home, nextCommand, notify, openOverlay, props, run, setShared, shared, spaces, theme } from "herdr";

const CODE = "mods/open-in/code.svg";
const CHEVRON = "mods/workspace-chrome/chevron-down.svg";
const CHECK = "mods/workspace-chrome/check.svg";
const ICONS = "mods/open-in/.icons";
const DEFAULT = "open-in.editor"; // the default editor's id
const FOUND = "open-in.found";    // the last lookup: [{ id, cli, app, icon }], Finder last
const PICK = "open-in.pick";      // a menu pick for the bar copy: { id, dir, n }
// Whether the menu is open, for the chevron's toggle. Module state is shared by copies; the
// menu copy sets it in init and clears it in close(). A click beside a popup closes it before
// the bar sees the click, so a press just after it closed counts as "was open" too.
const menuState = { open: false, closedAt: 0 };

// cmds: PATH names (the first is the CLI's name in the app); apps: bundle names (default: label).
// vscode-style apps keep their CLI in Contents/Resources/app/bin; JetBrains' is Contents/MacOS/<cmd>.
const jb = (id, label, apps) => ({ id, label, cmds: [id], apps, jb: true });
const EDITORS = [
  { id: "cursor", label: "Cursor", cmds: ["cursor"], args: ["--classic"] }, // the IDE even with the Agents window up
  { id: "trae", label: "Trae", cmds: ["trae"] },
  { id: "kiro", label: "Kiro", cmds: ["kiro"] },
  { id: "vscode", label: "VS Code", cmds: ["code"], apps: ["Visual Studio Code"] },
  { id: "vscode-insiders", label: "VS Code Insiders", cmds: ["code-insiders"], apps: ["Visual Studio Code - Insiders"] },
  { id: "vscodium", label: "VSCodium", cmds: ["codium"] },
  { id: "zed", label: "Zed", cmds: ["zed", "zeditor"], zed: true },
  { id: "antigravity", label: "Antigravity", cmds: ["antigravity-ide", "agy-ide"], apps: ["Antigravity IDE"] }, // Antigravity.app is the Hub
  jb("idea", "IntelliJ IDEA", ["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"]),
  jb("aqua", "Aqua"), jb("clion", "CLion"), jb("datagrip", "DataGrip"), jb("dataspell", "DataSpell"),
  jb("goland", "GoLand"), jb("phpstorm", "PhpStorm"), jb("pycharm", "PyCharm", ["PyCharm", "PyCharm CE"]),
  jb("rider", "Rider", ["Rider", "JetBrains Rider"]), jb("rubymine", "RubyMine"), jb("rustrover", "RustRover"),
  jb("webstorm", "WebStorm"),
];
const FINDER = { id: "finder", label: "Finder", cli: null, app: "/System/Library/CoreServices/Finder.app" };
const byId = (id) => (id === "finder" ? FINDER : EDITORS.find((e) => e.id === id));

// The folder to open, and the machine it is on (null: this computer).
function target() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  return { dir: f?.cwd || space?.folder || home(), machine: space?.machine ?? null };
}
const tilde = (p) => (p === home() ? "~" : p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);

// The installed editors, Finder last, from the last lookup; the default among them.
function editors() {
  const found = Array.isArray(shared(FOUND)) ? shared(FOUND) : [];
  const list = found.filter((f) => f.id !== "finder" && byId(f.id)).map((f) => ({ ...byId(f.id), ...f }));
  return [...list, { ...FINDER, ...found.find((f) => f.id === "finder") }];
}
const current = (list) => list.find((e) => e.id === shared(DEFAULT)) ?? list[0];

const sh = (script, args, timeout = 10000) => exec("sh", ["-c", script, "sh", ...args], { timeout });
const lines = (r) => r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
const appOf = (p) => /^(.*?\.app)\//.exec(p ?? "")?.[1] ?? null;

// Finds the installed editors: two shell calls, plus `zed --version` when only a PATH zed is left.
async function lookup() {
  const roots = [`${home()}/Applications`, "/Applications"];
  const toolbox = `${home()}/Library/Application Support/JetBrains/Toolbox/scripts`;
  const scan = lines(await sh(
    `for d in "$1" "$2"; do for b in "$d"/*.app; do [ -d "$b" ] && printf 'app\t%s\n' "$b"; done; done; shift 2
     for c; do p=$(command -v "$c" 2>/dev/null) && case $p in /*) printf 'cmd\t%s\t%s\n' "$c" "$p";; esac; done`,
    [...roots, ...new Set(EDITORS.flatMap((e) => e.cmds))]));
  const bundles = scan.filter((l) => l[0] === "app").map((l) => l[1]);
  const onPath = new Map(scan.filter((l) => l[0] === "cmd").map((l) => [l[1], l[2]]));
  const icon = (id) => `${appHome()}/${ICONS}/${id}.png`;

  // Each editor's candidate CLIs, in order: [path, app it belongs to (if known), from PATH].
  const plans = EDITORS.map((e) => {
    const names = e.apps ?? [e.label];
    // "PyCharm.app", or Toolbox's versioned "PyCharm 2024.3.app".
    const apps = bundles.filter((b) => names.some((n) => {
      const name = b.slice(b.lastIndexOf("/") + 1);
      return name === `${n}.app` || (name.startsWith(`${n} `) && /^\d[\d.]*\.app$/.test(name.slice(n.length + 1)));
    }));
    const inApps = apps.flatMap((a) => (e.zed ? [`${a}/Contents/MacOS/cli`] : e.jb ? [`${a}/Contents/MacOS/${e.cmds[0]}`]
      : [`${a}/Contents/Resources/app/bin/${e.cmds[0]}`, `${a}/Contents/Resources/app/bin/code`]).map((c) => [c, a, false]));
    const path = e.cmds.filter((c) => onPath.has(c)).map((c) => [onPath.get(c), null, true]);
    const extra = e.jb ? [[`${toolbox}/${e.cmds[0]}`, null, false]] : [];
    return { e, apps, cands: e.zed ? [...inApps, ...path] : [...path, ...inApps, ...extra] };
  });
  const files = [...new Set(plans.flatMap((p) => p.cands.map((c) => c[0])))];
  const ids = [...EDITORS.map((e) => e.id), "finder"];
  const seen = lines(await sh(
    `for a; do case $a in
       f:*) f=\${a#f:}; [ -f "$f" ] && [ -x "$f" ] && printf 'f\t%s\t%s\n' "$f" "$(realpath "$f" 2>/dev/null)";;
       i:*) [ -s "\${a#i:}" ] && printf 'i\t%s\n' "\${a#i:}";;
     esac; done`,
    [...files.map((f) => `f:${f}`), ...ids.map((id) => `i:${icon(id)}`)]));
  const real = new Map(seen.filter((l) => l[0] === "f").map((l) => [l[1], l[2] || l[1]]));
  const cached = new Set(seen.filter((l) => l[0] === "i").map((l) => l[1]));

  const found = [];
  for (const { e, apps, cands } of plans) {
    for (const [cli, app, fromPath] of cands) {
      if (!real.has(cli)) continue;
      if (e.zed && fromPath) {
        const v = await exec(cli, ["--version"], { timeout: 3000 }).catch(() => null);
        if (!v || v.code !== 0 || !v.stdout.startsWith("Zed")) continue;
      }
      found.push({ id: e.id, cli, app: app ?? appOf(real.get(cli)) ?? apps[0] ?? null, icon: cached.has(icon(e.id)) });
      break;
    }
  }
  return [...found, { id: "finder", cli: null, app: FINDER.app, icon: cached.has(icon("finder")) }];
}

// The app's icon as a 64 px PNG in .icons/ (NSWorkspace through JXA, then sips).
const JXA = `function run(a) { ObjC.import("AppKit");
  var img = $.NSWorkspace.sharedWorkspace.iconForFile(a[0]);
  var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(a[1], true); }`;
async function extractIcon(app, id) {
  const r = await sh(
    `t=$(mktemp -t open-in) || exit 1; mkdir -p "$(dirname "$3")" && osascript -l JavaScript -e "$1" "$2" "$t" >/dev/null &&
     sips -Z 64 "$t" --out "$3" >/dev/null; s=$?; rm -f "$t"; exit $s`,
    [JXA, app, `${appHome()}/${ICONS}/${id}.png`], 20000);
  return r.code === 0;
}

// The command that opens `dir` in editor `e`. JetBrains' app binary would stay running: `open -a` it.
function command(e, dir) {
  if (e.id === "finder") return ["open", [dir]];
  if (byId(e.id)?.jb && e.app && e.cli.startsWith(`${e.app}/`)) return ["open", ["-a", e.app, dir]];
  return [e.cli, [...(byId(e.id)?.args ?? []), dir]];
}

// The menu: as tall as its rows (up to MAX_H, then the rows scroll), WIDTH wide.
const WIDTH = 240, MAX_H = 420;
const HEAD = 24; // the "Open ~/x in" line
const menuHeight = (rows) => Math.min(MAX_H, 10 + HEAD + rows * 31 + (rows > 1 ? 9 : 0));

// Where the menu opens: just above the split button, inside the window. `a` is the button's
// window-relative box from the last press or hover over it; without one, at the pointer.
function menuAt(a, height) {
  if (!a) return "pointer";
  let vw = Infinity;
  try { vw = window.viewport_size().width; } catch {}
  return { x: Math.max(4, Math.min(a.x, vw - WIDTH - 4)), y: Math.max(4, a.y - height - 4) };
}
// The element's box from a mouse event: position is window-relative, local_position element-relative.
const boxOf = (ev) => (ev?.local_position && ev.bounds
  ? { x: ev.position.x - ev.local_position.x, y: ev.position.y - ev.local_position.y, width: ev.bounds.width, height: ev.bounds.height }
  : null);

function iconOf(e, size, color) {
  return e.icon ? image(`${ICONS}/${e.id}.png`).w(size).h(size).flex_none() : svg(CODE).size(size - 2).flex_none().text_color(color);
}

export default class OpenIn extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.menu = Boolean(p.menu);
    this.dir = p.dir ?? null;
    this.busy = false;
    this.pending = null; // the latest request made during a launch: { e, dir }, run after it
    this.anchor = null;  // the split button's box, for placing the menu
    this.atId = null;    // the menu's highlighted editor, by id: a lookup may add rows above it
    this.failed = new Set(); // icons that couldn't be read, not retried this run
    if (this.menu) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.scroll = ScrollHandle.new();
      const list = editors();
      menuState.open = true;
      this.atId = current(list).id;
      this.scroll.scroll_to_item(this.row(list));
    }
    if (checking()) return;
    this.refresh(cx);
    if (this.menu) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "open") this.openDefault(cx, true);
        else if (c === "menu") this.toggleMenu();
        else if (c === "pick") this.takePick(cx);
      }
    });
  }

  // Looks again, shares what it found, and caches the icons still missing.
  refresh(cx) {
    cx.spawn(async (cx) => {
      let found;
      try {
        found = await lookup();
      } catch (e) {
        console.log(`open-in: lookup failed: ${e}`);
        return;
      }
      if (JSON.stringify(found) !== JSON.stringify(shared(FOUND))) setShared(FOUND, found);
      for (const f of found) {
        if (f.icon || !f.app || this.failed.has(f.id)) continue;
        if (!(await extractIcon(f.app, f.id).catch(() => false))) { this.failed.add(f.id); continue; }
        const now = Array.isArray(shared(FOUND)) ? shared(FOUND) : found;
        setShared(FOUND, now.map((g) => (g.id === f.id ? { ...g, icon: true } : g)));
      }
      cx.notify();
    });
  }

  openDefault(cx, fromKey) {
    const { dir, machine } = target();
    if (machine) {
      if (fromKey) notify({ title: "Not opened", body: `${tilde(dir)} is on ${machine}: editors open folders on this computer.`, timeout: 4000 });
      return;
    }
    this.launch(cx, current(editors()), dir);
  }

  async close() {
    if (this.menu) Object.assign(menuState, { open: false, closedAt: Date.now() });
  }

  // The chevron and `open-in.menu`: close the menu if it is (or just was) open, else open it.
  toggleMenu(wasOpen = menuState.open) {
    if (!wasOpen) return this.openMenu();
    if (menuState.open && this.menuId) closeOverlay(this.menuId);
  }

  openMenu() {
    const { dir, machine } = target();
    if (machine) return;
    // Sized for the last lookup; the menu copy looks again, and extra rows scroll.
    const height = menuHeight(editors().length);
    this.menuId = openOverlay({ mod: "open-in", kind: "popup", width: WIDTH, height, at: menuAt(this.anchor, height), props: { menu: true, dir, height } });
  }

  takePick(cx) {
    const p = shared(PICK);
    if (!p || p.n === this.lastPick || Date.now() - p.n > 10000) return;
    this.lastPick = p.n;
    setShared(PICK, null);
    const e = editors().find((x) => x.id === p.id);
    if (e) this.launch(cx, e, p.dir);
  }

  launch(cx, e, dir) {
    if (this.busy) { this.pending = { e, dir }; return; } // the latest wins; runs when this one ends
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const [cmd, args] = command(e, dir);
      let problem = null;
      try {
        const r = await exec(cmd, args, { timeout: 15000 });
        if (r.code !== 0) {
          console.log(`open-in: ${cmd} ${args.join(" ")} exited with ${r.code}: ${r.stderr.trim()}`);
          const gone = (await exec("test", ["-d", dir]).catch(() => null))?.code === 1;
          problem = gone ? `${tilde(dir)} doesn't exist any more.` : `${e.label} couldn't open ${tilde(dir)} (exit code ${r.code}).`;
        }
      } catch (err) {
        // exec rejects on a timeout ("… took longer than 15 s and was stopped") and when the
        // program can't start ("cannot run …"); only a missing program means the editor is gone.
        console.log(`open-in: ${cmd} failed: ${err}`);
        const check = cmd.startsWith("/") ? ["-x", cmd] : cmd === "open" && args[0] === "-a" ? ["-d", args[1]] : null;
        const there = !check || (await exec("test", check).catch(() => null))?.code === 0;
        if (/took longer than .* was stopped/.test(String(err?.message ?? err))) problem = `${e.label} didn't respond in time.`;
        else if (there) problem = `${e.label} couldn't be started.`;
        else {
          problem = `${e.label} isn't installed any more, or its command line tool moved. Pick another editor.`;
          this.refresh(cx);
        }
      }
      if (problem) notify({ title: `Couldn't open in ${e.label}`, body: problem, level: "error" });
      this.busy = false;
      cx.notify();
      const next = this.pending;
      this.pending = null;
      if (next) this.launch(cx, next.e, next.dir);
    });
  }

  // ---- the menu popup ----

  pick(e) {
    setShared(DEFAULT, e.id);
    setShared(PICK, { id: e.id, dir: this.dir, n: Date.now() });
    run("open-in.pick");
    closeOverlay(props().overlay);
  }

  // The highlighted row in `list`: the remembered editor's, else the default's.
  row(list) {
    const i = list.findIndex((e) => e.id === this.atId);
    return i >= 0 ? i : Math.max(0, list.findIndex((e) => e.id === current(list).id));
  }

  renderMenu() {
    const t = theme();
    const list = editors();
    const on = current(list).id;
    const at = this.row(list);
    // Explicit heights: inside a popup a flex_1 list lays out at zero.
    const height = props()?.height ?? menuHeight(list.length);
    return v_flex().id("menu").track_focus(this.handle).w_full().h(height).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((ev, cx) => {
        const now = editors(), i = this.row(now);
        if (ev.key === "down") this.atId = now[(i + 1) % now.length].id;
        else if (ev.key === "up") this.atId = now[(i + now.length - 1) % now.length].id;
        else if (ev.key === "enter") return this.pick(now[i]);
        else if (ev.key === "escape") return closeOverlay(props().overlay);
        else return;
        this.scroll.scroll_to_item(this.row(now));
        cx.notify();
      })
      .child(div().flex_none().h(HEAD).px(8).pt(4).text_size(11).text_color(t.dim).truncate().child(`Open ${tilde(this.dir ?? home())} in`))
      // The rows scroll when a lookup finds more editors than the popup was sized for.
      .child(v_flex().id("rows").h(height - 10 - HEAD).overflow_y_scrollbar().track_scroll(this.scroll).children(list.map((e, i) => v_flex().flex_none()
        .when(e.id === "finder" && i > 0, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`row-${e.id}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(e))
          .child(iconOf(e, 16, t.muted))
          .child(div().flex_1().truncate().child(e.label))
          .when(e.id === on, (el) => el.child(svg(CHECK).size(14).flex_none().text_color(t.foreground)))))));
  }

  render() {
    if (this.menu) return this.renderMenu();
    const t = theme();
    const { dir, machine } = target();
    const e = current(editors());
    const off = Boolean(machine) || this.busy;
    const away = `${tilde(dir)} is on ${machine}: editors open folders on this computer`;
    const part = (id) => h_flex().id(id).h(22).items_center().justify_center().when(!off, (el) => el.hover((s) => s.bg(t.hover)));
    return h_flex().id("root").size_full().items_center().justify_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("split").items_center().rounded(5)
        .on_mouse_down("left", (ev) => { this.anchor = boxOf(ev) ?? this.anchor; })
        .on_mouse_move((ev) => { this.anchor = boxOf(ev) ?? this.anchor; }).overflow_hidden()
        .child(part("open").w(24)
          .tooltip(machine ? away : `Open ${tilde(dir)} in ${e.label}`)
          .on_click((_ev, cx) => !machine && this.openDefault(cx, false))
          .child(iconOf(e, 15, t.muted).opacity(off ? 0.4 : 1)))
        .child(part("pick").w(15)
          .tooltip(machine ? away : "Open in…")
          .on_mouse_down("left", () => { this.wasOpen = menuState.open || Date.now() - menuState.closedAt < 300; })
          .on_click(() => this.toggleMenu(this.wasOpen))
          .child(svg(CHEVRON).size(11).text_color(off ? t.dim : t.muted))));
  }
}

// Names tabs nobody named, with real names (tab.rename), so Herdr's own tab bar,
// the Agents list and other devices all show them:
// - an agent's tab: the agent's title ("Fix the flaky login test"), without the
//   status glyphs agents put in front ("✳ ", "◑ ", spinners);
// - otherwise the program and where it runs ("nvim · my-app"), or the folder for
//   a shell.
// It only ever changes names it set itself: a tab you rename is left alone, and
// renaming one to "" hands it back to this mod.
import { View, div } from "gpui-kit";
import { spaces, panes, run, home, machines } from "herdr";

const EVERY = 2000; // ms between passes
const STEADY = 2; // passes a new name must hold before it is applied (titles flicker)
const GENERIC = ["claude code", "claude", "pi", "codex", "hermes", "agy", "antigravity", "terminal"];

const folderOf = (cwd) => (cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "/" : "");
const cleanTitle = (title) =>
  (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim().slice(0, 60);
const isGeneric = (title, program) => {
  if (!title) return true;
  const low = title.toLowerCase();
  const names = [program.name, program.key, ...GENERIC].filter(Boolean).map((n) => n.toLowerCase());
  // Match bare names or shell command lines with CLI flags ("agy -c", "claude --resume"),
  // without treating titles like "Claude - fix auth" as flags.
  return names.some((n) => low === n || (low.startsWith(`${n} `) && /^-[-\p{L}\p{N}]/u.test(low.slice(n.length + 1).trimStart())));
};

function autoName(tabId) {
  const own = panes().filter((p) => p.tab === tabId && p.terminal);
  const lead = own.find((p) => p.program?.agent) ?? own.find((p) => p.focused) ?? own[0];
  if (!lead) return null;
  const program = lead.program;
  const where = lead.cwd === home() ? "~" : folderOf(lead.cwd);
  if (program?.agent) {
    const title = cleanTitle(lead.title);
    if (!isGeneric(title, program)) return title;
  }
  if (program?.shell) return where || program.name;
  return where ? `${program?.name ?? "Terminal"} · ${where}` : program?.name ?? "Terminal";
}

export default class TabNamer extends View {
  init(_props, cx) {
    this.owned = JSON.parse(localStorage.getItem("owned") ?? "{}"); // tab id -> the name we gave it
    this.pending = {}; // tab id -> { name, seen }
    cx.timer.every(EVERY, () => this.pass());
    this.pass();
  }

  save() {
    localStorage.setItem("owned", JSON.stringify(this.owned));
  }

  pass() {
    const live = new Set();
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        live.add(tab.id);
        const ours = this.owned[tab.id];
        if (tab.named && ours !== tab.name) {
          // Someone else named it: hands off.
          if (ours !== undefined) { delete this.owned[tab.id]; this.save(); }
          continue;
        }
        const name = autoName(tab.id);
        if (!name || (tab.named && name === tab.name)) { delete this.pending[tab.id]; continue; }
        const p = this.pending[tab.id];
        if (p?.name === name) p.seen += 1; else this.pending[tab.id] = { name, seen: 1 };
        if (this.pending[tab.id].seen < STEADY) continue;
        delete this.pending[tab.id];
        this.owned[tab.id] = name;
        this.save();
        run("tab.rename", { id: tab.id, name });
      }
    }
    // Forget closed tabs, but only on machines whose layout is readable now:
    // a machine that is still connecting or offline lists no tabs at all.
    const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
    const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : "");
    let changed = false;
    for (const id of Object.keys(this.owned)) {
      if (!live.has(id) && ready.has(machineOf(id))) { delete this.owned[id]; changed = true; }
    }
    if (changed) this.save();
  }

  render() {
    return div();
  }
}

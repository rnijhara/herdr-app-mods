// Templates: browse, create, edit and delete herdr-core (hc) templates in
// ~/.config/herdr-core/templates/*.md right from Herdr.
// Opened as a dialog (`mod.open templates`, or from the sidebar footer via
// mod-patches' workspace-chrome-synced).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { checking, closeOverlay, exec, home, notify, props, readTextFile, settings, theme, watchFolder, writeTextFile } from "herdr";

const ICON = "mods/templates/templates.svg";
const SEARCH = "mods/workspace-chrome/search.svg";
const CHECK = "mods/workspace-chrome/check.svg";
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const templatesDir = () => `${home()}/.config/herdr-core/templates`;
const tilde = (p) => (p === home() ? "~" : p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);
const mono = () => settings().font_family ?? settings().font ?? "JetBrains Mono";

// Parses YAML-ish frontmatter (`--- ... ---`) at the top of an hc template.
function parseTemplate(text) {
  const src = String(text ?? "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { valid: false, name: "", description: "", command: "", body: src };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[kv[1].toLowerCase()] = val;
  }
  return {
    valid: Boolean(fields.command),
    name: fields.name ?? "",
    description: fields.description ?? "",
    command: fields.command ?? "",
    body: src.slice(m[0].length),
  };
}

// Short badge for the sidebar row based on the template's command.
function agentBadge(command) {
  const c = String(command ?? "");
  if (!c) return null;
  if (/(^|[\s/])agy(\s|$)/.test(c)) return "agy";
  if (/(^|[\s/])claude(\s|$)/.test(c)) return "claude";
  if (/(^|[\s/])codex(\s|$)/.test(c)) return "codex";
  if (/(^|[\s/])opencode(\s|$)/.test(c)) return "opencode";
  if (/(^|[\s/])pi(\s|$)/.test(c)) return "pi";
  const first = c.replace(/^env\s+(?:\S+=\S+\s+)*/, "").trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() || null;
}

function starterContent(name) {
  return `---
description: ${name} worker.
command: claude --model 'opus[1m]' --effort high
---
You are a worker agent started by a lead agent through herdr-core (hc).

Rules:
- Work only within the scope the task gives you.
- When you finish, or get stuck, report to the lead: use your shell tool to EXECUTE \`hc send <lead> "<message>"\`, where <lead> is the address in the reach attribute of the <hc> tag that delivered this task.
- Start the message with RESULT: (changed files, what you verified, remaining risk) or BLOCKED: (exact blocker, evidence, the decision you need).
- After reporting, stay open for follow-up messages.
`;
}

async function listTemplateFiles(dir) {
  const r = await exec("sh", [
    "-c",
    '[ -d "$1" ] || exit 0; for f in "$1"/*.md; do [ -f "$f" ] && printf "%s\\n" "${f##*/}"; done',
    "sh",
    dir,
  ]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not list templates");
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
}

export default class Templates extends View {
  init(_props, cx) {
    this.dir = templatesDir();
    this.items = [];        // [{ file, name, path, raw, meta }]
    this.loading = true;
    this.error = null;
    this.selected = null;   // filename, e.g. "neon.md"
    this.snapshot = null;   // exact disk content of the loaded file (for compare-and-swap)
    this.draft = "";        // current editor text
    this.dirty = false;
    this.externalChange = false;
    this.saving = false;
    this.savedAt = 0;
    this.copiedAt = 0;
    this.confirmDelete = false;
    this.creating = false;
    this.createError = null;
    this.filter = "";
    this.filterFocused = false;
    this.newNameFocused = false;
    this.editor = null;
    this.watch = null;

    this.handle = cx.focus_handle();
    this.filterInput = InputState.new({ placeholder: "Filter templates…" });
    this.filterInput.on("change", (_e, cx) => {
      this.filter = this.filterInput.value();
      cx.notify();
    });
    this.filterInput.on("focus", (_e, cx) => { this.filterFocused = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filterFocused = false; cx.notify(); });

    this.newNameInput = InputState.new({ placeholder: "template-name" });
    this.newNameInput.on("change", (_e, cx) => { this.createError = null; cx.notify(); });
    this.newNameInput.on("submit", (_e, cx) => this.createTemplate(cx));
    this.newNameInput.on("focus", (_e, cx) => { this.newNameFocused = true; cx.notify(); });
    this.newNameInput.on("blur", (_e, cx) => { this.newNameFocused = false; cx.notify(); });

    if (checking()) {
      this.loading = false;
      return;
    }

    this.handle.focus();
    this.reload(cx, { select: props()?.select ?? null, selectFirst: true });
    this.startWatch(cx);
  }

  async close() {
    this.watch?.cancel();
    this.watch = null;
    this.editor?.release();
    this.editor = null;
    this.filterInput?.release();
    this.newNameInput?.release();
    this.handle?.release();
  }

  startWatch(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          this.watch = watchFolder(this.dir);
          const changed = await this.watch;
          if (!changed?.length) break;
          this.reload(cx, { fromWatch: true });
        } catch {
          await cx.sleep(5000);
        }
      }
    });
  }

  reload(cx, opts = {}) {
    cx.spawn(async (cx) => {
      try {
        const files = await listTemplateFiles(this.dir);
        const loaded = [];
        for (const file of files) {
          const path = `${this.dir}/${file}`;
          const raw = (await readTextFile(path).catch(() => null)) ?? "";
          loaded.push({
            file,
            name: file.slice(0, -3),
            path,
            raw,
            meta: parseTemplate(raw),
          });
        }
        this.items = loaded;
        this.error = null;
        this.loading = false;

        const want = opts.select ?? this.selected;
        const found = want ? loaded.find((x) => x.file === want) : null;
        if (found) {
          if (opts.fromWatch && this.dirty) {
            if (found.raw !== this.snapshot) this.externalChange = true;
          } else if (opts.forceEditor || found.raw !== this.snapshot || !this.editor) {
            this.openItem(found, cx);
          }
        } else if (loaded.length && (opts.selectFirst || !this.dirty)) {
          this.openItem(loaded[0], cx);
        } else if (!loaded.length) {
          this.clearSelection();
        }
      } catch (e) {
        this.loading = false;
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  clearSelection() {
    this.selected = null;
    this.snapshot = null;
    this.draft = "";
    this.dirty = false;
    this.externalChange = false;
    this.confirmDelete = false;
    this.editor?.release();
    this.editor = null;
  }

  openItem(item, cx) {
    this.selected = item.file;
    this.snapshot = item.raw;
    this.draft = item.raw;
    this.dirty = false;
    this.externalChange = false;
    this.confirmDelete = false;
    this.savedAt = 0;

    const t = theme();
    this.editor?.release();
    this.editor = EditorState.new({
      language: "markdown",
      value: item.raw,
      readonly: false,
      line_numbers: true,
      folding: false,
      soft_wrap: true,
      font_family: mono(),
      font_size: 12.5,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
    this.editor.on("change", (_e, cx) => {
      if (!this.editor) return;
      this.draft = this.editor.value();
      this.dirty = this.draft !== this.snapshot;
      this.confirmDelete = false;
      cx.notify();
    });
    cx.notify();
  }

  selectFile(file, cx) {
    if (file === this.selected) return;
    const item = this.items.find((x) => x.file === file);
    if (!item) return;
    if (this.dirty) {
      // Save-safe: let the user revert or save first, or click again to discard.
      if (this.discardTarget !== file) {
        this.discardTarget = file;
        notify({ title: "Unsaved changes", body: `Save ${this.selected} (⌘S) or click ${item.name} again to discard.`, level: "warning", timeout: 4000 });
        cx.notify();
        return;
      }
    }
    this.discardTarget = null;
    this.openItem(item, cx);
  }

  save(cx, { force = false } = {}) {
    if (!this.selected || !this.editor || this.saving) return;
    const file = this.selected;
    const path = `${this.dir}/${file}`;
    const text = this.editor.value();
    const expected = force ? undefined : this.snapshot;
    this.saving = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", this.dir]);
        const currentDisk = force ? await readTextFile(path).catch(() => null) : expected;
        await writeTextFile(path, text, currentDisk);
        this.snapshot = text;
        this.draft = text;
        this.dirty = false;
        this.externalChange = false;
        this.discardTarget = null;
        this.savedAt = Date.now();
        this.items = this.items.map((it) => (it.file === file ? { ...it, raw: text, meta: parseTemplate(text) } : it));
        cx.timer.after(2200, (cx) => {
          if (Date.now() - this.savedAt >= 2000) { this.savedAt = 0; cx.notify(); }
        });
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/stale|changed|mismatch|expected/i.test(msg)) {
          this.externalChange = true;
          notify({ title: "File changed on disk", body: `${file} changed outside Herdr. Reload or click Force save.`, level: "warning", timeout: 6000 });
        } else {
          notify({ title: `Couldn't save ${file}`, body: msg, level: "error" });
        }
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  revert(cx) {
    if (!this.selected || this.snapshot === null) return;
    const item = this.items.find((x) => x.file === this.selected);
    if (item) this.openItem(item, cx);
  }

  startCreate(cx) {
    this.creating = true;
    this.createError = null;
    this.newNameInput.set_value("");
    this.newNameInput.focus();
    cx.timer.after(80, () => this.newNameInput.focus());
    cx.notify();
  }

  cancelCreate(cx) {
    this.creating = false;
    this.createError = null;
    this.handle.focus();
    cx.notify();
  }

  createTemplate(cx) {
    const rawName = this.newNameInput.value().trim().replace(/\.md$/i, "");
    if (!rawName) { this.createError = "Enter a name"; cx.notify(); return; }
    if (!VALID_NAME.test(rawName)) { this.createError = "Letters, numbers, ., -, _ only"; cx.notify(); return; }
    const file = `${rawName}.md`;
    if (this.items.some((x) => x.file === file)) { this.createError = `${rawName} already exists`; cx.notify(); return; }

    const path = `${this.dir}/${file}`;
    const body = starterContent(rawName);
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", this.dir]);
        await writeTextFile(path, body, null);
        this.creating = false;
        this.createError = null;
        this.reload(cx, { select: file, forceEditor: true });
      } catch (e) {
        this.createError = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  deleteSelected(cx) {
    if (!this.selected) return;
    if (!this.confirmDelete) {
      this.confirmDelete = true;
      cx.notify();
      cx.timer.after(4000, (cx) => {
        if (this.confirmDelete) { this.confirmDelete = false; cx.notify(); }
      });
      return;
    }
    const file = this.selected;
    const path = `${this.dir}/${file}`;
    this.confirmDelete = false;
    cx.spawn(async (cx) => {
      const r = await exec("rm", ["-f", path]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        notify({ title: `Couldn't delete ${file}`, body: r.stderr || "rm failed", level: "error" });
        cx.notify();
        return;
      }
      this.clearSelection();
      this.reload(cx, { selectFirst: true });
    });
  }

  copyRunCommand(name, cx) {
    const cmd = `hc run --bg --name ${name} ${name} "<task>"`;
    cx.write_to_clipboard(cmd);
    this.copiedAt = Date.now();
    cx.notify();
    cx.timer.after(1800, (cx) => {
      if (Date.now() - this.copiedAt >= 1700) { this.copiedAt = 0; cx.notify(); }
    });
  }

  closeDialog() {
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const q = this.filter.trim().toLowerCase();
    const visible = this.items.filter((it) =>
      !q || it.name.toLowerCase().includes(q) || it.meta.description.toLowerCase().includes(q) || it.meta.command.toLowerCase().includes(q),
    );
    const active = this.items.find((it) => it.file === this.selected) ?? null;
    const liveMeta = active ? parseTemplate(this.draft) : null;

    const btn = (id, label, style, action, disabled = false) => {
      const bg = style === "primary" ? t.solid : style === "danger" ? t.ansi1 : t.raised;
      const fg = style === "primary" ? t.solid_foreground : style === "danger" ? "#ffffff" : t.foreground;
      const border = style === "primary" ? t.solid : style === "danger" ? t.ansi1 : t.input;
      return h_flex().id(id).h(28).px(11).items_center().justify_center().rounded(7).flex_none()
        .border_1().border_color(border).bg(bg).text_color(fg).text_size(12).font_medium()
        .when(disabled, (el) => el.opacity(0.4))
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
        .child(label);
    };

    const listRow = (it) => {
      const on = it.file === this.selected;
      const meta = on && liveMeta ? liveMeta : it.meta;
      const badge = agentBadge(meta.command);
      return v_flex().id(`tpl-${it.file}`).px(9).py(7).gap(2).rounded(7).flex_none().cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => this.selectFile(it.file, cx))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_semibold().text_color(on ? t.foreground : t.muted).child(it.name))
          .when(on && this.dirty, (el) => el.child(div().size(6).rounded_full().flex_none().bg(t.accent)))
          .when(Boolean(badge), (el) => el.child(div().px(5).py(1).rounded(4).flex_none().bg(on ? t.raised : t.background).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child(badge))))
        .child(div().truncate().text_size(11.3).text_color(t.dim).child(meta.description || meta.command || "No description"));
    };

    return v_flex()
      .id("templates-dialog")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if ((e.modifiers.platform || e.modifiers.control) && e.key === "s") {
          cx.stop_propagation();
          this.save(cx);
          return;
        }
        if (e.key === "escape") {
          cx.stop_propagation();
          if (this.creating) this.cancelCreate(cx);
          else if (this.confirmDelete) { this.confirmDelete = false; cx.notify(); }
          else this.closeDialog();
        }
      })
      // Top header
      .child(h_flex().h(46).flex_none().px(14).gap(9).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON).size(15).flex_none().text_color(t.accent))
        .child(div().text_size(14).font_semibold().child("Templates"))
        .child(div().px(6).py(1).rounded(8).bg(t.raised).text_size(11).text_color(t.muted).child(String(this.items.length)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(tilde(this.dir)))
        .child(btn("tpl-new", "+ New", "secondary", (_e, cx) => this.startCreate(cx)))
        .child(div().id("tpl-esc").px(7).py(3).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.closeDialog())
          .child("Esc")))
      // Body: sidebar + editor
      .child(h_flex().flex_1().min_h(0)
        // Left list
        .child(v_flex().w(244).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
          .child(h_flex().h(34).flex_none().mx(8).mt(8).mb(4).px(8).gap(6).items_center().rounded(7)
            .border_1().border_color(this.filterFocused ? t.accent : t.border).bg(t.background)
            .child(svg(SEARCH).size(13).flex_none().text_color(t.dim))
            .child(Input.new(this.filterInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
          .when(this.creating, (el) => el.child(v_flex().mx(8).my(4).p(8).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.accent)
            .child(div().text_size(11).font_medium().text_color(t.muted).child("New template (.md)"))
            .child(Input.new(this.newNameInput).h(28).px(8).rounded(6).border_1().border_color(this.newNameFocused ? t.accent : t.input).bg(t.background).text_size(12.3).text_color(t.foreground))
            .when(Boolean(this.createError), (e2) => e2.child(div().text_size(11).text_color(t.ansi1).child(this.createError)))
            .child(h_flex().gap(6).justify_end()
              .child(btn("tpl-create-cancel", "Cancel", "secondary", (_e, cx) => this.cancelCreate(cx)))
              .child(btn("tpl-create-ok", "Create", "primary", (_e, cx) => this.createTemplate(cx))))))
          .child(v_flex().id("tpl-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
            .children(visible.map(listRow))
            .when(this.loading, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("Loading templates…")))
            .when(!this.loading && Boolean(this.error), (el) => el.child(div().p(10).text_size(12).text_color(t.ansi1).child(this.error)))
            .when(!this.loading && !this.error && visible.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(q ? "No matching templates" : "No templates yet. Click + New.")))))
        // Right detail / editor
        .child(active
          ? v_flex().flex_1().min_w(0).h_full().bg(t.background)
              // Metadata summary header
              .child(v_flex().flex_none().px(14).py(10).gap(6).bg(t.surface).border_b(1).border_color(t.border)
                .child(h_flex().gap(8).items_center()
                  .child(div().text_size(14).font_semibold().text_color(t.foreground).child(active.name))
                  .child(div().text_size(11.5).text_color(t.dim).child(active.file))
                  .when(this.dirty, (el) => el.child(div().px(6).py(1).rounded(5).bg(t.blocked + "22").text_size(11).text_color(t.blocked).child("Unsaved")))
                  .when(!this.dirty && this.savedAt > 0, (el) => el.child(h_flex().gap(4).items_center().px(6).py(1).rounded(5).bg(t.ansi2 + "22").text_size(11).text_color(t.ansi2).child(svg(CHECK).size(11)).child("Saved")))
                  .when(liveMeta && !liveMeta.valid, (el) => el.child(div().px(6).py(1).rounded(5).bg(t.ansi1 + "22").text_size(11).text_color(t.ansi1).child("Missing command: in frontmatter")))
                  .child(div().flex_1())
                  .child(div().id("tpl-copy-run").px(8).h(24).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
                    .text_size(11.3).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Copy example hc run command")
                    .on_click((_e, cx) => this.copyRunCommand(active.name, cx))
                    .child(this.copiedAt > 0 ? "Copied hc run" : "Copy hc run")))
                .child(h_flex().gap(6).items_center().px(8).py(5).rounded(6).bg(t.background).border_1().border_color(t.border)
                  .child(div().text_size(11).text_color(t.dim).flex_none().child("command"))
                  .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11.5).text_color(liveMeta?.command ? t.foreground : t.dim)
                    .child(liveMeta?.command || "(none)")))
                .when(Boolean(liveMeta?.description), (el) => el.child(div().text_size(12).text_color(t.muted).truncate().child(liveMeta.description))))
              // External change banner
              .when(this.externalChange, (el) => el.child(h_flex().flex_none().px(14).py(7).gap(8).items_center().bg(t.blocked + "18").border_b(1).border_color(t.blocked + "40")
                .child(div().flex_1().text_size(12).text_color(t.blocked).child(`${active.file} changed on disk.`))
                .child(btn("tpl-reload-disk", "Reload from disk", "secondary", (_e, cx) => this.reload(cx, { select: active.file, forceEditor: true })))
                .child(btn("tpl-force-save", "Overwrite disk", "primary", (_e, cx) => this.save(cx, { force: true })))))
              // Editable Markdown source
              .child(this.editor
                ? Editor.new(this.editor).flex_1().min_h(0)
                : div().flex_1().p(16).text_size(12.5).text_color(t.dim).child("Loading…"))
              // Footer action bar
              .child(h_flex().h(44).flex_none().px(14).gap(8).items_center().bg(t.chrome).border_t(1).border_color(t.border)
                .child(btn("tpl-delete", this.confirmDelete ? "Confirm delete?" : "Delete", this.confirmDelete ? "danger" : "secondary", (_e, cx) => this.deleteSelected(cx)))
                .when(this.dirty, (el) => el.child(btn("tpl-revert", "Revert", "secondary", (_e, cx) => this.revert(cx))))
                .child(div().flex_1())
                .child(div().text_size(11.3).text_color(t.dim).child("⌘S to save"))
                .child(btn("tpl-save", this.saving ? "Saving…" : "Save", "primary", (_e, cx) => this.save(cx), !this.dirty || this.saving)))
          : v_flex().flex_1().items_center().justify_center().gap(8).p(24).bg(t.background)
              .child(svg(ICON).size(28).text_color(t.dim))
              .child(div().text_size(13.5).font_medium().text_color(t.muted).child(this.loading ? "Loading templates…" : "Select a template to inspect or edit"))
              .child(div().text_size(12).text_color(t.dim).child(`Templates live in ${tilde(this.dir)}`))));
  }
}

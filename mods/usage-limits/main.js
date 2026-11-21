// Claude Code, Codex and Antigravity (Google AI) plan limits in the status bar:
// "13% used 5d 22h · 21% used Fable", "12% used 2d 13h", and "2% used 6d 23h · 1% used Claude/GPT".
//
// Each tool's own sign-in on this computer is used, and each token goes only
// to its own provider: Claude Code's from the login keychain to api.anthropic.com,
// Codex's from ~/.codex/auth.json to chatgpt.com, and Antigravity's through `agy -p /usage`.
// Tokens are never stored.
// If a provider is signed out or an endpoint changes, its item shows "unavailable" with the reason on hover.
import { View, div, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { checking, exec, theme, home, readTextFile, run } from "herdr";

const EVERY = 5 * 60 * 1000; // ms between refreshes (click an item to refresh now)
const WARN = 80; // percent at which an item turns to the "blocked" color
const SHOW_SESSION_AT = 50; // the 5-hour window is shown once it's at least this full
const BLOCK = "usage-limits"; // this mod's block id in layouts/herdr-plus.json
const PAD = 8; // px each side of the items

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";

// "5d 22h", "2h 10m", "14m".
function left(resetMs) {
  const s = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

async function claude() {
  const user = home().split("/").pop();
  const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", user, "-w"], { timeout: 10000 });
  if (r.code !== 0) throw new Error("no Claude Code sign-in in the keychain");
  const token = JSON.parse(r.stdout)?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("no Claude Code sign-in in the keychain");
  const res = await fetch(CLAUDE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
  });
  if (!res.ok) throw new Error(res.status === 401 ? "signed out: open Claude Code once to refresh" : `HTTP ${res.status}`);
  const body = await res.json();
  // limits: [{ kind: "session" | "weekly_all" | "weekly_scoped", percent, resets_at, scope: { model: { display_name } } }]
  return (body.limits ?? []).map((l) => ({
    label: l.kind === "session" ? "5h" : l.kind === "weekly_all" ? "week" : l.scope?.model?.display_name ?? l.kind,
    kind: l.kind,
    percent: l.percent ?? 0,
    reset: l.resets_at ? Date.parse(l.resets_at) : null,
  }));
}

async function codex() {
  const auth = JSON.parse(await readTextFile(`${home()}/.codex/auth.json`));
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error("no Codex sign-in in ~/.codex/auth.json");
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "codex-cli", "OpenAI-Beta": "codex-1", originator: "Codex Desktop" };
  if (auth.tokens.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  const res = await fetch(CODEX_URL, { headers });
  if (!res.ok) throw new Error(res.status === 401 ? "signed out: open Codex once to refresh" : `HTTP ${res.status}`);
  const rl = (await res.json())?.rate_limit ?? {};
  return [rl.primary_window, rl.secondary_window].filter(Boolean).map((w) => {
    const weekly = (w.limit_window_seconds ?? 0) >= 6 * 86400;
    return { label: weekly ? "week" : "5h", kind: weekly ? "weekly_all" : "session", percent: w.used_percent ?? 0, reset: w.reset_at ? w.reset_at * 1000 : null };
  });
}

// Runs `agy -p /usage --output-format json` in a private temp dir with a failing `open`/`xdg-open`
// shim so a signed-out CLI can't pop open a browser tab (and stops immediately if it tries),
// and with auto-update disabled so passive refreshes don't trigger CLI updates.
const AGY_SCRIPT = [
  'bin=$(command -v agy 2>/dev/null)',
  'if [ -z "$bin" ]; then for p in /opt/homebrew/bin/agy /usr/local/bin/agy "$HOME/.local/bin/agy"; do [ -x "$p" ] && { bin=$p; break; }; done; fi',
  '[ -n "$bin" ] || exit 127',
  'd=$(mktemp -d) || exit 1',
  'trap \'[ -n "${pid:-}" ] && kill -TERM "$pid" 2>/dev/null; rm -rf "$d"\' EXIT INT TERM',
  'printf \'#!/bin/sh\\n: > "%s/auth"\\n[ -f "%s/pid" ] && kill -TERM $(cat "%s/pid") 2>/dev/null\\nexit 1\\n\' "$d" "$d" "$d" > "$d/open"',
  'chmod +x "$d/open" && ln -s "$d/open" "$d/xdg-open"',
  'cd "$d"',
  'AGY_CLI_DISABLE_AUTO_UPDATE=true BROWSER="$d/open" PATH="$d:$PATH" "$bin" -p /usage --output-format json < /dev/null > "$d/out" 2> "$d/err" &',
  'pid=$!; echo "$pid" > "$d/pid"; wait "$pid"; rc=$?',
  'if [ -f "$d/auth" ] || grep -qi "Authentication required" "$d/out" "$d/err" 2>/dev/null; then exit 42; fi',
  'cat "$d/out"; [ "$rc" -eq 0 ] || cat "$d/err" >&2; exit "$rc"',
].join("\n");

function parseAgyUsage(stdout) {
  const text = stdout.trim();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const line = text.split("\n").reverse().find((l) => l.trim().startsWith("{"));
    if (!line) throw new Error("unexpected output from agy");
    body = JSON.parse(line);
  }
  if (body?.status !== "SUCCESS" || body?.command?.name !== "usage") {
    throw new Error(body?.error || "agy returned no usage data");
  }
  const groups = body?.command?.data?.groups ?? [];
  if (!groups.length) throw new Error("no Antigravity quota data");
  const primary = groups.find((g) => /gemini/i.test(g.name ?? "") || (g.buckets ?? []).some((b) => /^gemini/i.test(b.id ?? ""))) ?? groups[0];
  const multi = groups.length > 1;
  const shortName = (name) => (/claude/i.test(name) && /gpt/i.test(name) ? "Claude/GPT" : name.replace(/\s+models?$/i, ""));
  const limits = [];
  for (const g of groups) {
    const isPrimary = g === primary;
    const prefix = isPrimary ? (multi ? "Gemini " : "") : shortName(g.name ?? "other");
    for (const b of g.buckets ?? []) {
      if (typeof b.remaining_fraction !== "number") continue;
      const weekly = b.window === "weekly" || /(?:^|-)weekly$/i.test(b.id ?? "");
      const fiveHour = b.window === "5h" || /(?:^|-)5h$/i.test(b.id ?? "");
      if (!weekly && !fiveHour) continue;
      const percent = Math.max(0, Math.min(100, Math.round((1 - b.remaining_fraction) * 100)));
      const parsed = b.reset_time ? Date.parse(b.reset_time) : NaN;
      const reset = Number.isFinite(parsed) ? parsed : null;
      if (isPrimary) {
        limits.push({ label: weekly ? `${prefix}week` : `${prefix}5h`, kind: weekly ? "weekly_all" : "session", percent, reset });
      } else {
        limits.push({ label: weekly ? prefix : `${prefix} 5h`, kind: weekly ? "weekly_scoped" : "session_scoped", percent, reset });
      }
    }
  }
  if (!limits.length) throw new Error("no Antigravity quota buckets");
  return limits;
}

async function antigravity() {
  const r = await exec("sh", ["-c", AGY_SCRIPT], { timeout: 35000 });
  if (r.code === 127) throw new Error("agy CLI not found");
  if (r.code === 42) throw new Error("signed out: run agy once to sign in");
  if (r.code !== 0) {
    const msg = r.stderr.trim().split("\n").find(Boolean);
    throw new Error(msg ? `agy failed: ${msg.slice(0, 120)}` : `agy exited with ${r.code}`);
  }
  return parseAgyUsage(r.stdout);
}

const PROVIDERS = [
  { id: "claude", name: "Claude Code", icon: "icons/claude.svg", load: claude },
  { id: "codex", name: "Codex", icon: "icons/codex.svg", load: codex },
  { id: "antigravity", name: "Antigravity", icon: "icons/antigravity.svg", load: antigravity },
];

export default class UsageLimits extends View {
  init(_props, cx) {
    this.state = {}; // id -> { limits, error, at }
    this.loading = new Set();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    cx.timer.every(60 * 1000, (cx) => cx.notify()); // reset countdowns
  }

  refresh(cx) {
    for (const p of PROVIDERS) {
      if (this.loading.has(p.id)) continue;
      this.loading.add(p.id);
      cx.spawn(async (cx) => {
        try {
          this.state[p.id] = { limits: await p.load(), error: null, at: Date.now() };
        } catch (e) {
          this.state[p.id] = { ...(this.state[p.id] ?? {}), error: String(e?.message ?? e), at: Date.now() };
        } finally {
          this.loading.delete(p.id);
        }
        cx.notify();
      });
    }
  }

  render() {
    const t = theme();
    const tone = (v) => (v >= WARN ? t.blocked : t.muted);
    const bar = (v) =>
      div().w(40).h(4).flex_none().rounded(2).bg(t.border)
        .child(div().h(4).rounded(2).bg(v >= WARN ? t.blocked : t.accent).w(Math.round((Math.min(100, v) / 100) * 40)));
    const item = (p) => {
      const s = this.state[p.id];
      const base = h_flex().id(`usage-${p.id}`).gap(6).items_center().flex_none().rounded(5).px(4)
        .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
        .child(image(p.icon).size(14).flex_none());
      if (!s) return base.child(div().text_color(t.dim).child("…"));
      if (!s.limits) return base.tooltip(`${p.name}: ${s.error}`).child(div().text_color(t.dim).child("unavailable"));
      const week = s.limits.find((l) => l.kind === "weekly_all");
      const session = s.limits.find((l) => l.kind === "session");
      const scoped = s.limits.filter((l) => l.kind === "weekly_scoped" && l.percent > 0);
      const scopedSessions = s.limits.filter((l) => l.kind === "session_scoped" && l.percent >= SHOW_SESSION_AT);
      const lead = week ?? session;
      const parts = [];
      if (session && session !== lead && session.percent >= SHOW_SESSION_AT) parts.push({ text: `5h ${session.percent}%`, v: session.percent });
      if (lead) parts.push({ text: `${lead.percent}% used${lead.reset ? ` ${left(lead.reset)}` : ""}`, v: lead.percent });
      for (const l of scoped) parts.push({ text: `${l.percent}% used ${l.label}`, v: l.percent });
      for (const l of scopedSessions) parts.push({ text: `${l.label} ${l.percent}%`, v: l.percent });
      const tip = [
        `${p.name}${s.error ? ` (last refresh failed: ${s.error})` : ""}`,
        ...s.limits.map((l) => `${l.label}: ${l.percent}% used${l.reset ? `, resets in ${left(l.reset)}` : ""}`),
        "Click to refresh",
      ].join("\n");
      return base.tooltip(tip)
        .when(Boolean(lead), (el) => el.child(bar(lead.percent)))
        .children(parts.flatMap((part, i) => [
          ...(i ? [div().text_color(t.dim).child("·")] : []),
          div().text_color(tone(part.v)).child(part.text),
        ]));
    };
    // A layout block can't size to its content, so the block is resized to fit
    // the items whenever their width changes (no gap before them, no clipping).
    // Compared with the block's actual width, so a reset (a layout rebuild) is fixed too.
    const fit = () => {
      if (this.items == null || this.block == null) return;
      const want = Math.ceil(this.items) + 2 * PAD;
      if (Math.abs(want - this.block) > 1 && want !== this.asked) { this.asked = want; run("layout.resize", { id: BLOCK, px: want }); }
    };
    return h_flex().id("root").size_full().px(PAD).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .on_size_change((size, _cx) => { this.block = size.width; this.asked = null; fit(); })
      .child(h_flex().id("items").flex_none().gap(14).items_center()
        .on_size_change((size, _cx) => { this.items = size.width; fit(); })
        .children(PROVIDERS.map(item)));
  }
}

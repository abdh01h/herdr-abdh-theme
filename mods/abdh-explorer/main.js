// abdh Files: project explorer with real filesystem edits, git colours,
// search, copy/paste and a right-click menu. Files open in the abdh editor pane.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, shared, setShared,
  run, openOverlay, closeOverlay, notify, window, home, props, writeTextFile,
} from "herdr";

const PER_FOLDER = 600, TOTAL = 6000, SEARCH_LIMIT = 1500;

const DEFAULTS = { explorer: { icons: true, gitColors: true, hiddenFiles: false, expanded: 1 } };
const settings = () => ({ ...DEFAULTS, ...(shared("abdh.settings") ?? {}) });

function location() {
  const shown = props() ?? {};
  const space = spaces().find((s) => s.active), f = focused();
  // A layout can pin the panel to a folder (a preview, a docs tree).
  if (shown.root) return { cwd: shown.root, on: shown.on ?? null, space: space?.id, tab: f?.tab };
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // A mod pane (editor, panel tab) has no folder: follow the tab's terminal instead,
  // then the space's folder. Otherwise Files follows the editor to the home folder.
  const terminalPane = pane?.terminal ? pane : f?.tab ? panes().find((p) => p.tab === f.tab && p.terminal) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: terminalPane?.cwd || (pane ? null : f?.cwd) || space?.folder, on, space: space?.id, tab: f?.tab };
}

const norm = (p) => p.replace(/\\/g, "/");
const join = (a, b) => `${norm(a).replace(/\/+$/, "")}/${b}`;
const base = (p) => norm(p).split("/").filter(Boolean).pop() ?? p;
const dirname = (p) => norm(p).replace(/\/[^/]*$/, "");
const isWin = () => window()?.platform === "windows";

const q = (s) => String(s).replace(/'/g, "''");
const sh = (s) => String(s).replace(/'/g, "'\\''");

async function directory(path, on) {
  if (!on && isWin()) {
    const r = await exec("powershell", ["-NoProfile", "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Select-Object -First 601 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + q(path) + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const out = JSON.parse(r.stdout || "[]");
    return (Array.isArray(out) ? out : [out]).map((e) => ({ name: e.name, dir: Boolean(e.dir) }));
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 600 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push({ name: f[i + 1], dir: f[i] === "d" });
  return out;
}

// ---- file types -----------------------------------------------------------
const TYPE = {
  php: ["PHP", "#a56eff"], blade: ["BLD", "#fa4d56"], js: ["JS", "#f1c21b"], mjs: ["JS", "#f1c21b"],
  cjs: ["JS", "#f1c21b"], jsx: ["JSX", "#3ddbd9"], ts: ["TS", "#4589ff"], tsx: ["TSX", "#4589ff"],
  vue: ["VUE", "#42be65"], svelte: ["SV", "#fa4d56"], html: ["H", "#ff832b"], htm: ["H", "#ff832b"],
  css: ["CSS", "#4589ff"], scss: ["SC", "#ff8389"], sass: ["SC", "#ff8389"], less: ["L", "#4589ff"],
  json: ["{}", "#f1c21b"], jsonc: ["{}", "#f1c21b"], xml: ["XML", "#8d8d8d"], yml: ["YML", "#be95ff"],
  yaml: ["YML", "#be95ff"], toml: ["TML", "#be95ff"], md: ["MD", "#8d8d8d"], mdx: ["MD", "#8d8d8d"],
  png: ["IMG", "#d4bbff"], jpg: ["IMG", "#d4bbff"], jpeg: ["IMG", "#d4bbff"], gif: ["IMG", "#d4bbff"],
  webp: ["IMG", "#d4bbff"], svg: ["SVG", "#d4bbff"], ico: ["IMG", "#d4bbff"],
  sh: ["SH", "#42be65"], bash: ["SH", "#42be65"], ps1: ["PS", "#78a9ff"], bat: ["BAT", "#8d8d8d"],
  lock: ["LCK", "#8d8d8d"], env: ["ENV", "#f1c21b"], sql: ["SQL", "#be95ff"], rs: ["RS", "#ff832b"],
  go: ["GO", "#3ddbd9"], py: ["PY", "#4589ff"], rb: ["RB", "#fa4d56"], java: ["J", "#fa4d56"],
};

function badge(entry, t) {
  if (entry.dir) return svg("mods/abdh-explorer/icons/folder.svg").size(14).flex_none().text_color(t.muted);
  const name = entry.name.toLowerCase();
  const ext = name.endsWith(".blade.php") ? "blade" : name.split(".").pop();
  const [label, color] = TYPE[ext] ?? [ext.slice(0, 3).toUpperCase() || "·", t.dim];
  return div().w(20).h(14).flex_none().flex().items_center().justify_center().rounded(3)
    .bg(color + "22").text_size(8).font_semibold().text_color(color).child(label);
}

function markFor(code) {
  if (!code) return null;
  if (code === "??") return ["A", "green"];
  if (code.includes("U")) return ["U", "blocked"];
  if (code.includes("D")) return ["D", "red"];
  if (code[0] !== " " && code[0] !== "." && code[0] !== "?") return ["S", "accent"];
  return ["M", "yellow"];
}

export default class Explorer extends View {
  init(_props, cx) {
    this.root = undefined;
    this.entries = new Map();
    this.folders = new Set();
    this.loading = new Set();
    this.error = null;
    this.git = null;
    this.search = false;
    this.query = "";
    this.results = null;
    this.searchNote = "";
    this.searching = false;
    this.searchInput = InputState.new({ placeholder: "Search files by name" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.results = null;
      const q = this.query;
      cx.timer.after(450, (cx) => { if (this.query === q && q.trim().length >= 2) this.searchFiles(cx); });
      cx.notify();
    });
    this.dialog = null;
    this.selected = null;
    this.handle = cx.focus_handle();
    this.dialogInput = InputState.new({ placeholder: "name" });
    this.dialogInput.on("change", () => {});
    this.lastCmd = null;
    this.lastOpen = null;
    if (props()?.dialog) { this.startDialog(); return; }
    // Render-time spawns do not run; poll shared commands and folder state
    // from timer tasks instead (the editor opening was stalled by this).
    cx.timer.every(400, (cx) => this.refresh(cx));
    cx.timer.every(150, (cx) => this.consume(cx));
    this.refresh(cx);
  }

  // ---- dialogs (this same mod opens as the dialog overlay) ----------------
  startDialog() {
    const p = props() ?? {};
    if (!p.dialog) return false;
    this.dialog = p;
    if (p.dialog === "rename") this.dialogInput = InputState.new({ value: base(p.path), placeholder: "name" });
    else if (p.dialog === "new") this.dialogInput = InputState.new({ placeholder: "name" });
    this.dialogError = null;
    return true;
  }

  async runDialog(cx) {
    const p = this.dialog, name = this.dialogInput.value().trim();
    if (!name && p.dialog !== "delete") return;
    try {
      if (p.dialog === "delete") {
        await this.shell("remove", p.path);
        notify({ title: "Deleted", body: base(p.path), level: "success" });
      } else if (p.dialog === "new") {
        const target = join(p.dir, name);
        if (p.kind === "folder") await this.shell("mkdir", target);
        else await this.writeNew(target, "");
        notify({ title: p.kind === "folder" ? "Folder created" : "File created", body: name, level: "success" });
      } else if (p.dialog === "rename") {
        await this.shell("rename", p.path, name);
        notify({ title: "Renamed", body: `${base(p.path)} → ${name}`, level: "success" });
      }
      if (p.overlay) closeOverlay(p.overlay);
    } catch (e) {
      this.dialogError = String(e.message ?? e);
      notify({ title: `${p.dialog === "delete" ? "Delete" : "File operation"} failed`, body: String(e.message ?? e), level: "error" });
      cx.notify();
    }
  }

  async writeNew(path, text) {
    await writeTextFile(path, text, null);
  }

  async shell(op, a, b) {
    if (isWin()) {
      const cmds = {
        mkdir: `New-Item -ItemType Directory -LiteralPath '${q(a)}' -Force | Out-Null`,
        remove: `Remove-Item -LiteralPath '${q(a)}' -Recurse -Force`,
        rename: `Rename-Item -LiteralPath '${q(a)}' -NewName '${q(b)}'`,
        copy: `Copy-Item -LiteralPath '${q(a)}' -Destination '${q(b)}' -Recurse -Force`,
        reveal: `Start-Process explorer.exe -ArgumentList '/select,${q(a)}'`,
      };
      const r = await exec("powershell", ["-NoProfile", "-Command", cmds[op]]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || op + " failed");
      return;
    }
    const cmds = {
      mkdir: `mkdir -p '${sh(a)}'`,
      remove: `rm -rf '${sh(a)}'`,
      rename: `mv '${sh(a)}' '${join(dirname(a), sh(b))}'`,
      copy: `cp -R '${sh(a)}' '${sh(b)}'`,
      reveal: window()?.platform === "macos" ? `open -R '${sh(a)}'` : `xdg-open '${sh(dirname(a))}'`,
    };
    const r = await exec("sh", ["-c", cmds[op]]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || op + " failed");
  }

  // ---- data ---------------------------------------------------------------
  refresh(cx) {
    const loc = location();
    const hidden = settings().explorer.hiddenFiles;
    if (!loc.cwd) { this.root = undefined; this.entries = new Map(); return; }
    if (loc.cwd !== this.root) {
      this.root = loc.cwd; this.on = loc.on; this.query = ""; this.results = null; this.entries = new Map(); this.folders.clear(); this.error = null;
      this.context = `${loc.space}:${loc.tab}`; this.hidden = settings().explorer.hiddenFiles;
      this.git = null;
      this.load("", cx);
      this.loadGit(cx);
      this.watch(cx);
    }
    for (const f of this.folders) if (!this.entries.has(f)) this.load(f, cx);
    if (!this.entries.has("")) this.load("", cx);
    // The hidden-files setting changes what a listing shows.
    if (this.hidden !== hidden) { this.hidden = hidden; this.entries.clear(); this.folders.clear(); this.load("", cx); }
  }

  abs(rel) { return rel ? join(this.root, rel) : this.root; }
  keyOf(rel) { return norm(this.abs(rel)); }

  load(rel, cx) {
    if (this.loading.has(rel)) return;
    this.loading.add(rel);
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        let list = await directory(this.abs(rel), on);
        if (!settings().explorer.hiddenFiles) list = list.filter((e) => !e.name.startsWith("."));
        if (this.root === root) this.entries.set(rel, list);
      } catch (e) {
        if (this.root === root) this.error = String(e.message ?? e);
      } finally {
        this.loading.delete(rel);
        cx.notify();
      }
    });
  }

  watch(cx) {
    if (this.on || this.watched === this.root) return;
    this.watched = this.root;
    const root = this.root, context = this.context;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(root);
          if (this.root !== root) return;
          this.load("", cx);
          for (const f of this.folders) this.load(f, cx);
          this.loadGit(cx);
          cx.notify();
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  loadGit(cx) {
    const root = this.root, on = this.on;
    if (!root) return;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"], { on }).catch(() => null);
        if (!top || top.code !== 0) { if (this.root === root) this.git = null; return; }
        const repo = norm(top.stdout.trim());
        const st = await exec("git", ["-C", root, "--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"], { on });
        const marks = new Map(), counts = { modified: 0, added: 0, deleted: 0, staged: 0, conflicted: 0 };
        const fields = st.stdout.split("\0");
        for (let i = 0; i < fields.length; i++) {
          const rec = fields[i];
          if (!rec || rec.length < 4) continue;
          const xy = rec.slice(0, 2);
          const path = rec.slice(3);
          if (xy.startsWith("R") || xy.startsWith("C")) i++; // the original path follows
          const full = repo + "/" + path;
          marks.set(isWin() ? full.toLowerCase() : full, xy);
          if (xy === "??") counts.added++;
          else if (xy.includes("U")) counts.conflicted++;
          else if (xy.includes("D")) counts.deleted++;
          else if (xy[0] !== " " && xy[0] !== ".") counts.staged++;
          else counts.modified++;
        }
        const br = await exec("git", ["-C", root, "branch", "--show-current"], { on });
        if (this.root !== root) return;
        this.git = { repo, branch: br.stdout.trim() || "detached", marks, counts };
      } catch { if (this.root === root) this.git = null; }
      cx.notify();
    });
  }

  markOf(rel) {
    if (!this.git || !settings().explorer.gitColors) return null;
    const key = this.keyOf(rel);
    return markFor(this.git.marks.get(isWin() ? key.toLowerCase() : key));
  }

  // ---- shared actions from the menu / dialogs -----------------------------
  consume(cx) {
    if (props()?.dialog) return;
    const cmd = shared("abdh.explorer.cmd"), open = shared("abdh.open");
    if (open && open.nonce !== this.lastOpen) { this.lastOpen = open.nonce; this.openFile(open.path); }
    if (!cmd || cmd.nonce === this.lastCmd) return;
    this.lastCmd = cmd.nonce;
    // One shot per click/menu choice: a reloaded or cloned copy must not replay it.
    setShared("abdh.explorer.cmd", null);
    const root = cmd.root ?? this.root;
    if (cmd.action === "open") this.openFile(cmd.path);
    else if (cmd.action === "reveal") this.shell("reveal", cmd.path).catch((e) => notify({ title: "Reveal failed", body: String(e.message), level: "error" }));
    else if (cmd.action === "blame") openOverlay({ mod: "abdh-git", kind: "dialog", width: 640, height: 620, props: { root: cmd.root ?? this.root, file: cmd.path } });
    else if (cmd.action === "refresh") { this.entries.clear(); this.folders.clear(); this.load("", cx); this.loadGit(cx); }
    else if (cmd.action === "paste") this.paste(cmd.dir ?? dirname(cmd.path), cx);
    else if (cmd.action === "copy" || cmd.action === "cut") setShared("abdh.clipboard", { path: cmd.path, cut: cmd.action === "cut" });
    else if (["new", "rename", "delete"].includes(cmd.action)) {
      openOverlay({ mod: "abdh-explorer", kind: "dialog", width: 420, height: 210,
        props: { dialog: cmd.action, kind: cmd.kind, root, path: cmd.path, dir: cmd.dir } });
    }
  }

  async paste(dir, cx) {
    const clip = shared("abdh.clipboard");
    if (!clip) return;
    try {
      await this.shell("copy", clip.path, join(dir, base(clip.path)));
      if (clip.cut) { await this.shell("remove", clip.path); setShared("abdh.clipboard", null); }
      notify({ title: clip.cut ? "Moved" : "Copied", body: base(clip.path), level: "success" });
    } catch (e) { notify({ title: "Paste failed", body: String(e.message), level: "error" }); }
    this.entries.clear(); this.folders.clear(); this.load("", cx); this.loadGit(cx);
  }

  openFile(path) {
    const tab = focused()?.tab;
    const pane = panes().find((p) => p.mod === "abdh-editor" && p.tab === tab);
    if (pane) { setShared("abdh.open", { path, nonce: `${Date.now()}-${Math.random()}` }); run("pane.focus", { pane: pane.pane }); return; }
    run("pane.split", { direction: "right", mod: "abdh-editor", props: { path, root: this.root } });
  }

  // ---- search -------------------------------------------------------------
  async searchFiles(cx) {
    const term = this.query.trim(), root = this.root, on = this.on;
    if (term.length < 2 || !root) { this.results = null; return; }
    this.searching = true;
    cx.spawn(async (cx) => {
      try {
        // 1) Names: tracked + untracked, ignored files left out.
        let files = [];
        if (!on) {
          const g = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { on }).catch(() => null);
          if (g && g.code === 0) files = g.stdout.split("\0").filter(Boolean).map((p) => `${norm(root)}/${p}`);
        }
        if (!files.length) {
          const shallow = norm(root) === norm(home()) ? 3 : 7;
          if (!on && isWin()) {
            const r = await exec("powershell", ["-NoProfile", "-Command",
              "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -Depth " + shallow + " -ErrorAction SilentlyContinue | Select-Object -First " + SEARCH_LIMIT + " -ExpandProperty FullName) | ConvertTo-Json -Compress } '" + q(root) + "'"]);
            if (r.code === 0) { const v = JSON.parse(r.stdout || "[]"); files = Array.isArray(v) ? v : v ? [v] : []; }
          } else {
            const r = await exec("sh", ["-c", `find "$1" -maxdepth ${shallow} -type f 2>/dev/null | head -n ${SEARCH_LIMIT}`, "find", root], { on });
            files = r.stdout.split("\n").filter(Boolean);
          }
        }

        // 2) Contents. Never walk the whole home folder: that is what made the
        // CPU spike. Repos use single-threaded git grep first; anything else
        // gets ripgrep capped to two threads and a bounded depth.
        const hits = [];
        const add = (path, line, text) => {
          if (hits.length >= 200) return;
          hits.push({ path: norm(path), line, snippet: String(text ?? "").trim().slice(0, 220) });
        };
        const isRepo = files.length > 0;
        const atHome = norm(root) === norm(home());
        if (atHome) {
          this.searchNote = "Content search is off at home. Open a project folder.";
        } else if (isRepo) {
          const gg = await exec("git", ["grep", "-n", "-I", "-i", "-m", "1", "--untracked", "--", term], { cwd: root, on }).catch(() => null);
          if (gg && (gg.code === 0 || gg.code === 1)) {
            for (const line of gg.stdout.split("\n")) {
              const a = line.indexOf(":"), b = a < 0 ? -1 : line.indexOf(":", a + 1);
              if (a < 0 || b < 0) continue;
              add(`${norm(root)}/${line.slice(0, a)}`, Number(line.slice(a + 1, b)), line.slice(b + 1));
            }
          }
        } else {
          const rg = await exec("rg", ["--json", "--smart-case", "--hidden", "-I", "-j", "2", "--max-depth", "12",
            "--max-count", "1", "--max-filesize", "1M", "--no-messages",
            "--glob", "!**/.git/**", "--glob", "!**/node_modules/**", "--glob", "!**/vendor/**", "--glob", "!**/dist/**", "--glob", "!**/build/**",
            term, root], { on }).catch(() => null);
          if (rg && (rg.code === 0 || rg.code === 1)) {
            for (const line of rg.stdout.split("\n")) {
              if (!line) continue;
              let ev; try { ev = JSON.parse(line); } catch { continue; }
              if (ev.type !== "match") continue;
              const path = ev.data?.path?.text;
              if (!path) continue;
              add(path, ev.data.line_number, ev.data.lines?.text);
            }
          }
        }

        if (this.root !== root) return;
        if (!atHome) this.searchNote = "";
        const low = term.toLowerCase();
        const seen = new Set(hits.map((h) => h.path.toLowerCase()));
        const named = files
          .filter((f) => !seen.has(norm(f).toLowerCase()) && base(f).toLowerCase().includes(low))
          .slice(0, 120)
          .map((f) => ({ path: norm(f) }));
        this.results = [...hits, ...named].slice(0, 200);
      } catch { this.results = []; }
      this.searching = false;
      cx.notify();
    });
  }

  // ---- menu ---------------------------------------------------------------
  menu(rel, dir, cx, right) {
    const abs = this.abs(rel), clip = shared("abdh.clipboard");
    const items = dir
      ? [
        { label: "New file…", shared: "abdh.explorer.cmd", value: { action: "new", kind: "file", dir: abs, root: this.root } },
        { label: "New folder…", shared: "abdh.explorer.cmd", value: { action: "new", kind: "folder", dir: abs, root: this.root } },
        { separator: true },
        { label: "Rename…", shared: "abdh.explorer.cmd", value: { action: "rename", path: abs, root: this.root } },
        { label: "Copy", shared: "abdh.explorer.cmd", value: { action: "copy", path: abs } },
        { label: "Cut", shared: "abdh.explorer.cmd", value: { action: "cut", path: abs } },
        ...(clip ? [{ label: `Paste ${base(clip.path)}`, shared: "abdh.explorer.cmd", value: { action: "paste", dir: abs } }] : []),
        { label: "Reveal", shared: "abdh.explorer.cmd", value: { action: "reveal", path: abs } },
        { separator: true },
        { label: "Delete…", danger: true, shared: "abdh.explorer.cmd", value: { action: "delete", path: abs, dir: true, root: this.root } },
      ]
      : [
        { label: "Open", shared: "abdh.explorer.cmd", value: { action: "open", path: abs } },
        { label: "Rename…", shared: "abdh.explorer.cmd", value: { action: "rename", path: abs, root: this.root } },
        { label: "Copy", shared: "abdh.explorer.cmd", value: { action: "copy", path: abs } },
        { label: "Cut", shared: "abdh.explorer.cmd", value: { action: "cut", path: abs } },
        ...(clip ? [{ label: `Paste ${base(clip.path)}`, shared: "abdh.explorer.cmd", value: { action: "paste", dir: dirname(abs) } }] : []),
        { label: "Git blame", shared: "abdh.explorer.cmd", value: { action: "blame", path: abs, root: this.root } },
        { label: "Reveal", shared: "abdh.explorer.cmd", value: { action: "reveal", path: abs } },
        { separator: true },
        { label: "Delete…", danger: true, shared: "abdh.explorer.cmd", value: { action: "delete", path: abs, root: this.root } },
      ];
    openOverlay({ mod: "abdh-menu", kind: "popup", at: "pointer", width: 220, props: { items, title: base(abs) } });
  }

  // ---- render -------------------------------------------------------------
  dialogView(t) {
    const p = this.dialog ?? props();
    const title = p.dialog === "delete" ? "Delete" : p.dialog === "rename" ? "Rename" : p.kind === "folder" ? "New folder" : "New file";
    return v_flex().size_full().p(14).gap(12).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().text_size(13).font_semibold().child(title))
      .child(p.dialog === "delete"
        ? div().text_color(t.muted).child(`Delete ${base(p.path)}? This cannot be undone.`)
        : h_flex().gap(8).items_center()
          .child(div().w(64).text_color(t.dim).child(p.dialog === "rename" ? "New name" : "Name"))
          .child(Input.new(this.dialogInput).flex_1()))
      .when(Boolean(this.dialogError), (el) => el.child(div().text_color(t.blocked).text_size(11.5).child(this.dialogError)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(div().id("dlg-cancel").h(26).px(10).flex().items_center().rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(p.overlay)).child("Cancel"))
        .child(div().id("dlg-ok").h(26).px(10).flex().items_center().rounded(5).bg(p.dialog === "delete" ? t.blocked : t.solid)
          .text_color(p.dialog === "delete" ? t.accent_foreground : t.solid_foreground).on_click((_e, cx) => this.runDialog(cx))
          .child(p.dialog === "delete" ? "Delete" : "Create")));
  }

  rows(rel, depth, out, t) {
    if (out.length >= TOTAL || depth > 30) return out;
    for (const entry of this.entries.get(rel) ?? []) {
      if (out.length >= TOTAL) break;
      const path = rel ? `${rel}/${entry.name}` : entry.name, open = this.folders.has(path);
      const mark = this.markOf(path);
      const color = !mark ? t.muted : mark[1] === "green" ? t.ansi2 : mark[1] === "red" ? t.ansi1 : mark[1] === "yellow" ? t.ansi3 : mark[1] === "accent" ? t.accent : t.blocked;
      out.push(h_flex().id(`x-${path}`).h(25).flex_none().pl(8 + depth * 13).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .when(this.selected?.path === this.abs(path), (el) => el.bg(t.selected))
        .on_click((_e, cx) => {
          this.selected = { path: this.abs(path), dir: entry.dir };
          this.handle.focus();
          if (!entry.dir) { this.openFile(this.abs(path)); return; }
          if (this.folders.has(path)) this.folders.delete(path);
          else { this.folders.add(path); this.load(path, cx); }
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir, cx, true); })
        .when(entry.dir, (el) => el.child(svg(`mods/abdh-explorer/icons/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)))
        .when(!entry.dir, (el) => el.child(div().w(11).flex_none()))
        .when(settings().explorer.icons, (el) => el.child(badge(entry, t)))
        .child(div().flex_1().min_w(0).truncate().text_color(entry.dir ? t.muted : t.foreground).child(entry.name))
        .when(Boolean(mark), (el) => el.child(
          div().flex_none().text_size(10).font_semibold().text_color(color).tooltip(`git: ${mark[0]}`).child(mark[0])
        )));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  header(t, cx) {
    const iconButton = (id, icon, tip, action, on) => div().id(id).size(22).flex_none().flex().items_center().justify_center()
      .rounded(4).text_color(on ? t.accent : t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(action).child(svg(icon).size(13));
    const newMenu = () => openOverlay({
      mod: "abdh-menu", kind: "popup", at: "pointer", width: 200,
      props: { items: [
        { label: "New file…", shared: "abdh.explorer.cmd", value: { action: "new", kind: "file", dir: this.root, root: this.root } },
        { label: "New folder…", shared: "abdh.explorer.cmd", value: { action: "new", kind: "folder", dir: this.root, root: this.root } },
        { separator: true },
        { label: "Refresh", shared: "abdh.explorer.cmd", value: { action: "refresh", root: this.root } },
      ] },
    });
    return h_flex().h(32).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.muted).child(this.root ? base(this.root) : "Files"))
      .child(iconButton("x-search", "mods/abdh-chrome/icons/search.svg", "Search files", () => {
        this.search = !this.search;
        if (!this.search) { this.query = ""; this.results = null; }
        cx.notify();
      }, this.search))
      .child(iconButton("x-new", "mods/abdh-chrome/icons/plus.svg", "New file or folder", newMenu, false));
  }

  searchBar(t, cx) {
    const clear = () => { this.query = ""; this.results = null; cx.notify(); };
    return h_flex().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(Input.new(this.searchInput).flex_1())
      .when(this.query.length > 0, (el) => el.child(div().id("x-search-clear").size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(t.dim).hover((x) => x.bg(t.hover)).on_click(clear).child("×")));
  }

  gitStrip(t) {
    const g = this.git;
    const count = (id, n, text, color) => div().id(id).flex_none().text_color(color).child(text);
    return h_flex().px(10).h(26).flex_none().gap(8).items_center().border_b(1).border_color(t.border).text_size(11)
      .child(svg("mods/abdh-status/icons/branch.svg").size(11).flex_none().text_color(t.dim))
      .child(div().text_color(t.muted).child(g.branch))
      .when(g.counts.modified > 0, (x) => x.child(count("gm", g.counts.modified, `${g.counts.modified}~`, t.ansi3)))
      .when(g.counts.added > 0, (x) => x.child(count("ga", g.counts.added, `+${g.counts.added}`, t.ansi2)))
      .when(g.counts.deleted > 0, (x) => x.child(count("gd", g.counts.deleted, `−${g.counts.deleted}`, t.ansi1)))
      .when(g.counts.staged > 0, (x) => x.child(count("gs", g.counts.staged, `${g.counts.staged}✓`, t.accent)))
      .when(g.counts.conflicted > 0, (x) => x.child(count("gc", g.counts.conflicted, `${g.counts.conflicted}!`, t.blocked)))
      .child(div().flex_1())
      .child(div().id("x-git").text_color(t.dim).hover((x) => x.text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "abdh-git", kind: "dialog", width: 520, height: 520, props: { root: this.root } }))
        .child("branches…"));
  }

  resultRow(r, t) {
    const rel = norm(r.path).slice(norm(this.root).length + 1);
    const folder = rel.slice(0, Math.max(0, rel.length - base(r.path).length));
    const head = h_flex().gap(6).items_center()
      .child(div().min_w(0).truncate().text_color(t.foreground).child(base(r.path)))
      .child(div().text_size(10).text_color(t.dim).truncate().child(folder));
    const body = v_flex().flex_1().min_w(0).gap(1).child(head);
    if (r.line != null) body.child(div().text_size(10.5).text_color(t.dim).truncate().child(`${r.line}: ${r.snippet}`));
    return h_flex().id(`sr-${r.path}`).py(4).px(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((y) => y.bg(t.hover)).on_click(() => this.openFile(r.path))
      .child(badge({ name: base(r.path), dir: false }, t))
      .child(body);
  }

  body(t) {
    const searching = this.query.trim().length >= 2;
    if (searching) {
      const rows = (this.results ?? []).map((r) => this.resultRow(r, t));
      return v_flex().id("x-tree").flex_1().min_h(0).py(4).overflow_y_scrollbar()
        .when(this.searching, (x) => x.child(div().p(10).text_color(t.dim).child("Searching…")))
        .when(Boolean(this.results), (x) => x.children(rows))
        .when(this.results?.length === 0 && !this.searching, (x) => x.child(div().p(10).text_color(t.dim).text_size(11.5).child(this.searchNote || "No matches in names or contents")));
    }
    return v_flex().id("x-tree").flex_1().min_h(0).py(4).overflow_y_scrollbar()
      .children(this.rows("", 0, [], t))
      .when(Boolean(this.error), (x) => x.child(div().p(10).text_color(t.blocked).text_size(11.5).child(this.error)))
      .when(!this.error && this.entries.get("") === undefined, (x) => x.child(div().p(10).text_color(t.dim).child("Loading files…")))
      .when(!this.error && this.entries.get("")?.length === 0, (x) => x.child(div().p(10).text_color(t.dim).child("No files")));
  }

  render(cx) {
    const p = props() ?? {};
    const t = theme();
    if (p.dialog) {
      if (!this.dialog) this.startDialog();
      return this.dialogView(t);
    }
    const root = v_flex().id("abdh-explorer").size_full().min_h(0).bg(t.chrome).text_size(12.5).text_color(t.foreground);
    root.child(this.header(t, cx));
    root.child(this.searchBar(t, cx));
    if (this.git && settings().explorer.gitColors) root.child(this.gitStrip(t));
    root.child(this.body(t));
    return root;
  }
}

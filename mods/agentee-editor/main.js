// Agentee editor: a real file editor in a mod pane.
// Chrome-like file tabs, save to disk, dirty state, external-change handling,
// unsaved-change confirmation, and the shared("agentee.editor") stats the status bar reads.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, watchFolder, theme, shared, setShared, props, nextCommand, settings,
  appHome, notify, openOverlay, panes, run, focused, keys, window as appWindow,
} from "herdr";

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js",
  cjs: "js", vue: "html", svelte: "html", jsonc: "json", toml: "yaml",
  blade: "html", php: "php",
};
const LABEL = { blade: "Blade", md: "Markdown", yml: "YAML", yaml: "YAML", ps1: "PowerShell", sh: "Shell" };
const MAX = 1000000;

const norm = (p) => p.replace(/\\/g, "/");
const samePath = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase() || norm(a) === norm(b);
const base = (p) => norm(p).split("/").filter(Boolean).pop() ?? p;
const dirname = (p) => norm(p).replace(/\/[^/]*$/, "");

function extOf(path) {
  const n = base(path).toLowerCase();
  if (n.endsWith(".blade.php")) return "blade";
  return n.includes(".") ? n.split(".").pop() : "";
}

function stats(text) {
  return {
    lines: text.split("\n").length,
    chars: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    eol: text.includes("\r\n") ? (text.replace(/\r\n/g, "").includes("\n") ? "Mixed" : "CRLF") : "LF",
    encoding: text.startsWith("\uFEFF") ? "UTF-8 BOM" : "UTF-8",
  };
}

// A small LCS line diff: HEAD text -> buffer text. Capped so a huge file
// cannot stall a render; the view says so instead.
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4000000) return { tooLarge: true };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i], next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
  }
  const ops = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1, added = 0, removed = 0;
  const push = (sign, text) => {
    ops.push([sign, text, sign === "+" ? null : oldNo++, sign === "-" ? null : newNo++]);
    if (sign === "+") added++; else if (sign === "-") removed++;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(" ", a[i++]); j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("-", a[i++]);
    else push("+", b[j++]);
  }
  while (i < n) push("-", a[i++]);
  while (j < m) push("+", b[j++]);
  // Three lines of context around every change, with a marker for the gaps.
  const keep = new Set();
  ops.forEach((op, k) => { if (op[0] !== " ") for (let x = Math.max(0, k - 3); x <= Math.min(ops.length - 1, k + 3); x++) keep.add(x); });
  const lines = []; let skipping = false;
  ops.forEach((op, k) => {
    if (keep.has(k)) { skipping = false; lines.push(op); }
    else if (!skipping) { skipping = true; lines.push(["…", "", null, null]); }
  });
  return { lines, added, removed };
}

export default class EditorPane extends View {
  init(_props, cx) {
    this.files = [];
    this.activeId = null;
    this.untitled = 0;
    this.lastOpen = shared("agentee.open")?.nonce ?? null;
    this.lastPick = shared("agentee.editor.pick")?.nonce ?? null;
    // This copy's name for its right-click menu's actions.
    this.key = `${Date.now()}-${Math.random()}`;
    this.lastMenu = shared("agentee.editor.cmd")?.nonce ?? null;
    this.pressed = null;
    this.hovered = null;
    this.pending = null; // { id, kind: "close" | "reload" }
    this.saveAs = null;
    this.saveAsInput = null;
    this.notice = null;
    this.watchers = new Set();
    this.diff = false;
    this.diffData = null;
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    this.root = p.root ?? null;
    // The tab this copy was split into: open requests name the tab they are for.
    this.tab = focused()?.tab ?? null;
    // Shared open requests arrive while another mod is rendering. A spawn made
    // from render never runs, so poll from a timer instead.
    cx.timer.every(150, (cx) => this.consume(cx));
    if (p.path) cx.spawn(async (cx) => { await this.open(p.path, cx, p.on ?? null); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "save") await this.save(cx);
        else if (command === "close") { if (this.active()) this.requestClose(cx); else this.closePane(); }
        else if (command === "saveas") this.startSaveAs(cx);
        // Herdr sends "focus" when a popup over this pane closes, too. The text
        // area can't be focused from here (EditorState has no focus()), so with a
        // file showing, leave the keyboard where it is rather than take it away.
        else if (command === "focus") { if (this.diff || !this.active()?.editor) this.handle.focus(); }
        else if (command === "diff") this.toggleDiff(cx);
        else if (command === "next") this.step(1, cx);
        else if (command === "prev") this.step(-1, cx);
        cx.notify();
      }
    });
  }

  active() { return this.files.find((f) => f.id === this.activeId) ?? null; }

  myPane() {
    const f = focused();
    const list = panes().filter((p) => p.mod === "agentee-editor" && p.tab === f?.tab);
    return list.find((p) => p.pane === f?.pane) ?? (list.length === 1 ? list[0] : null);
  }

  closePane() {
    const p = this.myPane();
    if (p) run("pane.close", { pane: p.pane });
  }

  // Herdr closes a pane without asking our page, so dirty text goes to a recovery
  // copy under the app folder instead of vanishing.
  async close() {
    const dirty = this.files.filter((f) => f.dirty && !f.on);
    if (!dirty.length) return;
    try {
      const fs = await import("fs/promises");
      const dir = `${appHome()}/agentee-recovery`;
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const [i, f] of dirty.entries()) await fs.writeFile(`${dir}/${f.name}.${stamp}.${i}.txt`, f.text, "utf8");
      notify({ title: "Unsaved edits recovered", body: `${dirty.length} file(s) in agentee-recovery`, level: "warning", timeout: 8000 });
    } catch { /* the window is closing; nothing else to do */ }
  }

  publish() {
    const f = this.active();
    setShared("agentee.editor", f ? {
      path: f.path, name: f.name, language: f.label, dirty: f.dirty,
      ...stats(f.text), external: Boolean(f.external), error: f.error ?? null,
    } : null);
  }

  activate(id, cx) {
    this.activeId = id;
    this.publish();
    this.handle.focus();
    cx.notify();
  }

  async open(path, cx, on = null) {
    const existing = this.files.find((f) => f.path && samePath(f.path, path));
    if (existing) { this.activate(existing.id, cx); return; }
    const id = `${Date.now()}-${Math.random()}`;
    const file = { id, path, name: base(path), text: "", saved: "", dirty: false, error: null, external: null, label: "", language: "txt", editor: null, on };
    this.files.push(file);
    this.activeId = id;
    this.publish();
    cx.notify();
    try {
      const text = await readTextFile(path, { on });
      if (text === null) throw new Error("File is no longer available");
      if (text.includes("\0")) throw new Error("Binary file · no text editor");
      if (text.length >= MAX) throw new Error("File is larger than 1 MiB");
      this.fill(file, text, cx);
      this.watch(dirname(path), cx);
    } catch (e) {
      file.error = String(e.message ?? e);
    }
    cx.notify();
  }

  fill(file, text, cx) {
    const ext = extOf(file.path ?? file.name);
    file.text = text;
    file.saved = text;
    file.dirty = false;
    file.external = null;
    file.error = null;
    file.language = LANG[ext] ?? ext ?? "txt";
    file.label = LABEL[ext] ?? (ext ? ext.toUpperCase() : "Text");
    file.readonly = Boolean(file.on);
    this.makeEditor(file, text);
    if (file.id === this.activeId) this.publish();
  }

  // Theme settings → Wrap long lines; on unless turned off.
  wrap() { return shared("agentee.settings")?.appearance?.softWrap ?? true; }

  // A new EditorState holding `text`: a file's first load, or a setting the
  // state only takes when it is made (wrapping). `gen` gives the element a new
  // id, or GPUI would keep painting the old native view.
  makeEditor(file, text) {
    const t = theme();
    file.gen = (file.gen ?? 0) + 1;
    file.editor = EditorState.new({
      readonly: Boolean(file.on),
      language: file.language,
      value: text,
      line_numbers: true,
      folding: true,
      soft_wrap: this.wrap(),
      font_family: settings().font_family,
      font_size: shared("agentee.settings")?.appearance?.monoSize ?? 13,
      syntax: {
        keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
        type: t.ansi3, number: t.ansi1, constant: t.ansi6, variable: t.foreground,
        operator: t.muted, punctuation: t.muted, boolean: t.ansi3,
      },
    });
    // The change event brings its own cx: the one fill() was called with may be
    // a click's, which is gone by the first keystroke.
    file.editor.on("change", (_e, cx) => {
      file.text = file.editor.value();
      file.dirty = file.text !== file.saved;
      this.publish();
      cx.notify();
    });
  }

  // Ctrl+PageDown / Ctrl+PageUp: the next or previous open file, wrapping round.
  step(by, cx) {
    if (this.files.length < 2) return;
    const at = this.files.findIndex((f) => f.id === this.activeId);
    this.activate(this.files[(at + by + this.files.length) % this.files.length].id, cx);
  }

  watch(dir, cx) {
    if (this.watchers.has(dir)) return;
    this.watchers.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(dir);
          // Stop once no open file lives here; re-read only files that changed.
          if (!this.files.some((f) => f.path && samePath(dirname(f.path), dir))) { this.watchers.delete(dir); return; }
          for (const f of this.files) {
            if (!f.path || !samePath(dirname(f.path), dir)) continue;
            if (!changed.some((p) => samePath(p, f.path) || samePath(p, dir))) continue;
            await this.checkExternal(f, cx);
          }
          cx.notify();
        }
      } catch {
        this.watchers.delete(dir);
      }
    });
  }

  async checkExternal(file, cx) {
    if (file.on) return;
    try {
      const disk = await readTextFile(file.path);
      if (disk === null) { if (!file.error) file.error = `${file.name} was deleted on disk`; return; }
      if (disk === file.saved) return;
      if (!file.dirty) {
        this.fill(file, disk, cx);
        this.notice = `Reloaded ${file.name} from disk`;
      } else {
        file.external = disk;
      }
    } catch { /* ignore a transient read */ }
  }

  // `f`: the close bar saves the file it asked about, which may not be active.
  async save(cx, f = this.active()) {
    if (!f) return false;
    if (f.on) { f.error = "This file is on another machine and is read-only here"; cx.notify(); return false; }
    if (!f.path) { this.startSaveAs(cx); return false; }
    // Typing goes on during the await; only what was written counts as saved.
    const text = f.text;
    try {
      await writeTextFile(f.path, text, f.saved);
      f.saved = text;
      f.dirty = f.text !== text;
      f.external = null;
      f.error = null;
      this.notice = `Saved ${f.name}`;
      setShared("agentee.git.changed", Date.now());
      this.publish();
      cx.notify();
      return true;
    } catch (e) {
      f.error = String(e.message ?? e);
      this.pending = { id: f.id, kind: "external" };
      cx.notify();
      return false;
    }
  }

  async overwrite(cx) {
    const f = this.active();
    // No editor means the file never loaded (too large, binary): f.text is not
    // its content, and writing it would empty the file.
    if (!f?.path || !f.editor || f.on) return;
    const text = f.text;
    try {
      const disk = await readTextFile(f.path);
      await writeTextFile(f.path, text, disk);
      f.saved = text;
      f.dirty = f.text !== text;
      f.external = null;
      f.error = null;
      this.pending = null;
      this.notice = `Saved ${f.name}`;
      setShared("agentee.git.changed", Date.now());
      this.publish();
    } catch (e) { f.error = String(e.message ?? e); }
    cx.notify();
  }

  async reloadFromDisk(cx) {
    const f = this.active();
    if (!f?.path) return;
    try {
      const disk = await readTextFile(f.path);
      if (disk === null) throw new Error("File is gone");
      this.fill(f, disk, cx);
      this.pending = null;
      this.notice = `Reloaded ${f.name}`;
      this.publish();
    } catch (e) { f.error = String(e.message ?? e); }
    cx.notify();
  }

  startSaveAs(cx) {
    const f = this.active();
    if (!f) return;
    this.saveAs = f.id;
    this.saveAsInput = InputState.new({ value: f.name, placeholder: "file name" });
    cx.notify();
  }

  async commitSaveAs(cx) {
    const f = this.active();
    const name = this.saveAsInput?.value().trim();
    if (!f || !name) return;
    const dir = this.root ? norm(this.root) : null;
    if (!dir) { f.error = "No project folder to save into"; cx.notify(); return; }
    const path = `${dir}/${name}`;
    try {
      await writeTextFile(path, f.text, null);
      f.path = path;
      f.name = name;
      f.saved = f.text;
      f.dirty = false;
      f.error = null;
      const ext = extOf(path);
      f.language = LANG[ext] ?? ext ?? "txt";
      f.label = LABEL[ext] ?? (ext ? ext.toUpperCase() : "Text");
      this.saveAs = null;
      this.notice = `Created ${name}`;
      this.watch(dirname(path), cx);
      this.publish();
    } catch (e) { f.error = String(e.message ?? e); }
    cx.notify();
  }

  requestClose(cx, id = this.activeId) {
    const f = this.files.find((x) => x.id === id);
    if (!f) return;
    if (f.dirty) { this.pending = { id, kind: "close" }; cx.notify(); return; }
    this.closeFile(id, cx);
  }

  closeFile(id, cx) {
    const at = this.files.findIndex((f) => f.id === id);
    if (at < 0) return;
    this.files.splice(at, 1);
    if (this.activeId === id) this.activeId = this.files[Math.min(at, this.files.length - 1)]?.id ?? null;
    this.pending = null;
    this.publish();
    if (!this.files.length) this.closePane();
    cx.notify();
  }

  newBuffer(cx) {
    this.untitled += 1;
    const id = `${Date.now()}-${Math.random()}`;
    const name = `untitled-${this.untitled}`;
    const file = { id, path: null, name, text: "", saved: "", dirty: false, error: null, external: null, label: "Text", language: "txt", editor: null };
    this.files.push(file);
    this.activeId = id;
    this.fill(file, "", cx);
    this.publish();
    cx.notify();
  }

  toggleDiff(cx) {
    this.diff = !this.diff;
    if (this.diff) this.loadDiff(cx);
    else this.diffData = null;
    cx.notify();
  }

  // HEAD version of the file against what the editor currently holds (dirty too).
  loadDiff(cx) {
    const f = this.active();
    if (!f) { this.diffData = { error: "No file open" }; return; }
    if (!f.path) { this.diffData = { error: "An untitled buffer has no HEAD version" }; return; }
    // The file's own folder finds its repo; the Files root may be above it.
    const text = f.text, file = f.path, root = dirname(f.path);
    this.diffData = { loading: true };
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"]);
        if (top.code !== 0) { this.diffData = { error: "Not a git repository" }; cx.notify(); return; }
        // `./name` is resolved from -C, so no repo-relative path (and no
        // drive-letter case) has to be worked out here.
        const head = await exec("git", ["-C", root, "show", `HEAD:./${base(file)}`]);
        const before = head.code === 0 ? String(head.stdout).replace(/\r\n/g, "\n") : "";
        const after = String(text).replace(/\r\n/g, "\n");
        const d = lineDiff(before ? before.split("\n") : [], after.split("\n"));
        this.diffData = { ...d, file: base(file), added: d.added ?? 0, removed: d.removed ?? 0 };
      } catch (e) {
        this.diffData = { error: String(e.message ?? e) };
      }
      cx.notify();
    });
  }

  diffView(t) {
    const d = this.diffData ?? {};
    const signColor = (s) => (s === "+" ? t.done : s === "-" ? t.blocked : t.dim);
    const gutter = (n) => div().w(34).flex_none().text_size(9.5).text_color(t.dim).child(n == null ? "" : String(n));
    return v_flex().id("agentee-editor-diff").size_full().min_h(0).text_size(11.5)
      .child(h_flex().h(24).flex_none().px(10).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`HEAD \u2192 buffer`))
        .when(Boolean(d.file), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(d.file)))
        .child(div().flex_1())
        .when(d.added > 0, (el) => el.child(div().text_color(t.done).child(`+${d.added}`)))
        .when(d.removed > 0, (el) => el.child(div().text_color(t.blocked).child(`\u2212${d.removed}`)))
        .child(div().text_size(10).text_color(t.dim).child("read-only")))
      .when(Boolean(d.loading), (el) => el.child(div().p(12).text_color(t.dim).child("Comparing with HEAD\u2026")))
      .when(Boolean(d.error), (el) => el.child(div().p(12).text_color(t.blocked).child(d.error)))
      .when(Boolean(d.tooLarge), (el) => el.child(div().p(12).text_color(t.dim).child("This file is too large to diff here.")))
      .when(Array.isArray(d.lines) && d.lines.length === 0, (el) => el.child(div().p(12).text_color(t.dim).child("No changes against HEAD.")))
      .when(Array.isArray(d.lines), (el) => el.child(div().flex_1().min_h(0).overflow_y_scrollbar()
        .children(d.lines.map(([sign, text, oldNo, newNo], i) => h_flex().id(`df-${i}`).h(18).px(6).gap(4).items_center()
          .when(sign === "+", (x) => x.bg(t.done + "1f"))
          .when(sign === "-", (x) => x.bg(t.blocked + "1f"))
          .child(gutter(oldNo))
          .child(gutter(newNo))
          .child(div().w(10).flex_none().text_size(10).text_color(signColor(sign)).child(sign === "…" ? "…" : sign))
          .child(div().flex_1().min_w(0).truncate().text_color(sign === " " ? t.muted : t.foreground).child(text || " "))))));
  }

  consume(cx) {
    const open = shared("agentee.open");
    if (open && open.nonce !== this.lastOpen) {
      this.lastOpen = open.nonce;
      if (open.tab && this.tab && open.tab !== this.tab) return;
      if (open.root) this.root = open.root;
      cx.spawn(async (cx) => { await this.open(open.path, cx, open.on ?? null); });
    }
    // A file picked in the open-files menu (ids are this copy's own).
    const pick = shared("agentee.editor.pick");
    if (pick && pick.nonce !== this.lastPick) {
      this.lastPick = pick.nonce;
      if (this.files.some((f) => f.id === pick.id)) this.activate(pick.id, cx);
    }
    const menu = shared("agentee.editor.cmd");
    if (menu && menu.nonce !== this.lastMenu) {
      this.lastMenu = menu.nonce;
      if (menu.key === this.key) this.menuAction(menu.action, cx);
    }
    // Wrapping changed in Theme settings: rebuild each editor with its current
    // text (unsaved edits stay; undo history starts over).
    const wrap = this.wrap();
    if (this.wrapped === undefined) this.wrapped = wrap;
    else if (wrap !== this.wrapped) {
      this.wrapped = wrap;
      for (const file of this.files) if (file.editor) this.makeEditor(file, file.text);
      cx.notify();
    }
  }

  menuAction(action, cx) {
    const f = this.active();
    if (action === "save") cx.spawn(async (cx) => { await this.save(cx); });
    else if (action === "saveas") this.startSaveAs(cx);
    else if (action === "close") this.requestClose(cx);
    else if (action === "diff") this.toggleDiff(cx);
    else if (action === "files") this.fileMenu();
    else if (action === "blame" && f?.path) openOverlay({ mod: "agentee-git", kind: "dialog", width: 640, height: 620, props: { root: dirname(f.path), file: f.path } });
    cx.notify();
  }

  // Right-click: the file's actions, then the pane's (what Herdr's own pane
  // menu offers a terminal), with the chords keys.json binds to them.
  paneMenu() {
    // The chord for this platform: cmd- on macOS, never cmd- elsewhere.
    const mac = appWindow()?.platform === "macos";
    const chord = (action, section = "global") => {
      const all = keys().filter((b) => b.action === action && b.section === section).map((b) => b.keys);
      return all.find((k) => (mac ? k.includes("cmd-") : !k.includes("cmd-"))) ?? all[0] ?? null;
    };
    const mine = (label, action, hint = null) => ({ label, hint, shared: "agentee.editor.cmd", value: { key: this.key, action } });
    const f = this.active(), pane = this.myPane()?.pane ?? null;
    const items = [];
    // No Cut/Copy/Paste here: a right press moves the caret (the selection is
    // gone before a menu opens), and a mod's window.dispatch_action reaches
    // Herdr's command table, not the text area's input:: actions. The keys work.
    if (f) {
      items.push(mine("Save", "save", chord("agentee-editor.save", "mod:agentee-editor")));
      items.push(mine("Save as…", "saveas", chord("agentee-editor.saveas", "mod:agentee-editor")));
      items.push(mine(this.diff ? "Back to the editor" : "Diff with HEAD", "diff"));
      if (f.path) items.push(mine("Git blame", "blame"));
      if (this.files.length > 1) items.push(mine("Open files…", "files"));
      items.push(mine("Close file", "close", chord("agentee-editor.close", "mod:agentee-editor")));
    }
    if (pane) {
      if (items.length) items.push({ separator: true });
      items.push({ label: "Split right", command: "pane.split", args: { direction: "right", pane }, hint: chord("pane.split:right") });
      items.push({ label: "Split down", command: "pane.split", args: { direction: "down", pane }, hint: chord("pane.split:down") });
      items.push({ label: "Zoom", command: "pane.zoom", args: { pane }, hint: chord("pane.zoom") });
      items.push({ separator: true });
      items.push({ label: "Close pane", command: "pane.close", args: { pane }, hint: chord("pane.close"), danger: true });
    }
    if (!items.length) return;
    const height = 10 + items.reduce((h, i) => h + (i.separator ? 7 : 28), 0);
    openOverlay({ mod: "agentee-menu", kind: "popup", width: 250, height, props: { items } });
  }

  // Every open file in a popup, for when the strip has more than fits.
  fileMenu() {
    const items = this.files.map((f) => ({
      label: `${f.dirty ? "● " : ""}${f.name}`,
      hint: f.id === this.activeId ? "open" : base(dirname(f.path ?? "")),
      shared: "agentee.editor.pick",
      value: { id: f.id },
    }));
    openOverlay({ mod: "agentee-menu", kind: "popup", width: 280, height: Math.min(420, 44 + items.length * 28), props: { title: "Open files", items } });
  }

  bar(t, text, tone, buttons) {
    return h_flex().px(10).py(6).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11.5)
      .child(div().flex_1().truncate().text_color(tone ?? t.muted).child(text))
      .children(buttons.map(([label, cls, fn]) => div().id(`ed-${label}`).h(22).px(8).flex().items_center().rounded(4)
        .bg(cls === "primary" ? t.solid : t.chrome).text_color(cls === "primary" ? t.solid_foreground : t.muted)
        .hover((s) => s.bg(cls === "primary" ? t.accent : t.hover)).on_click(fn).child(label)));
  }

  render(cx) {
    const t = theme();
    const f = this.active();
    const close = this.pending?.kind === "close" ? this.files.find((x) => x.id === this.pending.id) : null;

    // Flat tabs as wide as their names (60–200 px; the strip scrolls past that);
    // the active one is the code's own background with an accent line on top.
    const tab = (file, i) => {
      const on = file.id === this.activeId, hot = this.hovered === file.id;
      return v_flex().id(`ed-tab-${file.id}`).h_full().flex_none().min_w(60).max_w(200)
        .border_r(1).border_color(t.border)
        .bg(on ? t.background : t.chrome)
        .text_size(12).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .hover((s) => s.bg(on ? t.background : t.surface).text_color(t.foreground))
        .tooltip(file.path ?? file.name)
        .on_mouse_down("middle", (_e, ctx) => { ctx.stop_propagation(); this.requestClose(ctx, file.id); })
        // Handlers use their own ctx: render's cx is stale once render returns.
        .on_hover((hovered, ctx) => {
          if (hovered) this.hovered = file.id;
          else if (this.hovered === file.id) this.hovered = null;
          ctx.notify();
        })
        .on_mouse_down("left", () => { this.pressed = i; })
        .on_mouse_up("left", (_e, ctx) => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) {
            const [moved] = this.files.splice(from, 1);
            this.files.splice(i, 0, moved);
            ctx.notify();
          } else this.activate(file.id, ctx);
        })
        .child(div().h(2).flex_none().bg(on ? t.accent : "#00000000"))
        .child(h_flex().flex_1().min_h(0).pl(12).pr(5).gap(6).items_center()
          .when(file.dirty, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.ansi3)))
          .child(div().min_w(0).flex_shrink(1).truncate().child(file.name))
          // The close button keeps its place, so tabs don't jump on hover.
          .child(div().id(`ed-x-${file.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(3)
            .when(on || hot, (el) => el.text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
              .on_mouse_down("left", (_e, ctx) => ctx.stop_propagation())
              .on_click((_e, ctx) => { ctx.stop_propagation(); this.requestClose(ctx, file.id); })
              .child(svg("mods/agentee-tabs/icons/close.svg").size(10)))));
    };
    const tool = (id, label) => div().id(id).h(22).px(8).flex().items_center().rounded(4).text_size(11).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).child(label);

    return v_flex().id("agentee-editor").size_full().min_h(0).bg(t.background).text_size(12.5).text_color(t.foreground)
      .track_focus(this.handle)
      .on_mouse_down("right", (_e, ctx) => { ctx.stop_propagation(); this.paneMenu(); })
      .on_key_down((e, ctx) => {
        if (e.key === "escape") { this.notice = null; this.pending = null; ctx.notify(); }
      })
      .child(h_flex().h(32).flex_none().bg(t.chrome).border_b(1).border_color(t.border)
        .child(h_flex().id("ed-strip").flex_1().min_w(0).h_full().overflow_x_scrollbar()
          .children(this.files.map(tab))
          .child(h_flex().id("ed-new").h(22).px(7).mx(4).flex_none().items_center().justify_center().self_center().rounded(4)
            .text_size(15).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent)).on_click((_e, ctx) => this.newBuffer(ctx))
            .tooltip("New untitled file").child("+")))
        .child(h_flex().h_full().flex_none().pl(4).pr(4).gap(1).items_center().border_l(1).border_color(t.border)
          .when(this.files.length > 1, (el) => el.child(tool("ed-files", `${this.files.length} ⌄`)
            .tooltip("Open files  (Ctrl+PageUp / Ctrl+PageDown)").on_click(() => this.fileMenu())))
          .child(tool("ed-diff", this.diff ? "Edit" : "Diff").when(this.diff, (el) => el.text_color(t.accent))
            .on_click((_e, ctx) => this.toggleDiff(ctx)))
          .child(tool("ed-blame", "Blame")
            .on_click(() => {
              const file = this.active();
              if (file?.path) openOverlay({ mod: "agentee-git", kind: "dialog", width: 640, height: 620, props: { root: dirname(file.path), file: file.path } });
            }))
          .child(tool("ed-save", "Save").on_click((_e, ctx) => ctx.spawn(async (cx) => { await this.save(cx); })))
          .child(div().id("ed-close-pane").size(22).flex_none().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Close the editor pane").on_click(() => this.closePane())
            .child(svg("mods/agentee-tabs/icons/close.svg").size(11)))))
      .when(Boolean(this.notice), (el) => el.child(this.bar(t, this.notice, t.ansi2, [["Dismiss", "dim", (_e, ctx) => { this.notice = null; ctx.notify(); }]])))
      .when(Boolean(f?.error), (el) => el.child(this.bar(t, f.error, t.blocked, [
        ["Overwrite", "primary", (_e, ctx) => ctx.spawn(async (cx) => { await this.overwrite(cx); })],
        ["Reload", "dim", (_e, ctx) => ctx.spawn(async (cx) => { await this.reloadFromDisk(cx); })],
        ["Dismiss", "dim", (_e, ctx) => { f.error = null; this.pending = null; ctx.notify(); }],
      ])))
      .when(Boolean(f?.external) && !f?.error, (el) => el.child(this.bar(t, `${f.name} changed on disk`, t.ansi3, [
        ["Overwrite", "primary", (_e, ctx) => ctx.spawn(async (cx) => { await this.overwrite(cx); })],
        ["Reload", "dim", (_e, ctx) => ctx.spawn(async (cx) => { await this.reloadFromDisk(cx); })],
      ])))
      .when(Boolean(close), (el) => el.child(this.bar(t, `Save changes to ${close.name}?`, t.ansi3, [
        ["Save", "primary", (_e, ctx) => { this.pending = null; ctx.spawn(async (ctx) => { if (await this.save(ctx, close)) this.closeFile(close.id, ctx); }); }],
        ["Discard", "dim", (_e, ctx) => this.closeFile(close.id, ctx)],
        ["Cancel", "dim", (_e, ctx) => { this.pending = null; ctx.notify(); }],
      ])))
      .when(this.saveAs != null && this.saveAs === this.activeId, (el) => el.child(h_flex().px(10).py(6).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(11.5).text_color(t.muted).child("Save as"))
        .child(Input.new(this.saveAsInput).flex_1())
        .child(div().id("ed-saveas-ok").h(22).px(8).flex().items_center().rounded(4).bg(t.solid).text_color(t.solid_foreground)
          .on_click((_e, ctx) => ctx.spawn(async (cx) => { await this.commitSaveAs(cx); })).child("Create"))))
      .when(this.diff, (el) => el.child(this.diffView(t)))
      .child(v_flex().flex_1().min_h(0)
        .when(!this.diff && Boolean(f?.editor), (el) => el.child(Editor.new(f.editor).id(`ed-code-${f.id}-${f.gen ?? 0}`).flex_1().min_h(0)))
        .when(!this.diff && f && !f.editor && !f.error, (el) => el.child(div().p(12).text_color(t.dim).child("Loading file\u2026")))
        .when(!this.diff && !f, (el) => el.child(v_flex().size_full().items_center().justify_center().gap(8).text_color(t.dim)
          .child(div().text_size(13).text_color(t.muted).child("No file open"))
          .child(div().text_size(11.5).child("Pick a file in Files, or press + for a new buffer"))
          .child(div().text_size(11.5).child("Ctrl/Cmd+S saves · Ctrl/Cmd+W closes the file"))
          .child(div().id("ed-empty-close").h(24).px(10).flex().items_center().rounded(5).mt(4)
            .bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.closePane()).child("Close this pane")))));
  }
}

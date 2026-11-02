// abdh editor: a real file editor in a mod pane.
// Chrome-like file tabs, save to disk, dirty state, external-change handling,
// unsaved-change confirmation, and the shared("abdh.editor") stats the status bar reads.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, watchFolder, theme, shared, setShared, props, nextCommand, settings,
  appHome, notify, window, openOverlay, panes, run, focused,
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
    this.lastOpen = shared("abdh.open")?.nonce ?? null;
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
    // Shared open requests arrive while another mod is rendering. A spawn made
    // from render never runs, so poll from a timer instead.
    cx.timer.every(150, (cx) => this.consume(cx));
    if (p.path) cx.spawn(async (cx) => { await this.open(p.path, cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "save") await this.save(cx);
        else if (command === "close") { if (this.active()) this.requestClose(cx); else this.closePane(); }
        else if (command === "saveas") this.startSaveAs(cx);
        else if (command === "focus") this.handle.focus();
        else if (command === "diff") this.toggleDiff(cx);
        cx.notify();
      }
    });
  }

  active() { return this.files.find((f) => f.id === this.activeId) ?? null; }

  myPane() {
    const f = focused();
    const list = panes().filter((p) => p.mod === "abdh-editor" && p.tab === f?.tab);
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
      const dir = `${appHome()}/abdh-recovery`;
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const f of dirty) await fs.writeFile(`${dir}/${f.name}.${stamp}.txt`, f.text, "utf8");
      notify({ title: "Unsaved edits recovered", body: `${dirty.length} file(s) in abdh-recovery`, level: "warning", timeout: 8000 });
    } catch { /* the window is closing; nothing else to do */ }
  }

  publish() {
    const f = this.active();
    setShared("abdh.editor", f ? {
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
    const t = theme();
    const ext = extOf(file.path ?? file.name);
    file.text = text;
    file.saved = text;
    file.dirty = false;
    file.external = null;
    file.error = null;
    file.language = LANG[ext] ?? ext ?? "txt";
    file.label = LABEL[ext] ?? (ext ? ext.toUpperCase() : "Text");
    file.readonly = Boolean(file.on);
    file.editor = EditorState.new({
      readonly: Boolean(file.on),
      language: file.language,
      value: text,
      line_numbers: true,
      folding: true,
      soft_wrap: false,
      font_family: settings().font_family,
      font_size: shared("abdh.settings")?.appearance?.monoSize ?? 13,
      syntax: {
        keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
        type: t.ansi3, number: t.ansi1, constant: t.ansi6, variable: t.foreground,
        operator: t.muted, punctuation: t.muted, boolean: t.ansi3,
      },
    });
    file.editor.on("change", () => {
      file.text = file.editor.value();
      file.dirty = file.text !== file.saved;
      this.publish();
      cx.notify();
    });
    if (file.id === this.activeId) this.publish();
  }

  watch(dir, cx) {
    if (this.watchers.has(dir)) return;
    this.watchers.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(dir);
          for (const f of this.files) {
            if (!f.path || !samePath(dirname(f.path), dir)) continue;
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
      if (disk === null) { file.external = ""; return; }
      if (disk === file.saved) return;
      if (!file.dirty) {
        this.fill(file, disk, cx);
        this.notice = `Reloaded ${file.name} from disk`;
      } else {
        file.external = disk;
      }
    } catch { /* ignore a transient read */ }
  }

  async save(cx) {
    const f = this.active();
    if (!f) return false;
    if (f.on) { f.error = "This file is on another machine and is read-only here"; cx.notify(); return false; }
    if (!f.path) { this.startSaveAs(cx); return false; }
    try {
      await writeTextFile(f.path, f.text, f.saved);
      f.saved = f.text;
      f.dirty = false;
      f.external = null;
      f.error = null;
      this.notice = `Saved ${f.name}`;
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
    if (!f?.path) return;
    try {
      const disk = await readTextFile(f.path);
      await writeTextFile(f.path, f.text, disk);
      f.saved = f.text;
      f.dirty = false;
      f.external = null;
      f.error = null;
      this.pending = null;
      this.notice = `Saved ${f.name}`;
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
    const text = f.text, file = f.path, root = this.root ?? dirname(f.path);
    this.diffData = { loading: true };
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["-C", root, "rev-parse", "--show-toplevel"]);
        if (top.code !== 0) { this.diffData = { error: "Not a git repository" }; cx.notify(); return; }
        const repo = String(top.stdout).trim();
        const repoSlash = repo.replace(/\\/g, "/").replace(/\/+$/, "");
        const normFile = String(file).replace(/\\/g, "/");
        const rel = normFile.startsWith(repoSlash + "/") ? normFile.slice(repoSlash.length + 1) : normFile;
        const head = await exec("git", ["-C", repo, "show", `HEAD:${rel}`]);
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
    return v_flex().id("abdh-editor-diff").size_full().min_h(0).text_size(11.5)
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
    const open = shared("abdh.open");
    if (open && open.nonce !== this.lastOpen) {
      this.lastOpen = open.nonce;
      if (open.root) this.root = open.root;
      cx.spawn(async (cx) => { await this.open(open.path, cx, open.on ?? null); });
    }
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

    const tab = (file, i) => {
      const on = file.id === this.activeId, hot = this.hovered === file.id;
      return h_flex().id(`ed-tab-${file.id}`).h(30).max_w(280).min_w(140).px(11).gap(7).flex_none().items_center()
        .rounded_t(7)
        .border_t(2)
        .border_color(on ? t.accent : "#00000000")
        .bg(on ? t.background : t.chrome)
        .text_size(12).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .hover((s) => s.bg(on ? t.background : t.surface))
        .on_hover((hovered) => { this.hovered = hovered ? file.id : null; })
        .on_mouse_down("left", () => { this.pressed = i; })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) {
            const [moved] = this.files.splice(from, 1);
            this.files.splice(i, 0, moved);
            cx.notify();
          } else this.activate(file.id, cx);
        })
        .when(file.dirty, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.ansi3)).tooltip("Unsaved changes"))
        .child(div().flex_1().min_w(0).truncate().child(file.name))
        .when(on || hot, (el) => el.child(div().id(`ed-x-${file.id}`).size(14).flex_none().flex().items_center().justify_center().rounded(3)
          .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_mouse_down("left", (_e, ctx) => ctx.stop_propagation())
          .on_click((_e, ctx) => { ctx.stop_propagation(); this.requestClose(ctx, file.id); })
          .child(svg("mods/abdh-tabs/icons/close.svg").size(10))));
    };

    return v_flex().id("abdh-editor").size_full().min_h(0).bg(t.background).text_size(12.5).text_color(t.foreground)
      .on_key_down((e, ctx) => {
        if (e.key === "escape") { this.notice = null; this.pending = null; ctx.notify(); }
      })
      .child(h_flex().h(29).flex_none().px(4).gap(2).items_end().bg(t.chrome).border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).gap(2).items_end().overflow_x_scrollbar()
          .children(this.files.map(tab))
          .child(h_flex().id("ed-new").h(22).px(7).ml(2).flex_none().items_center().justify_center().rounded(4)
            .text_size(15).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.accent)).on_click(() => this.newBuffer(cx))
            .tooltip("New untitled file").child("+")))
        .child(h_flex().gap(2).items_center()
          .child(div().id("ed-diff").h(22).px(8).flex().items_center().rounded(4).text_size(11)
            .text_color(this.diff ? t.accent : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, ctx) => this.toggleDiff(ctx)).child(this.diff ? "Edit" : "Diff"))
          .child(div().id("ed-blame").h(22).px(8).flex().items_center().rounded(4).text_size(11).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => {
              const file = this.active();
              if (file?.path) openOverlay({ mod: "abdh-git", kind: "dialog", width: 640, height: 620, props: { root: this.root, file: file.path } });
            }).child("Blame"))
          .child(div().id("ed-save").h(22).px(8).flex().items_center().rounded(4).text_size(11).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, ctx) => this.save(ctx)).child("Save"))
          .child(div().id("ed-close-pane").size(22).flex_none().flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Close the editor pane").on_click(() => this.closePane())
            .child(svg("mods/abdh-tabs/icons/close.svg").size(11)))))
      .when(Boolean(this.notice), (el) => el.child(this.bar(t, this.notice, t.ansi2, [["Dismiss", "dim", (_e, ctx) => { this.notice = null; ctx.notify(); }]])))
      .when(Boolean(f?.error), (el) => el.child(this.bar(t, f.error, t.blocked, [
        ["Overwrite", "primary", (_e, ctx) => this.overwrite(ctx)],
        ["Reload", "dim", (_e, ctx) => this.reloadFromDisk(ctx)],
        ["Dismiss", "dim", (_e, ctx) => { f.error = null; this.pending = null; ctx.notify(); }],
      ])))
      .when(Boolean(f?.external) && !f?.error, (el) => el.child(this.bar(t, `${f.name} changed on disk`, t.ansi3, [
        ["Overwrite", "primary", (_e, ctx) => this.overwrite(ctx)],
        ["Reload", "dim", (_e, ctx) => this.reloadFromDisk(ctx)],
      ])))
      .when(Boolean(close), (el) => el.child(this.bar(t, `Save changes to ${close.name}?`, t.ansi3, [
        ["Save", "primary", (_e, ctx) => { this.pending = null; ctx.spawn(async (ctx) => { if (await this.save(ctx)) this.closeFile(close.id, ctx); }); }],
        ["Discard", "dim", (_e, ctx) => this.closeFile(close.id, ctx)],
        ["Cancel", "dim", (_e, ctx) => { this.pending = null; ctx.notify(); }],
      ])))
      .when(this.saveAs != null && this.saveAs === this.activeId, (el) => el.child(h_flex().px(10).py(6).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(11.5).text_color(t.muted).child("Save as"))
        .child(Input.new(this.saveAsInput).flex_1())
        .child(div().id("ed-saveas-ok").h(22).px(8).flex().items_center().rounded(4).bg(t.solid).text_color(t.solid_foreground)
          .on_click((_e, ctx) => this.commitSaveAs(ctx)).child("Create"))))
      .when(this.diff, (el) => el.child(this.diffView(t)))
      .child(v_flex().flex_1().min_h(0)
        .when(!this.diff && Boolean(f?.editor), (el) => el.child(Editor.new(f.editor).id(`ed-code-${f.id}`).flex_1().min_h(0)))
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

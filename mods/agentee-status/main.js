// Agentee status bar: the focused folder's git state on the left, the file the
// editor pane published to shared("agentee.editor") on the right.
// Cursor line/column is not exposed by EditorState yet, so it is not shown.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, shared, setShared, run, home, window } from "herdr";

function shortPath(p) {
  if (!p) return "";
  const h = home();
  const norm = p.replace(/\\/g, "/");
  if (norm === h.replace(/\\/g, "/")) return "~";
  const parts = (norm.startsWith(h.replace(/\\/g, "/")) ? norm.slice(h.length) : norm).split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

const dirname = (p) => p.replace(/\\/g, "/").replace(/\/[^/]*$/, "");

// git status --porcelain=v2 --branch -> branch and change counts.
function parseStatus(out) {
  const g = { branch: null, ahead: 0, behind: 0, modified: 0, added: 0, deleted: 0, staged: 0, conflicted: 0, changes: 0 };
  for (const line of out.split("\n")) {
    // Changed paths, each once (the counts below can count one twice).
    if (/^[12u?] /.test(line)) g.changes++;
    if (line.startsWith("# branch.head ")) g.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      g.ahead = Math.abs(parseInt(a, 10)) || 0;
      g.behind = Math.abs(parseInt(b, 10)) || 0;
    } else if (line.startsWith("?")) g.added++;
    else if (line.startsWith("u")) g.conflicted++;
    else if (/^[12] /.test(line)) {
      const xy = line.slice(2, 4);
      const [x, y] = xy.split("");
      if (x === "A") g.added++;
      else if (x !== ".") g.staged++;
      if (y === "D" || x === "D") g.deleted++;
      else if (y === "M" || y === "T" || x === "R" || x === "C") g.modified++;
    }
  }
  return g;
}

export default class Status extends View {
  init(_props, cx) {
    this.git = null;
    this.cwd = undefined;
    this.at = 0;
    // The open editor file's project root, resolved once per file.
    this.fileRoot = null;
    // A spawn made from render never runs, so the timer does all the looking:
    // a folder change is read within a second, the same folder every 5 s.
    // shared("agentee.git.changed"): an editor save or a git action, read at once.
    cx.timer.every(1000, (cx) => {
      const changed = shared("agentee.git.changed") ?? null;
      const poke = changed !== this.changed;
      this.changed = changed;
      this.look(cx, poke || Date.now() - this.at >= 5000);
    });
  }

  // The focused folder. An editor pane shows a file: use that file's project
  // root so the status bar and Git button follow the project, not the tab's
  // terminal (often home). Otherwise follow the focused/tab terminal, then the
  // active space, as the folder label does.
  folder() {
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const open = shared("agentee.editor");
    if (open?.path && pane?.mod === "agentee-editor") {
      return this.fileRoot?.path === open.path ? this.fileRoot.root : dirname(open.path);
    }
    return f?.cwd ?? panes().find((p) => p.tab === f?.tab && p.terminal)?.cwd ?? spaces().find((s) => s.active)?.folder ?? null;
  }

  look(cx, force = false) {
    if (this.inflight) return;
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const open = shared("agentee.editor");
    if (!open?.path) {
      this.fileRoot = null;
      if (shared("agentee.project")) setShared("agentee.project", null);
    }
    if (open?.path && pane?.mod === "agentee-editor" && this.fileRoot?.path !== open.path) {
      const dir = dirname(open.path), want = open.path, space = f?.space ?? null;
      const on = (spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active))?.machine ?? undefined;
      this.fileRoot = { path: want, root: dir, pending: true };
      cx.spawn(async (cx) => {
        const r = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { on }).catch(() => null);
        const top = r && r.code === 0 ? r.stdout.trim().replace(/\\/g, "/") : null;
        if (this.fileRoot?.path !== want) return;
        this.fileRoot = { path: want, root: top || dir };
        setShared("agentee.project", { space, path: want, root: this.fileRoot.root });
        this.cwd = undefined;
        this.look(cx, true);
        cx.notify();
      });
    }
    const cwd = this.folder();
    if (!force && cwd === this.cwd) return;
    this.cwd = cwd;
    this.at = Date.now();
    if (!cwd) { this.setGit(null); cx.notify(); return; }
    const on = (spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active))?.machine ?? undefined;
    this.inflight = true;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd, on }).catch(() => null);
      this.inflight = false;
      if (this.cwd !== cwd) return;
      this.setGit(r && r.code === 0 ? { cwd, ...parseStatus(r.stdout) } : null);
      cx.notify();
    });
  }

  // Shared for the window bar's Git button, only when it changed (setShared
  // re-renders every mod).
  setGit(git) {
    this.git = git;
    const pub = git ? { cwd: git.cwd, branch: git.branch, changes: git.changes, ahead: git.ahead, behind: git.behind, conflicted: git.conflicted } : null;
    const key = JSON.stringify(pub);
    if (key !== this.published) {
      this.published = key;
      setShared("agentee.git.status", pub);
    }
  }

  render() {
    const t = theme();
    const g = this.git;
    const editorOpen = panes().some((p) => p.mod === "agentee-editor" && p.tab === focused()?.tab);
    const ed = editorOpen ? shared("agentee.editor") : null;
    const ui = shared("agentee.settings")?.status ?? {};
    const folder = this.folder();
    const mac = window()?.platform === "macos";
    const ctrl = mac ? "⌘" : "Ctrl+";
    const chip = (id, text, color, tip) => div().id(id).flex_none().text_color(color ?? t.muted)
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(text);

    return h_flex().size_full().px(12).gap(12).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.5).text_color(t.dim)
      .child(h_flex().gap(6).items_center().min_w(0).flex_shrink(1)
        .child(svg("mods/agentee-status/icons/monitor.svg").size(12).flex_none())
        .child(div().min_w(0).truncate().child(folder ? shortPath(folder) : "no folder")))
      .when(Boolean(g) && ui.gitBranch !== false, (el) => el.child(h_flex().items_center().gap(6)
        .child(svg("mods/agentee-status/icons/branch.svg").size(12).flex_none())
        .child(chip("st-branch", g.branch ?? "detached", t.muted, `${g.cwd}\n${g.branch ?? "detached"}`))
        .when(g.ahead > 0, (x) => x.child(chip("st-ahead", `↑${g.ahead}`, t.ansi2, "commits ahead")))
        .when(g.behind > 0, (x) => x.child(chip("st-behind", `↓${g.behind}`, t.ansi3, "commits behind")))
        .when(ui.gitChanges !== false && g.modified > 0, (x) => x.child(chip("st-mod", `${g.modified}~`, t.ansi3, "modified files")))
        .when(ui.gitChanges !== false && g.added > 0, (x) => x.child(chip("st-new", `+${g.added}`, t.ansi2, "new or untracked files")))
        .when(ui.gitChanges !== false && g.deleted > 0, (x) => x.child(chip("st-del", `−${g.deleted}`, t.ansi1, "deleted files")))
        .when(ui.gitChanges !== false && g.staged > 0, (x) => x.child(chip("st-staged", `${g.staged}✓`, t.accent, "staged changes")))
        .when(ui.gitChanges !== false && g.conflicted > 0, (x) => x.child(chip("st-conflict", `${g.conflicted}!`, t.blocked, "merge conflicts")))))
      .child(div().flex_1())
      .when(Boolean(ed), (el) => el.child(h_flex().gap(10).items_center().min_w(0)
        .when(ed.dirty, (x) => x.child(div().size(6).rounded_full().bg(t.ansi3).tooltip("Unsaved changes")))
        .child(chip("st-file", ed.name, ed.dirty ? t.foreground : t.muted))
        .child(chip("st-lang", ed.language, t.accent))
        .when(ui.lines !== false, (x) => x.child(chip("st-lines", `${ed.lines} lines`, t.dim)))
        .when(ui.characters === true, (x) => x.child(chip("st-chars", `${ed.chars} chars`, t.dim)))
        .when(ed.words != null, (x) => x.child(chip("st-words", `${ed.words} words`, t.dim)))
        .child(chip("st-eol", ed.eol, t.dim))
        .child(chip("st-enc", ed.encoding, t.dim))
        .child(div().id("st-save").flex_none().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click(() => run("agentee-editor.save")).child(`${ctrl}S`)
          .tooltip("Save (handled by the editor pane when it has focus)"))))
      .when(!ed, (el) => el.child(h_flex().gap(6).items_center().text_color(t.dim)
        .child("no file open")
        .child(div().w(1).h(11).bg(t.border))
        .child(div().id("st-open").hover((s) => s.text_color(t.foreground)).on_click(() => {
          run("layout.show", { id: "panel" });
          run("layout.select", { stack: "panel-body", child: "panel-files" });
        }).child("open a file in Files"))));
  }
}

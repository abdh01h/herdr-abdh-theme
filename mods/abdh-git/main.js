// abdh-git: a compact overlay for branches, checkout, branch creation and
// merges, plus a one-line blame card for a file:line.
//
// Opened by the layout's own controls (no docked placement):
//   openOverlay({ kind: "dialog", mod: "abdh-git", width: 520, height: 520,
//                 props: { root, action?: "branches" | "create" | "merge", branch?, file?, line? } })
//
// Every operation is shown as a confirm step before git runs. Nothing here
// discards work silently: no reset, no clean, no stash drop, no merge --abort.
// Deleting a branch asks in a dialog; an unmerged local branch asks a second
// time before `branch -D`, and a remote delete says it affects everyone. When git
// refuses because of local changes or a conflict, stderr is shown verbatim and
// the worktree is left exactly as git left it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, props, closeOverlay, notify, theme, shared, setShared, focused, spaces, home } from "herdr";
import { READ, REF_FORMAT, parseStatus, parseBranches, parseBlame, parseFileBlame, ago, targetOf } from "./git.js";

const MODES = [
  { id: "branches", label: "Branches" },
  { id: "history", label: "History" },
  { id: "create", label: "New branch" },
  { id: "merge", label: "Merge" },
];

// git with the user's environment; a git that cannot start is an error string,
// not a throw, so one failed probe only blanks what it fed.
async function runGit(cwd, args) {
  try {
    const r = await exec("git", args, { cwd });
    return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim(), code: r.code };
  } catch (error) {
    return { ok: false, out: "", err: String(error?.message ?? error), code: null };
  }
}

const baseName = (path) => {
  const clean = String(path ?? "").replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
};
const same = (a, b) => Boolean(a && b && a.kind === b.kind && a.name === b.name);
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const few = (paths, max = 4) =>
  paths.slice(0, max).join(", ") + (paths.length > max ? ` and ${paths.length - max} more` : "");
const firstLine = (text) => String(text ?? "").split("\n").find((l) => l.trim()) ?? "";

// The refresh interval abdh-settings stores, in seconds. The settings mod owns
// the object; this only reads it.
function refreshSeconds() {
  const settings = shared("abdh.settings");
  const value = Number(settings && typeof settings === "object" ? settings.git?.refresh : NaN);
  return Math.max(2, Math.floor(Number.isFinite(value) ? value : 5));
}

export default class AbdhGit extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = ["create", "merge", "history"].includes(p.action) ? p.action : "branches";
    this.wantedBranch = p.branch ?? null;
    this.selected = null;
    // Folded branch sections; remote starts folded, and the choice is kept.
    const folded = shared("abdh.git.folded");
    this.folded = new Set(Array.isArray(folded) ? folded : ["remote"]);
    this.confirm = null;
    this.notice = "";
    this.busy = false;
    this.refreshing = false;
    this.loadSeq = 0;
    this.dirty = new Set();
    this.blameInfo = null;
    this.fileBlame = null;
    this.history = { loading: false, rows: [], error: null };
    this.focused = new Set();

    this.state = {
      loading: true,
      root: null,
      folder: null,
      error: null,
      refsError: null,
      branches: [],
      counts: null,
      branch: null,
      oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      detached: false,
    };

    this.nameInput = InputState.new({ placeholder: "new branch name", value: "" });
    this.sourceInput = InputState.new({ placeholder: "source branch", value: "" });
    this.nameValue = "";
    this.sourceValue = "";
    this.checkout = true;

    const watch = (key, state) => {
      state.on("change", (_e, cx) => {
        this[key] = state.value();
        if (key === "nameValue") this.notice = "";
        cx.notify();
      });
      state.on("focus", (_e, cx) => { this.focused.add(key); cx.notify(); });
      state.on("blur", (_e, cx) => { this.focused.delete(key); cx.notify(); });
    };
    watch("nameValue", this.nameInput);
    watch("sourceValue", this.sourceInput);
    this.nameInput.on("submit", (_e, cx) => this.askCreate(cx));
    this.sourceInput.on("submit", (_e, cx) => this.askCreate(cx));

    this.handle = cx.focus_handle();
    this.handle.focus();

    // A blame-only overlay never shows branch data: no polling for it.
    if (p.file && !p.line) { this.loadFileBlame(cx); return; }

    // One gentle tick re-reads the settings interval, so changing it in
    // abdh-settings takes effect without reloading this overlay. Data is only
    // fetched when the interval is due.
    this.refreshSeconds = refreshSeconds();
    this.lastRefreshAt = 0;
    cx.timer.every(1000, (timerCx) => {
      const secs = refreshSeconds();
      if (secs !== this.refreshSeconds) {
        this.refreshSeconds = secs;
        timerCx.notify();
      }
      if (this.busy || this.refreshing) return;
      if (Date.now() - this.lastRefreshAt < secs * 1000) return;
      this.refresh(timerCx);
    });

    this.refresh(cx);
    if (p.file && p.line) this.loadBlame(cx);
    else if (p.file) this.loadFileBlame(cx);
  }

  // The folder git runs in: props().root, else the live focused pane, else the
  // first space, else home.
  folder() {
    const p = props() ?? {};
    if (p.root) return p.root;
    const f = focused();
    if (f?.cwd) return f.cwd;
    const all = spaces();
    return all[0]?.folder || home();
  }

  loadHistory(cx) {
    const root = this.state.root;
    if (!root) { this.history = { loading: false, rows: [], error: this.state.error || "no repository" }; return; }
    if (this.history.loading) return;
    this.history = { loading: true, rows: this.history.rows ?? [], error: null };
    cx.spawn(async (cx) => {
      const r = await runGit(root, ["--no-optional-locks", "log", "-n", "150", "--date=unix",
        "--pretty=format:%H%x00%h%x00%an%x00%at%x00%s%x00%D"]);
      if (!r.ok) this.history = { loading: false, rows: [], error: (r.err || "git log failed").trim() };
      else {
        const rows = r.out.split("\n").filter(Boolean).map((line) => {
          const [hash, short, author, time, subject, refs] = line.split("\0");
          return { hash, short, author, time: Number(time) || null, subject, refs };
        });
        this.history = { loading: false, rows, error: null };
      }
      cx.notify();
    });
  }

  historyBody(t) {
    const h = this.history ?? { loading: false, rows: [], error: null };
    if (h.error) return div().p(16).text_color(t.blocked).text_size(11).child(h.error);
    if (h.loading && !h.rows.length) return div().p(16).text_color(t.dim).child("Reading commits\u2026");
    if (!h.rows.length) return div().p(16).text_color(t.dim).child("No commits");
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar()
      .child(h_flex().h(24).flex_none().px(12).items_center().gap(8).border_b(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child(div().font_semibold().child("COMMITS"))
        .child(div().flex_1())
        .child(div().child(`${h.rows.length}${h.loading ? " \u00b7 refreshing" : ""}`)))
      .children(h.rows.map((c, i) => h_flex().id(`gh-${c.short}-${i}`).py(6).px(12).gap(9).items_center()
        .border_b(1).border_color(t.border)
        .when(i % 2 === 0, (x) => x.bg(t.surface))
        .child(div().w(58).flex_none().text_size(10).text_color(t.accent).child(c.short))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(11.5).text_color(t.foreground).child(c.subject || "(no subject)"))
          .child(h_flex().gap(7).items_center().text_size(9.5).text_color(t.dim)
            .child(div().child(c.author || "unknown"))
            .when(Boolean(c.time), (x) => x.child(div().child(ago(c.time))))
            .when(Boolean(c.refs), (x) => x.child(div().min_w(0).truncate().text_color(t.muted).child(c.refs)))))));
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        await this.load();
      } catch (error) {
        this.state = { ...this.state, loading: false, root: null, error: String(error?.message ?? error) };
      } finally {
        this.refreshing = false;
      }
      if (this.mode === "history") this.loadHistory(cx);
      cx.notify();
    });
  }

  // Reads everything the panel shows. Never writes shared state and never runs
  // anything that changes the repository.
  async load() {
    const seq = ++this.loadSeq;
    this.lastRefreshAt = Date.now();
    const folder = this.folder();
    const top = await runGit(folder, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      if (seq === this.loadSeq) {
        this.dirty = new Set();
        this.state = {
          ...this.state,
          loading: false,
          root: null,
          folder,
          error: (top.err || "Not a git repository.").trim(),
          refsError: null,
          branches: [],
          counts: null,
          branch: null,
          oid: null,
          upstream: null,
          ahead: null,
          behind: null,
          detached: false,
        };
      }
      return;
    }
    const root = top.out.trim();
    const [status, refs] = await Promise.all([
      runGit(root, [...READ, "status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]),
      runGit(root, ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"]),
    ]);
    if (seq !== this.loadSeq) return;

    let branchInfo;
    let counts = null;
    let entries = [];
    if (status.ok) {
      const parsed = parseStatus(status.out);
      branchInfo = parsed.branch;
      counts = parsed.counts;
      entries = parsed.entries;
    } else {
      // The status probe failed: name the branch from rev-parse, but do not
      // invent change counts.
      const [head, oid] = await Promise.all([
        runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
        runGit(root, ["rev-parse", "--short", "HEAD"]),
      ]);
      if (seq !== this.loadSeq) return;
      const detached = head.ok && head.out.trim() === "HEAD";
      branchInfo = {
        head: head.ok && !detached ? head.out.trim() : null,
        oid: oid.ok ? oid.out.trim() : null,
        upstream: null,
        ahead: null,
        behind: null,
        detached,
      };
    }

    const branches = refs.ok ? parseBranches(refs.out) : [];
    // Current branch first, then newest commit first as git sorted them.
    const current = branchInfo.head;
    branches.sort((a, b) => Number(b.kind === "local" && b.name === current) - Number(a.kind === "local" && a.name === current) || b.at - a.at);

    const prev = this.selected;
    this.selected = prev ? branches.find((b) => same(b, prev)) ?? null : null;
    if (this.wantedBranch) {
      const want = this.wantedBranch;
      this.selected =
        branches.find((b) => b.name === want || (b.kind === "remote" && b.name.endsWith(`/${want}`))) ?? null;
      this.wantedBranch = null;
    }

    this.dirty = new Set(entries.map((e) => e.path));
    this.state = {
      loading: false,
      root,
      folder,
      error: status.ok ? null : (status.err || "git status failed.").trim(),
      refsError: refs.ok ? null : (refs.err || "git for-each-ref failed.").trim(),
      branches,
      counts,
      branch: branchInfo.head,
      oid: branchInfo.oid,
      upstream: branchInfo.upstream,
      ahead: branchInfo.ahead,
      behind: branchInfo.behind,
      detached: Boolean(branchInfo.detached),
    };
  }

  // One line's blame, for the card below and for other mods to mirror.
  async blame(root, file, line) {
    const top = await runGit(root, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) return { error: (top.err || "Not a git repository.").trim() };
    const n = Math.max(1, Math.trunc(Number(line)) || 1);
    const r = await runGit(top.out.trim(), ["blame", "--line-porcelain", "-L", `${n},${n}`, "--", file]);
    return r.ok ? parseBlame(r.out) : { error: (r.err || r.out || "git blame failed.").trim() };
  }

  // Whole-file blame: every line's last commit, for the blame view.
  async loadFileBlame(cx) {
    const p = props() ?? {};
    this.fileBlame = { loading: true, rows: [], error: null };
    cx.spawn(async (cx) => {
      // The file's own folder finds its repo (nested repos, a Files root above it).
      const file = String(p.file ?? "").replace(/\\/g, "/");
      const dir = file.lastIndexOf("/") >= 0 ? file.slice(0, file.lastIndexOf("/") + 1) : this.folder();
      const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
      if (!top.ok) {
        this.fileBlame = { loading: false, rows: [], error: (top.err || "not a git repository").trim() };
        cx.notify();
        return;
      }
      const root = top.out.trim();
      const rootSlash = root.replace(/\\/g, "/").replace(/\/+$/, "");
      const rel = file.startsWith(rootSlash + "/") ? file.slice(rootSlash.length + 1) : file;
      const r = await runGit(root, ["--no-optional-locks", "blame", "--line-porcelain", "--", rel]);
      if (!r.ok) this.fileBlame = { loading: false, rows: [], error: (r.err || "git blame failed").trim() };
      else this.fileBlame = { loading: false, rows: parseFileBlame(r.out).slice(0, 1200), error: null };
      cx.notify();
    });
  }

  blameView(t) {
    const p = props() ?? {};
    const b = this.fileBlame ?? { loading: true, rows: [], error: null };
    return v_flex().id("abdh-git-blame").size_full().min_h(0).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_none().text_size(12).font_semibold().child("Git blame"))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`${baseName(p.file)} \u00b7 ${baseName(this.folder())}`))
        .child(div().id("abdh-git-blame-close").size(22).flex_none().flex().items_center().justify_center().rounded(5)
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(p.overlay)).child("\u2715")))
      .when(b.loading, (el) => el.child(div().p(16).text_color(t.dim).child("Reading history\u2026")))
      .when(Boolean(b.error), (el) => el.child(div().p(16).text_color(t.blocked).child(b.error)))
      .when(!b.loading && !b.error, (el) => el
        .child(div().flex_1().min_h(0).overflow_y_scrollbar()
          .children(b.rows.map((r, i) => h_flex().id(`bl-${i}-${r.line}`).h(22).px(10).gap(8).items_center()
            .when(i % 2 === 0, (x) => x.bg(t.surface))
            .child(div().w(40).flex_none().text_size(10).text_color(t.dim).child(String(r.line)))
            .child(div().w(58).flex_none().text_size(10).text_color(r.author === "Not committed" ? t.accent : t.muted).child(r.short))
            .child(div().w(150).flex_none().truncate().text_size(10.5).text_color(t.muted).tooltip(r.summary).child(r.author || "unknown"))
            .child(div().w(76).flex_none().text_size(10).text_color(t.dim).child(r.time ? ago(r.time) : "\u2014"))
            .child(div().flex_1().min_w(0).truncate().text_size(11).child(r.text || " ")))))
        .when(b.rows.length >= 1200, (x) => x.child(div().px(12).py(6).text_size(10).text_color(t.dim).child("Showing the first 1,200 lines"))));
  }

  // The blame card's data, read from props().file at props().line.
  loadBlame(cx) {
    const p = props() ?? {};
    this.blameInfo = { loading: true };
    cx.spawn(async (cx) => {
      this.blameInfo = await this.blame(this.folder(), p.file, p.line);
      cx.notify();
    });
  }

  // Not named close(): that is the View lifecycle hook, called when the
  // overlay is already going away.
  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  setMode(id, cx) {
    if (this.mode === id) return;
    this.mode = id;
    this.confirm = null;
    this.notice = "";
    if (id === "history") this.loadHistory(cx);
    if (id === "create") {
      if (!this.sourceValue) {
        const source = this.state.branch || "HEAD";
        this.sourceValue = source;
        this.sourceInput.set_value(source);
      }
      this.nameInput.focus();
    }
    cx.notify();
  }

  moveSelection(step) {
    const st = this.state;
    if (!st.root) return;
    const all = st.branches ?? [];
    const list = (this.mode === "merge" ? all.filter((b) => !(b.kind === "local" && b.name === st.branch)) : all)
      .filter((b) => !this.folded.has(b.kind));
    if (!list.length) return;
    const at = this.selected ? list.findIndex((b) => same(b, this.selected)) : -1;
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    this.selected = list[next];
    this.confirm = null;
    if (this.mode === "create") {
      this.sourceValue = this.selected.name;
      this.sourceInput.set_value(this.sourceValue);
    }
  }

  askCheckout(cx) {
    const st = this.state;
    const sel = this.selected;
    if (!st.root || !sel) return;
    const target = targetOf(sel, st.branches);
    if (!target) return;
    if (target.ref === st.branch && !target.track) {
      this.notice = `${sel.name} is already checked out.`;
      cx.notify();
      return;
    }
    this.notice = "";
    this.confirm = { kind: "checkout", branch: sel.name, target: target.ref, track: target.track };
    cx.notify();
  }

  askMerge(cx) {
    const st = this.state;
    const sel = this.selected;
    if (!st.root || !sel) return;
    if (st.detached) {
      this.notice = "Detached HEAD: check out a branch before merging.";
      cx.notify();
      return;
    }
    if (!st.branch) {
      this.notice = "The current branch is unknown; merge is unavailable.";
      cx.notify();
      return;
    }
    if (sel.kind === "local" && sel.name === st.branch) {
      this.notice = `${sel.name} is the current branch.`;
      cx.notify();
      return;
    }
    this.notice = "";
    this.confirm = { kind: "merge", branch: sel.name, target: sel.name, current: st.branch };
    cx.notify();
  }

  askCreate(cx) {
    const name = this.nameValue.trim();
    if (!this.state.root) {
      this.notice = "No git repository to create a branch in.";
      cx.notify();
      return;
    }
    if (!name) {
      this.notice = "Type a branch name.";
      this.nameInput.focus();
      cx.notify();
      return;
    }
    const source = this.sourceValue.trim() || this.state.branch || this.state.oid || "HEAD";
    this.notice = "";
    this.confirm = { kind: "create", branch: name, source, checkout: this.checkout };
    cx.notify();
  }

  // Fetch only updates remote-tracking refs, so it runs without a confirm.
  fetch(cx) {
    const root = this.state.root;
    if (!root || this.busy) return;
    this.busy = true;
    this.fetching = true;
    this.notice = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await runGit(root, ["fetch", "--all", "--prune"]);
      this.busy = false;
      this.fetching = false;
      if (r.ok) notify({ title: "Fetched", body: baseName(root), level: "success", timeout: 2500 });
      else {
        this.notice = (r.err || r.out || "git fetch failed.").trim();
        notify({ title: "Fetch failed", body: firstLine(this.notice), level: "error" });
      }
      await this.load();
      // Spaces and the status bar re-read git now rather than on their timers.
      setShared("abdh.git.changed", Date.now());
      cx.notify();
    });
  }

  askPull(cx) {
    const st = this.state;
    if (!st.root) return;
    if (st.detached) {
      this.notice = "Detached HEAD: check out a branch before pulling.";
      cx.notify();
      return;
    }
    if (!st.upstream) {
      this.notice = `${st.branch ?? "This branch"} has no upstream to pull from.`;
      cx.notify();
      return;
    }
    this.notice = "";
    this.confirm = { kind: "pull", branch: st.branch, upstream: st.upstream };
    cx.notify();
  }

  askDelete(cx) {
    const st = this.state;
    const sel = this.selected;
    if (!st.root || !sel) return;
    if (sel.kind === "local" && sel.name === st.branch) {
      this.notice = `${sel.name} is checked out; switch to another branch before deleting it.`;
      cx.notify();
      return;
    }
    this.notice = "";
    this.confirm = { kind: "delete", branch: sel.name, remote: sel.kind === "remote", force: false };
    cx.notify();
  }

  describe(c) {
    if (c.kind === "delete") return `Delete ${c.remote ? "remote" : "local"} branch ${c.branch}?`;
    if (c.kind === "pull") return `Pull ${c.upstream} into ${c.branch}? (fast-forward only)`;
    if (c.kind === "checkout") return `Check out ${c.branch}${c.track ? " (new tracking branch)" : ""}?`;
    if (c.kind === "create") return `Create ${c.branch} from ${c.source}${c.checkout ? ", then check it out" : ""}?`;
    return `Merge ${c.branch} into ${c.current}?`;
  }

  execute(cx) {
    if (this.busy || !this.confirm) return;
    const c = this.confirm;
    this.busy = true;
    this.notice = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let result;
      try {
        result = await this.runOperation(c);
      } catch (error) {
        result = { ok: false, title: "Git failed", message: String(error?.message ?? error) };
      }
      this.busy = false;
      if (result.unmerged) {
        // `branch -d` refused: ask again, this time for `branch -D`.
        this.confirm = { ...c, force: true };
        cx.notify();
        return;
      }
      if (result.ok) {
        this.confirm = null;
        if (c.kind === "create") {
          this.nameValue = "";
          this.nameInput.set_value("");
          this.mode = "branches";
          this.wantedBranch = c.branch;
        }
        notify({ title: result.title ?? "Git", body: result.message, level: "success", timeout: 3000 });
      } else {
        this.notice = result.message;
        const quiet = result.title === "Merge conflicts" && shared("abdh.settings")?.git?.conflictNotices === false;
        if (!quiet) notify({ title: result.title ?? "Git error", body: firstLine(result.message), level: "error" });
      }
      await this.load();
      // Spaces and the status bar re-read git now rather than on their timers.
      setShared("abdh.git.changed", Date.now());
      cx.notify();
    });
  }

  async runOperation(c) {
    const st = this.state;
    if (!st.root) return { ok: false, title: "No repository", message: "No git repository to act on." };
    if (c.kind === "checkout") return this.opCheckout(c);
    if (c.kind === "create") return this.opCreate(c);
    if (c.kind === "merge") return this.opMerge(c);
    if (c.kind === "delete") return this.opDelete(c);
    if (c.kind === "pull") return this.opPull(c);
    return { ok: false, title: "Unknown action", message: "Nothing ran." };
  }

  // --ff-only: a pull never makes a merge commit or stops on conflicts here;
  // a diverged branch is refused and left as it was.
  async opPull(c) {
    const root = this.state.root;
    const fresh = await this.freshStatus(root);
    if (fresh && fresh.branch.head !== c.branch) {
      return { ok: false, title: "Pull stopped", message: `HEAD is now ${fresh.branch.head ?? "detached"}, not ${c.branch}. Nothing was changed.` };
    }
    const r = await runGit(root, ["pull", "--ff-only"]);
    if (!r.ok) {
      const diverged = fresh && fresh.branch.ahead > 0 && fresh.branch.behind > 0;
      const why = (r.err || r.out || "git pull --ff-only failed.").trim();
      return { ok: false, title: "Pull failed", message: diverged ? `${c.branch} and ${c.upstream} have diverged; merge or rebase them first. ${why}` : why };
    }
    const fresh2 = await this.freshStatus(root);
    const pulled = fresh && fresh2 && fresh.branch.oid !== fresh2.branch.oid;
    return { ok: true, title: "Pulled", message: pulled ? `${c.upstream} into ${c.branch}.` : `${c.branch} is already up to date.` };
  }

  async opDelete(c) {
    const root = this.state.root;
    if (c.remote) {
      // origin/feature/x: the remote is the longest configured name before a slash.
      const remotes = await runGit(root, ["remote"]);
      const names = remotes.ok ? remotes.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const remote = names.filter((n) => c.branch.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
      if (!remote) return { ok: false, title: "Delete failed", message: `No configured remote matches ${c.branch}. Nothing was changed.` };
      const branch = c.branch.slice(remote.length + 1);
      const r = await runGit(root, ["push", remote, "--delete", `refs/heads/${branch}`]);
      if (!r.ok) return { ok: false, title: "Delete failed", message: (r.err || r.out || `git push ${remote} --delete ${branch} failed.`).trim() };
      return { ok: true, title: "Remote branch deleted", message: `${branch} deleted from ${remote}.` };
    }
    const fresh = await this.freshStatus(root);
    if (fresh && fresh.branch.head === c.branch) {
      return { ok: false, title: "Delete stopped", message: `${c.branch} is checked out now. Nothing was changed.` };
    }
    const r = await runGit(root, ["branch", c.force ? "-D" : "-d", "--", c.branch]);
    if (!r.ok) {
      // git's own wording is translated; ask the graph instead.
      const merged = await runGit(root, ["merge-base", "--is-ancestor", `refs/heads/${c.branch}`, "HEAD"]);
      if (!c.force && merged.code === 1) return { ok: false, unmerged: true };
      return { ok: false, title: "Delete failed", message: (r.err || r.out || `git branch -d ${c.branch} failed.`).trim() };
    }
    return { ok: true, title: "Branch deleted", message: `${c.branch}${c.force ? " (with its unmerged commits)" : ""}.` };
  }

  // Paths a checkout or merge would touch, so local edits in them can refuse
  // the operation before git starts writing.
  async changedBetween(root, from, to) {
    const r = await runGit(root, ["diff", "--name-only", "-z", from, to]);
    return r.ok ? r.out.split("\0").filter(Boolean) : [];
  }

  // A status read taken at the moment of the operation: the refresh timer may
  // be seconds behind, and a stale set would let git overwrite an edit.
  async freshStatus(root) {
    const r = await runGit(root, [...READ, "status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]);
    return r.ok ? parseStatus(r.out) : null;
  }

  async mergeTouched(root, target) {
    const r = await runGit(root, ["diff", "--name-only", "-z", `HEAD...${target}`]);
    if (r.ok) return r.out.split("\0").filter(Boolean);
    const fallback = await runGit(root, ["diff", "--name-only", "-z", "HEAD", target]);
    return fallback.ok ? fallback.out.split("\0").filter(Boolean) : [];
  }

  async opCheckout(c) {
    const root = this.state.root;
    const fresh = await this.freshStatus(root);
    const dirty = fresh ? new Set(fresh.entries.map((e) => e.path)) : this.dirty;
    const touched = await this.changedBetween(root, "HEAD", c.target);
    const overlap = touched.filter((p) => dirty.has(p));
    if (overlap.length) {
      return {
        ok: false,
        title: "Checkout stopped",
        message: `Local changes would be overwritten by ${c.branch}: ${few(overlap)}. Nothing was changed; commit or stash them first.`,
      };
    }
    // switch, not checkout: it refuses mid-merge/rebase instead of quietly
    // abandoning one.
    const r = await runGit(root, c.track ? ["switch", "--track", c.target] : ["switch", c.target]);
    if (!r.ok) {
      return {
        ok: false,
        title: "Checkout failed",
        message: (r.err || r.out || `git checkout ${c.branch} failed.`).trim(),
      };
    }
    return { ok: true, title: "Checked out", message: `${c.branch}.` };
  }

  async opMerge(c) {
    const st = this.state;
    const root = st.root;
    if (st.detached) {
      return { ok: false, title: "Merge stopped", message: "Detached HEAD: check out a branch first. Nothing was changed." };
    }
    if (st.counts && st.counts.conflicts > 0) {
      return {
        ok: false,
        title: "Merge stopped",
        message: "The worktree already has unresolved conflicts. Resolve and commit them first; nothing was changed.",
      };
    }
    const fresh = await this.freshStatus(root);
    // HEAD may have moved in a terminal while the confirm bar was up.
    if (fresh && fresh.branch.head !== c.current) {
      return { ok: false, title: "Merge stopped", message: `HEAD is now ${fresh.branch.head ?? "detached"}, not ${c.current}. Nothing was changed.` };
    }
    if (fresh && fresh.counts.conflicts > 0) {
      return {
        ok: false,
        title: "Merge stopped",
        message: "The worktree already has unresolved conflicts. Resolve and commit them first; nothing was changed.",
      };
    }
    const dirty = fresh ? new Set(fresh.entries.map((e) => e.path)) : this.dirty;
    const touched = await this.mergeTouched(root, c.target);
    const overlap = touched.filter((p) => dirty.has(p));
    if (overlap.length) {
      return {
        ok: false,
        title: "Merge stopped",
        message: `Local changes in ${few(overlap)} overlap what ${c.branch} changes. Nothing was changed; commit or stash them first.`,
      };
    }
    const r = await runGit(root, ["merge", "--no-edit", c.target]);
    if (!r.ok) {
      const detail = (r.err || r.out || "").trim();
      const unmerged = await runGit(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
      const conflicts = unmerged.ok ? unmerged.out.split("\0").filter(Boolean) : [];
      if (conflicts.length) {
        return {
          ok: false,
          title: "Merge conflicts",
          message:
            `Conflicts in ${plural(conflicts.length, "file")}: ${few(conflicts, 6)}. ` +
            `The merge is left in the worktree to resolve; nothing was discarded.` +
            (detail ? `\n${detail}` : ""),
        };
      }
      return { ok: false, title: "Merge failed", message: detail || `git merge ${c.branch} failed.` };
    }
    return { ok: true, title: "Merged", message: `${c.branch} into ${c.current}.` };
  }

  async opCreate(c) {
    const root = this.state.root;
    const valid = await runGit(root, ["check-ref-format", "--branch", c.branch]);
    if (!valid.ok) {
      return {
        ok: false,
        title: "Invalid branch name",
        message: (valid.err || "").trim() || `"${c.branch}" is not a valid branch name.`,
      };
    }
    const exists = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${c.branch}`]);
    if (exists.ok) {
      return { ok: false, title: "Branch exists", message: `Branch ${c.branch} already exists.` };
    }
    // --end-of-options: a source typed as "--force" is a ref name, not a flag.
    const args = c.checkout
      ? ["switch", "-c", c.branch, "--end-of-options", c.source]
      : ["branch", c.branch, "--end-of-options", c.source];
    const r = await runGit(root, args);
    if (!r.ok) {
      return {
        ok: false,
        title: "Create failed",
        message: (r.err || r.out || `git ${args.join(" ")} failed.`).trim(),
      };
    }
    return {
      ok: true,
      title: c.checkout ? "Branch created" : "Branch added",
      message: `${c.branch} from ${c.source}${c.checkout ? ", checked out." : "."}`,
    };
  }

  // --- rendering ------------------------------------------------------------

  groups() {
    const all = this.state.branches ?? [];
    return { local: all.filter((b) => b.kind === "local"), remote: all.filter((b) => b.kind === "remote") };
  }

  // danger: a red outline (or a red fill when primary) for deletes.
  button(t, id, label, primary, click, danger = false) {
    const disabled = this.busy;
    const fill = danger ? t.blocked : t.solid;
    return h_flex()
      .id(id)
      .h(25)
      .px(9)
      .gap(4)
      .items_center()
      .flex_none()
      .rounded(5)
      .border_1()
      .border_color(primary ? fill : danger ? t.blocked : t.input)
      .bg(primary ? fill : t.raised)
      .text_size(11.5)
      .text_color(primary ? (danger ? "#ffffff" : t.solid_foreground) : danger ? t.blocked : disabled ? t.dim : t.foreground)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => click(cx)))
      .child(label);
  }

  branchRow(t, b) {
    const st = this.state;
    const isCurrent = b.kind === "local" && b.name === st.branch;
    const isSelected = same(this.selected, b);
    const disabled = this.mode === "merge" && isCurrent;
    const track = [];
    if (b.track.ahead) track.push(`\u2191${b.track.ahead}`);
    if (b.track.behind) track.push(`\u2193${b.track.behind}`);
    if (b.track.gone) track.push("gone");
    return h_flex()
      .id(`abdh-git-br-${b.kind}-${b.name}`)
      .h(28)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(4)
      .text_size(11.5)
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!disabled && !isSelected, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .when(!disabled, (el) =>
        el.on_click((_e, cx) => {
          this.selected = b;
          this.confirm = null;
          this.notice = "";
          if (this.mode === "create") {
            this.sourceValue = b.name;
            this.sourceInput.set_value(b.name);
          }
          cx.notify();
        }),
      )
      .tooltip(b.subject || b.name)
      .child(div().w(10).flex_none().text_size(9).text_color(isCurrent ? t.done : t.dim).child(isCurrent ? "\u25cf" : "\u25cb"))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(disabled ? t.dim : isCurrent ? t.foreground : t.muted)
          .child(b.name),
      )
      .when(b.kind === "remote", (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child("remote")))
      .when(track.length > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(track.join(" "))))
      .when(Boolean(b.at), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(ago(b.at))));
  }

  sectionHeader(t, label, count) {
    const open = !this.folded.has(label);
    return h_flex()
      .id(`abdh-git-section-${label}`)
      .h(22)
      .flex_none()
      .px(6)
      .gap(4)
      .items_center()
      .rounded(4)
      .cursor_pointer()
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.muted))
      .on_click((_e, cx) => {
        if (open) this.folded.add(label);
        else this.folded.delete(label);
        setShared("abdh.git.folded", [...this.folded]);
        cx.notify();
      })
      .child(svg(`mods/abdh-explorer/icons/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .child(div().text_size(9.5).font_semibold().child(`${label.toUpperCase()} \u00b7 ${count}`));
  }

  notRepo(t, st) {
    return v_flex()
      .p(14)
      .gap(5)
      .child(div().text_size(11.5).text_color(t.muted).child(st.root === null && !st.loading ? "No git repository here." : "Reading repository\u2026"))
      .when(Boolean(st.folder), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(st.folder ?? "")))
      .when(Boolean(st.error), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(st.error ?? "")));
  }

  listBody(t, cx) {
    const st = this.state;
    const rows = [];
    if (st.root) {
      const { local, remote } = this.groups();
      if (local.length) {
        rows.push(this.sectionHeader(t, "local", local.length));
        if (!this.folded.has("local")) for (const b of local) rows.push(this.branchRow(t, b));
      }
      if (remote.length) {
        rows.push(this.sectionHeader(t, "remote", remote.length));
        if (!this.folded.has("remote")) for (const b of remote) rows.push(this.branchRow(t, b));
      }
      if (!local.length && !remote.length) {
        rows.push(div().p(10).text_size(11).text_color(t.dim).child("No branches yet."));
      }
      if (st.refsError) {
        rows.push(div().p(10).text_size(10.5).text_color(t.blocked).child(`Branch list unavailable: ${st.refsError}`));
      }
      if (st.error) {
        rows.push(div().p(10).text_size(10.5).text_color(t.blocked).child(`Status unavailable: ${st.error}`));
      }
    }
    return div()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .id("abdh-git-list")
          .size_full()
          .overflow_y_scroll()
          .gap(1)
          .when(st.loading, (el) => el.child(div().p(10).text_size(11).text_color(t.dim).child("Reading repository\u2026")))
          .when(!st.loading && !st.root, (el) => el.child(this.notRepo(t, st)))
          .when(Boolean(st.root), (el) => el.children(rows)),
      )
      .child(Scrollbar.vertical("abdh-git-list").absolute().inset_0());
  }

  createForm(t) {
    const field = (key, state) =>
      Input.new(state)
        .h(28)
        .w_full()
        .px(9)
        .items_center()
        .rounded(5)
        .border_1()
        .border_color(this.focused.has(key) ? t.accent : t.input)
        .bg(t.background)
        .text_color(t.foreground);
    const label = (text) => div().text_size(9.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const box = div()
      .w(12)
      .h(12)
      .flex_none()
      .rounded(3)
      .border_1()
      .border_color(this.checkout ? t.accent : t.input)
      .bg(this.checkout ? t.accent : t.background)
      .items_center()
      .justify_center()
      .child(this.checkout ? div().text_size(8).text_color(t.accent_foreground).child("\u2713") : "");
    return v_flex()
      .flex_none()
      .p(12)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(label("new branch name"))
      .child(field("nameValue", this.nameInput))
      .child(div().text_size(9.5).font_semibold().text_color(t.dim).child("FROM"))
      .child(field("sourceValue", this.sourceInput))
      .child(
        h_flex()
          .id("abdh-git-checkout-toggle")
          .h(24)
          .gap(7)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.checkout = !this.checkout;
            cx.notify();
          })
          .child(box)
          .child(div().text_size(11).text_color(t.muted).child("Check out after creating")),
      );
  }

  blameCard(t) {
    const b = this.blameInfo;
    const p = props() ?? {};
    if (!b) return div();
    const where = `${p.file}${p.line ? `:${p.line}` : ""}`;
    return v_flex()
      .flex_none()
      .mx(12)
      .mt(10)
      .p(8)
      .gap(3)
      .rounded(5)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(where))
          .child(
            div()
              .flex_none()
              .text_size(10)
              .text_color(b.error ? t.blocked : b.committed ? t.dim : t.accent)
              .child(b.loading ? "\u2026" : b.error ? "unavailable" : b.committed ? b.short : "not committed"),
          ),
      )
      .when(b.committed, (el) =>
        el
          .child(div().text_size(11.5).text_color(t.foreground).truncate().child(b.summary || "\u2014"))
          .child(div().text_size(10).text_color(t.dim).child(`${b.author || "unknown author"} \u00b7 ${ago(b.time)}`)),
      )
      .when(!b.committed && !b.error && !b.loading, (el) =>
        el.child(div().text_size(10.5).text_color(t.muted).child("This line has uncommitted changes.")),
      )
      .when(Boolean(b.error), (el) => el.child(div().text_size(10.5).text_color(t.muted).child(b.error)));
  }

  statusLine(t) {
    const st = this.state;
    if (st.loading) return { text: "\u2026", color: t.dim };
    if (!st.root) return { text: "no repository", color: t.dim };
    const bits = [];
    let color = t.muted;
    if (st.counts) {
      if (st.counts.conflicts) {
        bits.push(`${st.counts.conflicts} conflict${st.counts.conflicts === 1 ? "" : "s"}`);
        color = t.blocked;
      }
      // What is waiting, in words: to commit, to push, to pull.
      const pending = Math.max(0, (this.dirty?.size ?? 0) - (st.counts.conflicts ?? 0));
      if (pending) {
        bits.push(`${pending} to commit`);
        if (color !== t.blocked) color = t.ansi3;
      }
      if (!bits.length) {
        bits.push("clean");
        color = t.done;
      }
    } else {
      bits.push("changes unavailable");
    }
    if (st.detached) bits.push("detached");
    else if (st.upstream) {
      // No branch.ab line: the upstream ref is gone, so there is nothing to compare.
      if (st.ahead === null && st.behind === null) bits.push("upstream gone");
      else if (st.ahead === 0 && st.behind === 0) bits.push("in sync");
      else {
        if (st.ahead > 0) bits.push(`\u2191${st.ahead} to push`);
        if (st.behind > 0) bits.push(`\u2193${st.behind} to pull`);
        if (color === t.done) color = t.ansi3;
      }
    } else if (st.root) bits.push("no upstream");
    return { text: bits.join(" \u00b7 "), color };
  }

  render(cx) {
    const t = theme();
    if (props()?.file && !props()?.line) return this.blameView(t);
    const st = this.state;
    const secs = refreshSeconds();
    const status = this.statusLine(t);

    const chip = (m) =>
      h_flex()
        .id(`abdh-git-tab-${m.id}`)
        .h(24)
        .px(9)
        .items_center()
        .rounded(5)
        .text_size(11)
        .when(this.mode === m.id, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(this.mode !== m.id, (el) => el.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.setMode(m.id, cx))
        .child(m.label);

    const branchLabel = st.detached ? `detached ${(st.oid ?? "").slice(0, 7)}` : st.branch ?? "\u2026";
    const branchChip = h_flex()
      .h(21)
      .px(7)
      .gap(5)
      .items_center()
      .flex_none()
      .rounded(4)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(div().text_size(10.5).text_color(t.foreground).child(branchLabel));

    const headerButton = (id, label, tip, click) =>
      div()
        .id(id)
        .h(21)
        .px(7)
        .flex_none()
        .flex()
        .items_center()
        .rounded(4)
        .text_size(10.5)
        .text_color(this.busy ? t.dim : t.muted)
        .tooltip(tip)
        .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => click(cx)))
        .child(label);

    const header = h_flex()
      .h(40)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child("Git"))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(10.5)
          .text_color(t.dim)
          .child(st.root ? baseName(st.root) : st.folder ? baseName(st.folder) : ""),
      )
      .when(Boolean(st.root), (el) => el.child(branchChip))
      .when(Boolean(st.root), (el) => el
        .child(headerButton("abdh-git-fetch", this.fetching ? "Fetching…" : "Fetch", "git fetch --all --prune", (c) => this.fetch(c)))
        .child(headerButton("abdh-git-pull", st.behind > 0 ? `Pull ↓${st.behind}` : "Pull",
          st.upstream ? `git pull --ff-only from ${st.upstream}` : "No upstream to pull from", (c) => this.askPull(c))))
      .child(
        div()
          .id("abdh-git-refresh")
          .h(21)
          .w(21)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .text_size(12)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx))
          .child("\u21bb"),
      )
      .child(
        div()
          .id("abdh-git-close")
          .h(21)
          .w(21)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .text_size(11)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.dismiss())
          .child("\u2715"),
      );

    const tabs = h_flex()
      .h(32)
      .flex_none()
      .px(12)
      .gap(4)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .children(MODES.map(chip))
      .child(div().flex_1())
      .child(div().flex_none().text_size(10).text_color(status.color).child(status.text));

    const notice = div()
      .id("abdh-git-notice")
      .flex_none()
      .px(12)
      .py(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(10.5)
      .text_color(t.blocked)
      .child(this.notice);

    const body = v_flex()
      .flex_1()
      .min_h(0)
      .when(Boolean(this.blameInfo), (el) => el.child(this.blameCard(t)))
      .when(Boolean(this.notice), (el) => el.child(notice))
      .when(this.mode === "create", (el) => el.child(this.createForm(t)).child(this.listBody(t, cx)))
      .when(this.mode === "history", (el) => el.child(this.historyBody(t)))
      .when(this.mode !== "create" && this.mode !== "history", (el) => el.child(this.listBody(t, cx)));

    // Bottom: the confirm step takes over from the normal action bar.
    const confirmBar = () =>
      h_flex()
        .flex_none()
        .px(12)
        .py(8)
        .gap(8)
        .items_center()
        .border_t(1)
        .border_color(t.border)
        .bg(t.surface)
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(this.describe(this.confirm)))
        .child(
          this.button(t, "abdh-git-cancel", "Cancel", false, (c) => {
            this.confirm = null;
            this.notice = "";
            c.notify();
          }),
        )
        .child(this.button(t, "abdh-git-confirm", this.busy ? "Working\u2026" : "Confirm", true, (c) => this.execute(c)));

    const actionHint = (() => {
      if (this.mode === "history") return `${this.history.rows.length} commits \u00b7 read-only`;
      if (this.mode === "create") return `From ${this.sourceValue || st.branch || "HEAD"}`;
      if (this.mode === "merge") {
        if (!this.selected) return "Select a branch to merge";
        return `Merge ${this.selected.name} into ${st.branch ?? "HEAD"}`;
      }
      if (!this.selected) return st.root ? "Select a branch" : "";
      return this.selected.name;
    })();

    const actionBar = h_flex()
      .h(40)
      .flex_none()
      .px(12)
      .gap(6)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(actionHint))
      .when(this.mode === "create", (el) => el.child(this.button(t, "abdh-git-create", "Create branch", true, (c) => this.askCreate(c))))
      .when(
        this.mode === "merge" && Boolean(this.selected) && !(this.selected.kind === "local" && this.selected.name === st.branch),
        (el) => el.child(this.button(t, "abdh-git-merge", "Merge", true, (c) => this.askMerge(c))),
      )
      .when(
        this.mode === "branches" && Boolean(this.selected) && !(this.selected.kind === "local" && this.selected.name === st.branch),
        (el) =>
          el
            .child(this.button(t, "abdh-git-delete", "Delete", false, (c) => this.askDelete(c), true))
            .child(this.button(t, "abdh-git-checkout", "Checkout", true, (c) => this.askCheckout(c)))
            .child(this.button(t, "abdh-git-merge-sel", "Merge", false, (c) => this.askMerge(c))),
      );

    // Deleting asks in a dialog over the list, not in the bottom bar.
    const del = this.confirm?.kind === "delete" ? this.confirm : null;
    const deleteDialog = () =>
      div()
        .id("abdh-git-delete-scrim")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg("#000000a0")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(
          v_flex()
            .id("abdh-git-delete-dialog")
            .w(400)
            .p(16)
            .gap(10)
            .rounded(10)
            .border_1()
            .border_color(t.border)
            .bg(t.popover)
            .child(div().text_size(14).font_semibold().text_color(t.foreground)
              .child(del.force ? "Delete unmerged branch?" : `Delete ${del.remote ? "remote" : "local"} branch?`))
            .child(div().px(8).py(6).rounded(6).bg(t.raised).text_size(12).text_color(t.foreground).truncate().child(del.branch))
            .child(div().text_size(11.5).text_color(del.force || del.remote ? t.blocked : t.muted).child(
              del.remote
                ? "This runs git push --delete: the branch is removed from the server for everyone. Local branches are kept."
                : del.force
                  ? "It has commits that are not merged into HEAD or its upstream. Deleting it drops them (git reflog can still find them for a while)."
                  : "Removes the branch here. Its commits are merged, so nothing is lost; the remote branch, if any, is kept.",
            ))
            .child(h_flex().pt(4).gap(8).justify_end()
              .child(this.button(t, "abdh-git-delete-cancel", "Cancel", false, (c) => {
                this.confirm = null;
                this.notice = "";
                c.notify();
              }))
              .child(this.button(t, "abdh-git-delete-confirm", this.busy ? "Deleting…" : del.force ? "Delete anyway" : "Delete", true, (c) => this.execute(c), true))),
        );

    const footer = h_flex()
      .h(22)
      .flex_none()
      .px(12)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(
        div()
          .text_size(9.5)
          .text_color(t.dim)
          .child(this.mode === "history" ? `esc close \u00b7 refresh ${secs}s` : `\u2191\u2193 select \u00b7 \u21b5 act \u00b7 esc close \u00b7 refresh ${secs}s`),
      );

    return v_flex()
      .id("abdh-git")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .size_full()
      .min_h(0)
      .relative()
      .bg(t.popover)
      .text_size(12)
      .child(header)
      .child(tabs)
      .child(body)
      .when(Boolean(this.confirm) && !del, (el) => el.child(confirmBar()))
      .when(!this.confirm || Boolean(del), (el) => el.child(actionBar))
      .child(footer)
      .when(Boolean(del), (el) => el.child(deleteDialog()));
  }

  onKey(e, cx) {
    // Esc backs out of a pending confirm first, then closes the overlay.
    if (e.key === "escape" && this.confirm && !this.busy) {
      this.confirm = null;
      this.notice = "";
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "escape") {
      this.dismiss();
      cx.stop_propagation();
      return;
    }
    if (this.mode === "history") return;
    if (this.focused.size > 0) return;
    if (e.key === "down" || e.key === "up") {
      this.moveSelection(e.key === "down" ? 1 : -1);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "enter") {
      if (this.confirm) this.execute(cx);
      else if (this.mode === "create") this.askCreate(cx);
      else if (this.selected) {
        if (this.mode === "merge") this.askMerge(cx);
        else this.askCheckout(cx);
      }
      cx.stop_propagation();
    }
  }
}

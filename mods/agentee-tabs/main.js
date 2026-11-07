// Agentee editor strip: Chrome-like tabs for the window's work tabs.
// Drag a tab onto another to move it; the + sits right after the last tab.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, home, run, openOverlay, theme, window, layout, settings, shared, setShared } from "herdr";

// A working agent's tab: a spinner in the theme's `working` colour.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A tab lives in a space, and tab.new from a mod with none open fails ("no
// space yet: make one first"). Actions that make a tab right away get the
// space they need first. The + is not one of them: it only opens the picker,
// and the choice there makes the space (agentee-new-menu), so the click never
// leaves a stray terminal behind.
function ensureSpace() {
  if (!spaces().some((s) => s.active)) run("space.new");
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.hovered = null;
    this.space = undefined;
    this.frame = 0;
    cx.timer.every(200, (cx) => {
      this.followSpace();
      // A working agent's spinner turns only while one is working.
      if ((spaces().find((s) => s.active)?.tabs ?? []).some((x) => x.status === "working")) { this.frame++; cx.notify(); }
    });
  }

  // The right panel (Files, Agents, System) belongs to the window's layout, so
  // it would look the same in every space. Each space keeps its own: shown or
  // not, and which tool; a space that never opened it starts closed.
  followSpace() {
    const sp = spaces();
    const id = sp.find((s) => s.active)?.id ?? null;
    const root = layout(), panel = find(root, "panel"), stack = find(root, "panel-body");
    if (!id || !panel) return;
    const now = { shown: !panel.hidden, active: stack?.active ?? "panel-files" };
    const saved = shared("agentee.panel.bySpace");
    const bySpace = saved && typeof saved === "object" ? { ...saved } : {};
    if (id !== this.space) {
      const first = this.space === undefined;
      this.space = id;
      // On start the window already shows this space as it was left.
      if (first) { if (!bySpace[id]) this.keep(bySpace, id, now, sp); return; }
      const want = bySpace[id] ?? { shown: false, active: now.active };
      if (want.shown) {
        if (!now.shown) run("layout.show", { id: "panel" });
        if (want.active && want.active !== now.active) run("layout.select", { stack: "panel-body", child: want.active });
      } else if (now.shown) run("layout.hide", { id: "panel" });
      return;
    }
    const was = bySpace[id];
    if (!was || was.shown !== now.shown || was.active !== now.active) this.keep(bySpace, id, now, sp);
  }

  keep(bySpace, id, state, sp) {
    bySpace[id] = state;
    // Closed spaces go with the next change.
    for (const key of Object.keys(bySpace)) if (!sp.some((s) => s.id === key)) delete bySpace[key];
    setShared("agentee.panel.bySpace", bySpace);
  }

  nameOf(tab) {
    const p = panes().find(x => x.tab === tab.id && x.program?.agent)?.program ?? panes().find(x => x.tab === tab.id)?.program;
    const name = String(tab?.name ?? "").trim();
    if (!name || /^tb\d+$/.test(name) || /^\d+$/.test(name)) return p?.name ?? "Terminal";
    return name;
  }

  render() {
    const t = theme();
    const ui = shared("agentee.settings")?.tabs ?? {};
    const minW = ui.minWidth ?? 60, maxW = Math.max(minW, ui.maxWidth ?? 200);
    const space = spaces().find(s => s.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_mouse_down("left", stop).on_click(action).when(Boolean(tip), el => el.tooltip(tip)).child(label);

    const item = (tab, i) => {
      const on = tab.active, hot = this.hovered === tab.id;
      const label = this.nameOf(tab) || "Tab";
      const program = panes().find(p => p.tab === tab.id && p.program?.agent)?.program ?? panes().find(p => p.tab === tab.id)?.program;
      // The editor's tab design: flat, as wide as its name (between the Theme
      // settings widths), an accent line on the active one, dividers between.
      return v_flex().id(`tab-${tab.id}`).h_full().flex_none().max_w(maxW).min_w(minW)
        .border_r(1).when(i === 0, el => el.border_l(1)).border_color(t.border)
        .when(on, el => el.bg(t.background)).when(!on, el => el.bg(t.chrome))
        .text_size(12).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .hover(s => s.bg(on ? t.background : t.surface).text_color(t.foreground))
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
        .on_hover((hovered, cx) => {
          if (hovered) this.hovered = tab.id;
          else if (this.hovered === tab.id) this.hovered = null;
          cx.notify();
        })
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          if (e.click_count === 2) run("tab.rename", { id: tab.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) {
            const target = space.tabs.findIndex(x => x.id === tab.id) + 1;
            run("tab.move", { id: shown[from].id, index: target });
          } else run("tab.select", { id: tab.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
        .child(div().h(2).flex_none().bg(on ? t.accent : "#00000000"))
        .child(h_flex().flex_1().min_h(0).pl(12).pr(5).gap(7).items_center()
          .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(13).flex_none().text_color(on ? t.foreground : t.muted) : image(program.icon).size(13).flex_none()))
          .child(div().min_w(0).flex_shrink(1).truncate().child(ui.fullFilenames === false ? label.split(".")[0] : label))
          .when(tab.status === "working", el => el.child(div().flex_none().text_size(12).text_color(t.working).child(SPIN[this.frame % SPIN.length])))
          .when(tab.status === "blocked", el => el.child(div().size(6).flex_none().rounded_full().bg(t.blocked)))
          .when(tab.status === "done", el => el.child(div().size(6).flex_none().rounded_full().bg(t.done)))
          // The close button keeps its place, so tabs don't jump on hover.
          .child(div().id(`close-${tab.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(3)
            .when(on || hot || ui.closeOnHover === false, el => el.text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground))
              .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
              .child(svg("mods/agentee-tabs/icons/close.svg").size(10)))));
    };

    const plus = div().id("tab-new").size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .bg("#00000000").text_color(t.dim).text_size(18).cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.accent))
      .tooltip("New tab: pick a terminal or an agent")
      .on_mouse_down("left", stop).on_click(() => openOverlay({ mod: "agentee-new-menu", kind: "popup", width: 250, height: 512 }))
      .child("+");

    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const panel = find(root, "panel"), stack = find(root, "panel-body");
    const shownPanel = panel && !panel.hidden ? stack?.active ?? null : null;
    const panelButton = (id, icon, tip) => div().id(`top-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .bg(shownPanel === id ? t.raised : "#00000000")
      .text_color(shownPanel === id ? t.accent : t.dim).cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(() => {
        if (shownPanel === id) { run("layout.hide", { id: "panel" }); return; }
        run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: id });
      })
      .child(svg(`mods/agentee-tabs/icons/${icon}.svg`).size(15));
    const f = focused();
    // The status bar resolves the open editor file's project root; use the same
    // root for the overlay, so Git opens the repository Files shows.
    const g = shared("agentee.git.status");
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const projectRoot = (pane?.mod === "agentee-editor" ? g?.cwd : null) ?? f?.cwd ?? spaces().find((s) => s.active)?.folder ?? home();
    // What the status bar's git read says is waiting here: a dot on the Git
    // button (conflicts or something to pull: red, changes: amber, to push: green).
    const waiting = g ? [
      g.conflicted > 0 ? `${g.conflicted} conflict${g.conflicted === 1 ? "" : "s"}` : null,
      g.changes > 0 ? `${g.changes} change${g.changes === 1 ? "" : "s"} to commit` : null,
      g.ahead > 0 ? `${g.ahead} commit${g.ahead === 1 ? "" : "s"} to push` : null,
      g.behind > 0 ? `${g.behind} commit${g.behind === 1 ? "" : "s"} to pull` : null,
    ].filter(Boolean) : [];
    const gitDot = !g ? null : g.conflicted > 0 || g.behind > 0 ? t.blocked : g.changes > 0 ? t.ansi3 : g.ahead > 0 ? t.done : null;
    const gitTip = g ? `Git · ${g.branch ?? "detached"}${waiting.length ? `\n${waiting.join(" · ")}` : " · nothing to commit, push or pull"}` : "Git branches";
    // Theme settings → Git → Open as a tab: focus or make a Git tab in this
    // space; otherwise open the dialog over the work area.
    const openGit = () => {
      if (shared("agentee.settings")?.git?.openInTab === true) {
        const active = spaces().find((s) => s.active);
        const tabs = new Set((active?.tabs ?? []).map((t) => t.id));
        const pane = panes().find((p) => p.mod === "agentee-git" && tabs.has(p.tab));
        if (pane) {
          run("tab.select", { id: pane.tab });
          run("pane.focus", { pane: pane.pane });
          return;
        }
        ensureSpace();
        run("tab.new", { name: "Git", mod: "agentee-git" });
        return;
      }
      openOverlay({ mod: "agentee-git", kind: "dialog", width: 520, height: 520, props: { root: projectRoot } });
    };
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / (settings().zoom ?? 1) - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;

    return h_flex().size_full().min_w(0).pl(lightsPadding).pr(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar()
        .children([...shown.map(item), plus]))
      .child(h_flex().h(31).flex_none().items_center().gap(1)
        .child(panelButton("panel-files", "folder", "Files"))
        .child(panelButton("panel-agents", "bot", "Agents"))
        .child(panelButton("panel-system", "cpu", "System"))
        .child(div().id("top-git").size(26).flex_none().flex().items_center().justify_center().rounded(6).relative()
          .text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(gitTip)
          .on_mouse_down("left", stop).on_click(() => openGit())
          .child(svg("mods/agentee-tabs/icons/branch.svg").size(15))
          .when(Boolean(gitDot), (el) => el.child(div().absolute().top(3).right(3).size(7).rounded_full().bg(gitDot).border_1().border_color(t.chrome)))))
      .when(w?.buttons, el => el.child(h_flex().h(31).items_center().gap(2)
        .child(button("minimize", w.platform === "windows" ? svg("mods/agentee-tabs/icons/win-min.svg").size(15) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/agentee-tabs/icons/${w.maximized ? "win-restore" : "win-max"}.svg`).size(15) : "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/agentee-tabs/icons/win-close.svg").size(15), () => run("window.close")))));
  }
}

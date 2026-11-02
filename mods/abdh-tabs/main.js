// abdh editor strip: Chrome-like tabs for the window's work tabs.
// Drag a tab onto another to move it; the + sits right after the last tab.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, home, run, openOverlay, theme, window, layout, settings, shared } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.hovered = null;
  }

  nameOf(tab) {
    const p = panes().find(x => x.tab === tab.id && x.program?.agent)?.program ?? panes().find(x => x.tab === tab.id)?.program;
    const name = String(tab?.name ?? "").trim();
    if (!name || /^tb\d+$/.test(name) || /^\d+$/.test(name)) return p?.name ?? "Terminal";
    return name;
  }

  render() {
    const t = theme();
    const ui = shared("abdh.settings")?.tabs ?? {};
    const minW = Math.max(140, ui.minWidth ?? 140), maxW = Math.max(240, ui.maxWidth ?? 280);
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
      return h_flex().id(`tab-${tab.id}`).h(30).px(11).gap(7).flex_none().max_w(maxW).min_w(minW).items_center().rounded_t(7)
        .border_t(2)
        .border_color(on ? t.accent : "#00000000")
        .when(on, el => el.bg(t.background)).when(!on, el => el.bg(t.chrome))
        .text_size(12).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .hover(s => s.bg(on ? t.background : t.surface))
        .on_hover(hovered => { this.hovered = hovered ? tab.id : null; })
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
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(13).flex_none().text_color(t.muted) : image(program.icon).size(13).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(ui.fullFilenames === false ? label.split(".")[0] : label))
        .when(tab.status === "blocked", el => el.child(div().size(6).flex_none().rounded_full().bg(t.blocked)))
        .when(tab.status === "done", el => el.child(div().size(6).flex_none().rounded_full().bg(t.done)))
        .when(on || hot || ui.closeOnHover === false, el => el.child(div().id(`close-${tab.id}`).size(15).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
          .child(svg("mods/abdh-tabs/icons/close.svg").size(10))));
    };

    const plus = div().id("tab-new").size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .bg("#00000000").text_color(t.dim).text_size(18).cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.accent))
      .tooltip("New tab: pick a terminal or an agent")
      .on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))
      .child("+");

    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const panel = find(root, "panel"), stack = find(root, "panel-body");
    const shownPanel = panel && !panel.hidden ? stack?.active ?? null : null;
    const panelButton = (id, icon, tip) => div().id(`top-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .bg(shownPanel === id ? t.raised : "#00000000")
      .text_color(shownPanel === id ? t.accent : t.dim).cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click(() => {
        if (shownPanel === id) { run("layout.hide", { id: "panel" }); return; }
        run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: id });
      })
      .child(svg(`mods/abdh-tabs/icons/${icon}.svg`).size(15));
    const projectRoot = focused()?.cwd ?? spaces().find((s) => s.active)?.folder ?? home();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / (settings().zoom ?? 1) - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;

    return h_flex().size_full().min_w(0).pl(lightsPadding).pr(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h(31).gap(3).items_end().overflow_x_scrollbar()
        .children([...shown.map(item), plus]))
      .child(h_flex().h(31).flex_none().items_center().gap(1)
        .child(panelButton("panel-files", "folder", "Files"))
        .child(panelButton("panel-agents", "bot", "Agents"))
        .child(panelButton("panel-system", "cpu", "System"))
        .child(div().id("top-git").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip("Git branches")
          .on_click(() => openOverlay({ mod: "abdh-git", kind: "dialog", width: 520, height: 520, props: { root: projectRoot } }))
          .child(svg("mods/abdh-tabs/icons/branch.svg").size(15))))
      .when(w?.buttons, el => el.child(h_flex().h(31).items_center().gap(2)
        .child(button("minimize", w.platform === "windows" ? svg("mods/abdh-tabs/icons/win-min.svg").size(15) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/abdh-tabs/icons/${w.maximized ? "win-restore" : "win-max"}.svg`).size(15) : "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/abdh-tabs/icons/win-close.svg").size(15), () => run("window.close")))));
  }
}

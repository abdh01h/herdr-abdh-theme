// abdh chrome: the sidebar's top brand bar and its foot.
//   brand  : wordmark, search, sidebar toggle
//   footer : abdh settings, the keybind list beside it, and Herdr's own settings
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, set_theme } from "gpui-base";
import { theme, run, props, window, shared, setShared, layout, keys, openOverlay, appHome, readTextFile } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 180;

function keyFor(action) {
  const k = keys().find((b) => b.action === action && b.section === "global")?.keys;
  if (!k) return null;
  const mac = window()?.platform === "macos";
  const parts = k.split("-");
  const last = parts.pop();
  const MAC = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
  const PC = { cmd: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };
  const mods = parts.map((p) => (mac ? MAC[p] : PC[p]) ?? p);
  const key = last.length === 1 ? last.toUpperCase() : last[0].toUpperCase() + last.slice(1);
  return mac ? mods.join("") + key : [...mods, key].join("+");
}

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  run("layout.resize", { id: "sidebar", px: narrow() ? shared("sidebar.width") ?? 256 : window()?.platform === "macos" ? 76 : 44 });
}

export default class Chrome extends View {
  init(_props, cx) {
    // The shell leaves an editor's selection colour unset, so Base paints it
    // with the theme's `hover` at 40% — invisible on a dark hover. Republish the
    // palette with `selection` set to the theme's own selection colour.
    const syncBase = (cx) => {
      try {
        const base = cx.theme();
        const app = theme();
        if (!base?.colors) return;
        // The editor paints an unset selection with Base's *accent* at 40%.
        // The app maps accent from the theme's hover (near the background), so
        // the highlight disappeared. Point accent at the theme accent and set
        // selection to the theme's own selection colour.
        const wantSel = app.selection || app.accent;
        const colors = { ...base.colors, accent: app.accent, selection: wantSel };
        if (colors.accent === base.colors.accent && colors.selection === base.colors.selection) return;
        set_theme({ appearance: base.appearance, tokens: { colors, spacing: base.spacing, radius: base.radius } });
      } catch { /* older host without set_theme */ }
    };
    cx.timer.every(1000, (timerCx) => syncBase(timerCx));
    cx.spawn(async (cx) => { syncBase(cx); });
    // The theme's own settings file, so panels follow it before Settings is opened.
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/abdh-settings.json`);
        if (!text) return;
        const stored = JSON.parse(text);
        const base = shared("abdh.settings") ?? {};
        setShared("abdh.settings", { ...stored, ...base });
      } catch { /* an unreadable file means defaults */ }
    });
  }

  button(t, id, icon, action, tip) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action).when(Boolean(tip), (el) => el.tooltip(tip))
      .child(svg(`mods/abdh-chrome/icons/${icon}.svg`).size(15));
  }

  row(t, id, icon, label, dim, action) {
    return h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(7).flex_1().min_w(0)
      .text_color(dim ? t.dim : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer().on_click(action)
      .child(svg(`mods/abdh-chrome/icons/${icon}.svg`).size(14).flex_none())
      .when(!narrow(), (el) => el.child(div().truncate().child(label)));
  }

  render() {
    const t = theme();
    if (props()?.role === "footer") {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(6).gap(1).text_size(12.5)
        .child(h_flex().items_center().gap(2)
          .child(this.row(t, "settings", "settings", "abdh settings", false, () =>
            openOverlay({ mod: "abdh-settings", kind: "dialog", width: 780, height: 620 })))
          .child(this.button(t, "shortcuts", "keyboard", () => run("app.help"),
            `Keyboard shortcuts${keyFor("app.help") ? "  " + keyFor("app.help") : ""}`)))
        .child(this.row(t, "herdr-settings", "settings", "Herdr settings", true, () => run("app.settings")));
    }
    const lights = window()?.platform === "macos" && window()?.titlebar === "none" && !window()?.fullscreen;
    return h_flex().size_full().bg(t.chrome).pl(lights && !narrow() ? 76 : 12).pr(8).gap(2).items_center()
      .child(h_flex().id("abdh-brand").flex_1().min_w(0).gap(7).items_center()
        .child(div().size(7).rounded(2).bg(t.accent))
        .when(!narrow(), (el) => el.child(div().font_semibold().text_size(13).text_color(t.foreground).child("abdh"))))
      .when(!narrow(), (el) => el.child(this.button(t, "search", "search", () => run("mod.open", { name: "picker" }), "Find a command or file")))
      .when(!narrow(), (el) => el.child(this.button(t, "panel", "folder", () => {
        run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: "panel-files" });
      }, "Show Files, Agents and System")))
      .child(this.button(t, "sidebar-toggle", "sidebar", toggleSidebar, narrow() ? "Show sidebar" : "Hide sidebar"));
  }
}

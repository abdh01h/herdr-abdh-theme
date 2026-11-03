// Agentee chrome: the sidebar's top brand bar and its foot.
//   brand  : wordmark, search, sidebar toggle
//   footer : Theme settings, Herdr settings, Add machine and the keybind list
import { View, div, svg } from "gpui-kit";
import { h_flex, set_theme } from "gpui-base";
import { theme, run, props, window, shared, setShared, layout, keys, openOverlay, appHome, readTextFile } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const panelShown = () => {
  const panel = find(layout(), "panel");
  return Boolean(panel) && !panel.hidden;
};

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
    // cx.theme().colors reads back as #rrggbb with the alpha dropped, so the
    // colours set here come from theme(), and a change is spotted by comparing
    // against what Base read back after our own set_theme.
    let synced = null;
    const syncBase = (cx) => {
      try {
        const base = cx.theme();
        const app = theme();
        if (!base?.colors) return;
        const key = JSON.stringify([base.appearance, base.colors, app.accent, app.selection]);
        if (key === synced) return;
        // The editor paints an unset selection with Base's *accent* at 40%.
        // The app maps accent from the theme's hover (near the background), so
        // the highlight disappeared. Point accent at the theme accent and set
        // selection to the theme's own selection colour. The editor's indent
        // guides are Base `border`; a clear border removes them.
        const colors = { ...base.colors, accent: app.accent, selection: app.selection || app.accent, border: "#00000000" };
        set_theme({ appearance: base.appearance, tokens: { colors, spacing: base.spacing, radius: base.radius } });
        const after = cx.theme();
        synced = JSON.stringify([after.appearance, after.colors, app.accent, app.selection]);
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
        // The file wins: a hand edit takes effect at the next start.
        setShared("abdh.settings", { ...base, ...stored });
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

  render() {
    const t = theme();
    if (props()?.role === "footer") {
      // One row of tools; a collapsed rail only has room for Theme settings.
      const abdhSettings = this.button(t, "settings", "sliders", () =>
        openOverlay({ mod: "abdh-settings", kind: "dialog", width: 780, height: 620 }), "Theme settings");
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).gap(2).items_center()
        .when(narrow(), (el) => el.justify_center().child(abdhSettings))
        .when(!narrow(), (el) => el
          .child(abdhSettings)
          .child(this.button(t, "herdr-settings", "settings", () => run("app.settings"),
            `Herdr settings${keyFor("app.settings") ? "  " + keyFor("app.settings") : ""}`))
          .child(this.button(t, "add-machine", "server", () => run("mod.open", { name: "machine-add" }), "Add machine"))
          .child(div().flex_1())
          .child(this.button(t, "shortcuts", "keyboard", () => run("app.help"),
            `Keyboard shortcuts${keyFor("app.help") ? "  " + keyFor("app.help") : ""}`)));
    }
    const lights = window()?.platform === "macos" && window()?.titlebar === "none" && !window()?.fullscreen;
    return h_flex().size_full().bg(t.chrome).pl(lights && !narrow() ? 76 : 12).pr(8).gap(2).items_center()
      .child(h_flex().id("abdh-brand").flex_1().min_w(0).gap(7).items_center()
        .child(div().size(7).rounded(2).bg(t.accent))
        .when(!narrow(), (el) => el.child(div().font_semibold().text_size(13).text_color(t.foreground).child("Agentee"))))
      .when(!narrow(), (el) => el.child(this.button(t, "search", "search", () => run("mod.open", { name: "picker" }), "Find a command or file")))
      // A toggle, like the window bar's tools: hides the panel when it shows.
      .when(!narrow(), (el) => el.child(this.button(t, "panel", "folder", () => {
        if (panelShown()) { run("layout.hide", { id: "panel" }); return; }
        run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: "panel-files" });
      }, panelShown() ? "Hide Files, Agents and System" : "Show Files, Agents and System")
        .when(panelShown(), (b) => b.bg(t.raised).text_color(t.accent))))
      .child(this.button(t, "sidebar-toggle", "sidebar", toggleSidebar, narrow() ? "Show sidebar" : "Hide sidebar"));
  }
}

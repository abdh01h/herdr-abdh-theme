// Agentee settings: the theme's own control panel.
//
// Opened as an overlay with props { section? } — "appearance" | "tabs" |
// "explorer" | "agents" | "system" | "status" | "git". A left rail switches
// sections; the body scrolls.
//
// This mod owns `abdh.settings`: it loads `abdh-settings.json` from appHome(),
// merges the defaults below, publishes the result with setShared so the other
// Agentee panels react, and writes the whole file back on every edit.
// Nothing outside this mod writes that file.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, closeOverlay, props, readTextFile, setShared, shared, theme, themes, settings, run } from "herdr";
import * as fs from "fs/promises";

// The shared contract (see the theme brief). These three groups and their
// values are fixed; the panels read them and fall back to the same numbers.
const CONTRACT_DEFAULTS = {
  agents: { enabled: true, interval: 15, showTokens: true, showHistory: true },
  system: {
    enabled: true,
    interval: 2,
    showCpu: true,
    showGpu: true,
    showRam: true,
    showStorage: true,
    showNetwork: true,
    showTemp: true,
  },
  git: { refresh: 5 },
};

// Groups the contract leaves to the layout owner, plus the git panel's two
// extra switches. They extend the contract; none of its values change.
const EXTRA_DEFAULTS = {
  appearance: {
    uiFont: "Geist",
    monoFont: "JetBrains Mono",
    monoSize: 13,
    softWrap: true,
    borderIntensity: 1,
    compact: true,
  },
  tabs: {
    minWidth: 60,
    maxWidth: 200,
    fullFilenames: true,
    closeOnHover: true,
    scrolling: true,
  },
  explorer: {
    icons: true,
    gitColors: true,
    hiddenFiles: false,
    expandedDepth: 1,
  },
  status: {
    lines: true,
    characters: false,
    cursor: true,
    gitBranch: true,
    gitChanges: true,
    gitBlame: false,
  },
  git: { ...CONTRACT_DEFAULTS.git, confirmMerge: true, conflictNotices: true, openInTab: false },
};

const DEFAULTS = {
  appearance: EXTRA_DEFAULTS.appearance,
  tabs: EXTRA_DEFAULTS.tabs,
  explorer: EXTRA_DEFAULTS.explorer,
  agents: CONTRACT_DEFAULTS.agents,
  system: CONTRACT_DEFAULTS.system,
  status: EXTRA_DEFAULTS.status,
  git: EXTRA_DEFAULTS.git,
};

// Number fields: bounds and step. `interval`s are seconds, widths/sizes px.
const NUMBERS = {
  "appearance.monoSize": { min: 9, max: 22, step: 1 },
  "appearance.borderIntensity": { min: 0, max: 2, step: 1 },
  "tabs.minWidth": { min: 60, max: 320, step: 10 },
  "tabs.maxWidth": { min: 80, max: 480, step: 10 },
  "explorer.expandedDepth": { min: 0, max: 8, step: 1 },
  "agents.interval": { min: 2, max: 120, step: 1 },
  "system.interval": { min: 1, max: 30, step: 1 },
  "git.refresh": { min: 2, max: 60, step: 1 },
};

const SECTIONS = [
  {
    id: "appearance",
    label: "Appearance",
    note: "The Agentee editor's text: size and wrapping.",
    rows: [
      { group: "appearance", key: "monoSize", kind: "number", label: "Mono size", help: "Editor text, in px (files opened after the change)." },
      { group: "appearance", key: "softWrap", kind: "toggle", label: "Wrap long lines", help: "Lines wrap at the editor's edge instead of scrolling sideways." },
    ],
  },
  {
    id: "themes",
    label: "Themes",
    note: "Every file in themes/. Paged so a large library cannot stall this view; Herdr's own Settings draws a card per theme and does.",
    rows: [],
  },
  {
    id: "tabs",
    label: "Tabs",
    note: "How the tab strip sizes and reveals itself.",
    rows: [
      { group: "tabs", key: "minWidth", kind: "number", label: "Minimum tab width", help: "Narrowest a tab may shrink to, in px." },
      { group: "tabs", key: "maxWidth", kind: "number", label: "Maximum tab width", help: "Widest a tab may grow, in px." },
      { group: "tabs", key: "fullFilenames", kind: "toggle", label: "Full file names", help: "Show whole names instead of truncating." },
      { group: "tabs", key: "closeOnHover", kind: "toggle", label: "Close on hover", help: "Reveal the close button over a tab." },
    ],
  },
  {
    id: "explorer",
    label: "Explorer",
    note: "The Files panel's tree and colouring.",
    rows: [
      { group: "explorer", key: "icons", kind: "toggle", label: "File icons", help: "Draw a type icon beside each file." },
      { group: "explorer", key: "gitColors", kind: "toggle", label: "Git colors", help: "Tint changed files by their status." },
      { group: "explorer", key: "hiddenFiles", kind: "toggle", label: "Hidden files", help: "List dotfiles and other hidden entries." },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    note: "The agents and token analytics panel.",
    rows: [
      { group: "agents", key: "enabled", kind: "toggle", label: "Enabled", help: "Refresh the agents list at all." },
      { group: "agents", key: "interval", kind: "number", label: "Refresh interval", help: "Seconds between collections." },
      { group: "agents", key: "showTokens", kind: "toggle", label: "Show tokens", help: "Token totals and charts." },
      { group: "agents", key: "showHistory", kind: "toggle", label: "Show history", help: "Hour, day and month series." },
    ],
  },
  {
    id: "system",
    label: "System",
    note: "The system monitor panel: what it probes and how often.",
    rows: [
      { group: "system", key: "enabled", kind: "toggle", label: "Enabled", help: "Run the probes at all." },
      { group: "system", key: "interval", kind: "number", label: "Refresh interval", help: "Seconds between samples (minimum 1)." },
      { group: "system", key: "showCpu", kind: "toggle", label: "CPU", help: "Usage, cores, clock and temperature." },
      { group: "system", key: "showGpu", kind: "toggle", label: "GPU", help: "Model, utilization, VRAM and temperature." },
      { group: "system", key: "showRam", kind: "toggle", label: "Memory", help: "Used, available and swap." },
      { group: "system", key: "showStorage", kind: "toggle", label: "Storage", help: "Fixed disks with their usage." },
      { group: "system", key: "showNetwork", kind: "toggle", label: "Network", help: "Up and down rates from sample deltas." },
      { group: "system", key: "showTemp", kind: "toggle", label: "Temperatures", help: "Sensor readings where the OS exposes them." },
    ],
  },
  {
    id: "status",
    label: "Status bar",
    note: "Which fields the status bar shows.",
    rows: [
      { group: "status", key: "lines", kind: "toggle", label: "Line count", help: "Lines in the open file." },
      { group: "status", key: "characters", kind: "toggle", label: "Character count", help: "Characters in the open file." },
      { group: "status", key: "gitBranch", kind: "toggle", label: "Git branch", help: "The current branch." },
      { group: "status", key: "gitChanges", kind: "toggle", label: "Git changes", help: "Counts of modified, staged and untracked files." },
    ],
  },
  {
    id: "git",
    label: "Git",
    note: "How Git opens, its refresh, and notices.",
    rows: [
      { group: "git", key: "openInTab", kind: "toggle", label: "Open as a tab", help: "Off: a popup over the work area. On: a Git tab in the active space." },
      { group: "git", key: "refresh", kind: "number", label: "Refresh interval", help: "Seconds between status reads." },
      { group: "git", key: "conflictNotices", kind: "toggle", label: "Conflict notices", help: "Notify when a merge stops on conflicts." },
    ],
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(n, meta) {
  return Math.min(meta.max, Math.max(meta.min, n));
}

function text(value) {
  return String(value);
}

function message(error) {
  return error?.message ?? String(error);
}

// Deep merge by group: the file's values win where their type matches the
// default's; unknown groups and members are kept so a newer file survives.
function merge(stored) {
  const out = clone(DEFAULTS);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const group of Object.keys(out)) {
    const saved = stored[group];
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
    const next = { ...out[group] };
    for (const key of Object.keys(next)) {
      const value = saved[key];
      const fallback = next[key];
      if (typeof value === "boolean" && typeof fallback === "boolean") {
        next[key] = value;
      } else if (typeof value === "number" && typeof fallback === "number" && Number.isFinite(value)) {
        const meta = NUMBERS[`${group}.${key}`];
        next[key] = meta ? clamp(value, meta) : value;
      } else if (typeof value === "string" && typeof fallback === "string" && value.trim()) {
        next[key] = value.trim();
      }
    }
    for (const key of Object.keys(saved)) if (!(key in next)) next[key] = saved[key];
    out[group] = next;
  }
  for (const key of Object.keys(stored)) if (!(key in out)) out[key] = stored[key];
  return out;
}

function sectionId(section) {
  return SECTIONS.some((s) => s.id === section) ? section : SECTIONS[0].id;
}

const ICONS = { appearance: "palette", tabs: "layers", explorer: "folder", agents: "bot", system: "cpu", status: "monitor", git: "branch" };

export default class AbdhSettings extends View {
  init(_props, cx) {
    this.file = `${appHome()}/abdh-settings.json`;
    this.value = clone(DEFAULTS);
    this.section = sectionId(props()?.section);
    this.inputs = {};
    this.focused = {};
    this.invalid = {};
    this.loadError = "";
    this.saveError = "";
    this.wrote = false;
    this.saving = false;
    this.pendingSave = false;
    this.themeQuery = "";
    this.themeInput = InputState.new({ placeholder: "Filter themes" });
    this.themeInput.on("change", (_e, cx) => { this.themeQuery = this.themeInput.value(); this.themePage = 0; cx.notify(); });

    for (const section of SECTIONS) {
      for (const row of section.rows) {
        if (row.kind !== "toggle") this.makeInput(row, cx);
      }
    }

    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(0, () => this.handle.focus());

    cx.spawn(async (cx) => {
      let stored = null;
      let absent = false;
      try {
        const raw = await readTextFile(this.file);
        absent = raw === null;
        if (raw !== null) stored = JSON.parse(raw);
      } catch (error) {
        this.loadError = `Could not read ${this.file}: ${message(error)}`;
      }
      // A file that will not parse keeps what the panels already use, so one
      // bad hand edit does not reset every setting to its default.
      this.value = merge(this.loadError ? shared("abdh.settings") : stored);
      setShared("abdh.settings", this.value);
      this.syncInputs();
      cx.notify();
      // The other panels may read the JSON at their init: make it exist once.
      if (absent && !this.loadError) this.save(cx);
    });
  }

  makeInput(row, cx) {
    const key = `${row.group}.${row.key}`;
    const meta = NUMBERS[key];
    const state = InputState.new({
      placeholder: row.kind === "number" ? text(DEFAULTS[row.group][row.key]) : "Font name",
      value: text(this.value[row.group][row.key]),
    });
    if (meta) {
      state.set_step(meta.step);
      state.set_min(meta.min);
      state.set_max(meta.max);
    }
    state.on("change", (_e, cx) => {
      this.focused[key] = true;
      this.commit(row, state.value(), false, cx);
    });
    state.on("submit", (_e, cx) => {
      this.commit(row, state.value(), true, cx);
    });
    state.on("focus", (_e, cx) => {
      this.focused[key] = true;
      cx.notify();
    });
    state.on("blur", (_e, cx) => {
      this.focused[key] = false;
      this.commit(row, state.value(), true, cx);
    });
    this.inputs[key] = state;
  }

  syncInputs() {
    for (const key of Object.keys(this.inputs)) {
      const [group, member] = key.split(".");
      const value = this.value?.[group]?.[member];
      if (value !== undefined) this.inputs[key].set_value(text(value));
      this.invalid[key] = false;
    }
  }

  // A change while typing only lands when it is already valid; submit and blur
  // clamp into range (or restore the stored value), so the file never gets a
  // half-typed number.
  commit(row, raw, final, cx) {
    const key = `${row.group}.${row.key}`;
    const state = this.inputs[key];
    const stored = this.value[row.group][row.key];
    const trimmed = raw.trim();

    if (row.kind === "text") {
      if (!trimmed) {
        this.invalid[key] = true;
        if (final && state) state.set_value(text(stored));
        if (final) this.invalid[key] = false;
        cx.notify();
        return;
      }
      this.invalid[key] = false;
      this.setValue(row.group, row.key, trimmed, cx);
      return;
    }

    const n = Number(trimmed);
    const meta = NUMBERS[key];
    if (!trimmed || !Number.isFinite(n)) {
      this.invalid[key] = true;
      if (final && state) {
        state.set_value(text(stored));
        this.invalid[key] = false;
      }
      cx.notify();
      return;
    }
    if (n < meta.min || n > meta.max) {
      if (!final) {
        this.invalid[key] = true;
        cx.notify();
        return;
      }
      const clamped = clamp(n, meta);
      this.invalid[key] = false;
      this.setValue(row.group, row.key, clamped, cx);
      if (state) state.set_value(text(clamped));
      return;
    }
    this.invalid[key] = false;
    this.setValue(row.group, row.key, n, cx);
    if (final && state) state.set_value(text(n));
  }

  setValue(group, key, value, cx) {
    const previous = this.value[group]?.[key];
    if (previous === value) {
      cx.notify();
      return;
    }
    let next = { ...this.value, [group]: { ...this.value[group], [key]: value } };
    // Tab widths must stay ordered; raising the floor lifts a lower ceiling.
    if (group === "tabs" && next.tabs.minWidth > next.tabs.maxWidth) {
      next = { ...next, tabs: { ...next.tabs, maxWidth: next.tabs.minWidth } };
      this.inputs["tabs.maxWidth"]?.set_value(text(next.tabs.maxWidth));
    }
    this.value = next;
    setShared("abdh.settings", next);
    this.save(cx);
    cx.notify();
  }

  // One writer at a time; edits made while a write is in flight queue exactly
  // one follow-up write with the latest value.
  save(cx) {
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    cx.spawn(async (cx) => {
      for (;;) {
        this.pendingSave = false;
        const body = `${JSON.stringify(this.value, null, 2)}\n`;
        try {
          await fs.writeFile(this.file, body);
          this.wrote = true;
          this.saveError = "";
        } catch (error) {
          this.wrote = false;
          this.saveError = `Could not save ${this.file}: ${message(error)}`;
        }
        if (!this.pendingSave) break;
      }
      this.saving = false;
      cx.notify();
    });
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  toggle(t, group, key, on, label) {
    return h_flex()
      .id(`toggle-${group}-${key}`)
      .w(34)
      .h(18)
      .flex_none()
      .rounded(9)
      .px(2)
      .items_center()
      .cursor_pointer()
      .role("switch")
      .accessibility_label(label)
      .when(on, (el) => el.justify_end())
      .when(!on, (el) => el.justify_start())
      .bg(on ? t.accent : t.input)
      .on_click((_e, cx) => this.setValue(group, key, !on, cx))
      .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted));
  }

  inputControl(t, row) {
    const key = `${row.group}.${row.key}`;
    const state = this.inputs[key];
    const meta = NUMBERS[key];
    const width = row.kind === "number" ? 104 : 248;
    const border = this.invalid[key] ? t.blocked : this.focused[key] ? t.accent : t.input;
    const box = div()
      .w(width)
      .h(28)
      .px(8)
      .flex()
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(border)
      .bg(t.canvas)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (state) {
      box.child(Input.new(state).w_full().h_full().text_size(11.5).text_color(t.foreground));
    } else {
      box.child(div().text_size(11.5).text_color(t.dim).child("unavailable"));
    }
    return h_flex()
      .flex_none()
      .items_center()
      .gap(6)
      .child(box)
      .when(Boolean(meta), (el) =>
        el.child(
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child(`${meta.min}–${meta.max}`),
        ),
      );
  }

  row(t, row, first) {
    const value = this.value[row.group][row.key];
    return h_flex()
      .id(`row-${row.group}-${row.key}`)
      .w_full()
      .py(12)
      .gap(16)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(row.label))
          .when(Boolean(row.help), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(row.help))),
      )
      .child(
        row.kind === "toggle"
          ? this.toggle(t, row.group, row.key, Boolean(value), row.label)
          : this.inputControl(t, row),
      );
  }

  card(t, section) {
    return v_flex().w_full().children(section.rows.map((row, i) => this.row(t, row, i === 0)));
  }

  rail(t) {
    const error = this.saveError || this.loadError;
    return v_flex()
      .w(190)
      .flex_none()
      .h_full()
      .min_h(0)
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .bg(t.popover)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Settings"))
      .children(SECTIONS.map((section) => {
        const active = section.id === this.section;
        return h_flex()
          .id(`rail-${section.id}`)
          .h(32)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(7)
          .bg(active ? t.raised : "#00000000")
          .text_color(active ? t.foreground : t.muted)
          .hover((st) => st.bg(t.raised).text_color(t.foreground))
          .cursor_pointer()
          .on_click((_e, cx) => { this.section = section.id; cx.notify(); })
          .child(svg(`mods/abdh-settings/icons/${ICONS[section.id] ?? "palette"}.svg`).size(15).flex_none().text_color(active ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(13.5).child(section.label));
      }))
      .child(div().flex_1())
      .child(v_flex().px(10).pb(4).gap(3)
        .when(Boolean(error), (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(error)))
        .child(div().text_size(10.5).text_color(t.dim).child("Theme settings"))
        .child(div().text_size(10).text_color(this.wrote ? t.done : t.dim).child(this.wrote ? "Saved" : "Saved to the app folder"))
        .child(div().text_size(10).text_color(t.dim).child("Esc to close")));
  }

  themeList(t) {
    const q = (this.themeQuery ?? "").toLowerCase().trim();
    const all = themes().filter((x) => !q || x.name.toLowerCase().includes(q));
    const pageSize = 24;
    const page = Math.min(this.themePage ?? 0, Math.max(0, Math.ceil(all.length / pageSize) - 1));
    const list = all.slice(page * pageSize, page * pageSize + pageSize);
    // The theme in use, however it was picked (here, Herdr Settings, the palette).
    const s = settings();
    const dot = (c) => div().size(8).flex_none().rounded(4).bg(c || t.dim);
    return v_flex().w_full()
      .child(h_flex().pb(8).gap(8).items_center()
        .child(Input.new(this.themeInput).flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(`${all.length} themes`)))
      .children(list.map(({ name, light, colors: c }) => {
        const on = name === (light ? s.theme_light : s.theme_dark);
        return h_flex().id(`theme-${name}`).h(30).gap(8).items_center().border_b(1).border_color(t.border)
          .cursor_pointer().when(on, (el) => el.bg(t.raised)).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => { run("app.theme", { name }); setShared("abdh.theme", name); cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(on ? t.foreground : t.muted).child(name.replace(/-/g, " ")))
          .child(div().text_size(10).text_color(t.dim).child(light ? "light" : "dark"))
          .child(h_flex().gap(4).items_center()
            .child(dot(c.background)).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi4)))
          .when(on, (el) => el.child(div().text_size(11).text_color(t.accent).child("\u2713")));
      }))
      .when(all.length > pageSize, (el) => el.child(h_flex().pt(10).gap(8).items_center()
        .child(div().id("themes-prev").h(24).px(9).flex().items_center().rounded(5).bg(t.raised)
          .text_color(page > 0 ? t.muted : t.dim)
          .when(page > 0, (x) => x.cursor_pointer().hover((y) => y.bg(t.hover)))
          .on_click((_e, cx) => { if (page > 0) { this.themePage = page - 1; cx.notify(); } }).child("Previous"))
        .child(div().text_size(10.5).text_color(t.dim).child(`${page * pageSize + 1}\u2013${page * pageSize + list.length} of ${all.length}`))
        .child(div().id("themes-next").h(24).px(9).flex().items_center().rounded(5).bg(t.raised)
          .text_color(page * pageSize + list.length < all.length ? t.muted : t.dim)
          .when(page * pageSize + list.length < all.length, (x) => x.cursor_pointer().hover((y) => y.bg(t.hover)))
          .on_click((_e, cx) => { if (page * pageSize + list.length < all.length) { this.themePage = page + 1; cx.notify(); } }).child("Next"))));
  }

  body(t) {
    const section = SECTIONS.find((s) => s.id === this.section) ?? SECTIONS[0];
    return div()
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .child(div().id("abdh-settings-body").size_full().overflow_y_scroll()
        .child(v_flex().px(28).py(22)
          .child(div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(section.label.toUpperCase()))
          .when(Boolean(section.note), (el) => el.child(div().pb(10).text_size(12.5).text_color(t.dim).child(section.note)))
          .child(section.id === "themes" ? this.themeList(t) : this.card(t, section))));
  }

  render(cx) {
    const t = theme();
    return h_flex()
      .id("abdh-settings")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        this.close();
        cx.stop_propagation();
      })
      .w_full()
      .h(620)
      .min_h(0)
      .items_start()
      .bg(t.popover)
      .child(this.rail(t))
      .child(this.body(t));
  }
}

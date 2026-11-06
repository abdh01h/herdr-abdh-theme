// System: a compact, real-metrics hardware monitor for the Agentee layout.
//
// Everything drawn here comes from platform probes (see probes/). Missing
// fields say "unavailable"; the first CPU/disk/network sample says
// "sampling..." until a second reading gives a real delta. The panel never
// writes shared state: theme settings are read from shared("agentee.settings")
// on every render, with appHome()/agentee-settings.json only as an init fallback.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, layout, readTextFile, shared, theme } from "herdr";
import { collect } from "./probe.js";
import { bytes, clamp, clock, mhz, num, percent, rate, tempC, uptime } from "./format.js";

const HISTORY_LENGTH = 40;

const SYSTEM_DEFAULTS = {
  enabled: true,
  interval: 2,
  showCpu: true,
  showGpu: true,
  showRam: true,
  showStorage: true,
  showNetwork: true,
  showTemp: true,
  compact: false,
};

function systemSettings(source) {
  const value = source && typeof source === "object" ? source : {};
  const system = value.system && typeof value.system === "object" ? value.system : {};
  // Settings' "Compact spacing" lives under appearance; a system value wins.
  const appearance = value.appearance && typeof value.appearance === "object" ? value.appearance : {};
  return { ...SYSTEM_DEFAULTS, compact: appearance.compact ?? SYSTEM_DEFAULTS.compact, ...system };
}

// Whether this panel's block is on screen: false when its stack shows another
// child or a column above it is hidden, null when the layout does not hold it
// (a tab pane or an overlay), which keeps sampling.
function shownInLayout(node, visible = true) {
  if (!node || typeof node !== "object") return null;
  const here = visible && !node.hidden;
  if (node.content?.mod === "agentee-system") return here;
  let seen = null;
  for (const child of node.children || []) {
    const shown = shownInLayout(child, here && (node.type !== "stack" || !node.active || node.active === child.id));
    if (shown) return true;
    if (shown === false) seen = false;
  }
  return seen;
}

function meterColor(t, value) {
  if (value === null || value === undefined) return t.dim;
  if (value >= 90) return t.blocked;
  if (value >= 70) return t.ansi3;
  return t.done;
}

function bar(t, value, height) {
  const percentValue = clamp(value, 0, 100);
  return h_flex()
    .w_full()
    .h(height)
    .rounded(2)
    .bg(t.hover)
    .overflow_hidden()
    .when(percentValue !== null && percentValue > 0, (el) =>
      el.child(
        div()
          .h(height)
          .w(`${Math.max(1.5, percentValue)}%`)
          .rounded(2)
          .bg(meterColor(t, percentValue)),
      ),
    );
}

function sparkline(t, values, max, color, height) {
  const list = (values || []).slice(-HISTORY_LENGTH);
  const limit = Math.max(1, num(max) ?? 1);
  const bars = [];
  for (let i = list.length; i < HISTORY_LENGTH; i += 1) {
    bars.push(div().flex_1().w_full().h(1).bg(t.hover));
  }
  for (const value of list) {
    const ratio = clamp(value, 0, limit) ?? 0;
    const barHeight = Math.max(1, Math.round((ratio / limit) * height));
    bars.push(div().flex_1().w_full().h(barHeight).bg(color));
  }
  return h_flex().w_full().h(height).items_end().gap(1).children(bars);
}

function card(t, compact, children) {
  return v_flex()
    .flex_none()
    .gap(compact ? 4 : 6)
    .p(compact ? 7 : 9)
    .rounded(6)
    .bg(t.raised)
    .border(1)
    .border_color(t.border)
    .children(children.filter(Boolean));
}

function cardHead(t, title, right) {
  return h_flex()
    .w_full()
    .items_center()
    .justify_between()
    .gap(6)
    .child(
      div()
        .flex_none()
        .text_size(9.5)
        .font_semibold()
        .text_color(t.dim)
        .child(String(title).toUpperCase()),
    )
    .when(Boolean(right), (el) =>
      el.child(div().flex_none().text_size(10).text_color(t.muted).child(right)),
    );
}

function labelValue(t, label, value, color) {
  return h_flex()
    .w_full()
    .items_center()
    .justify_between()
    .gap(8)
    .child(div().flex_none().text_size(10).text_color(t.muted).child(label))
    .child(
      div()
        .flex_none()
        .text_size(10.5)
        .text_color(color || t.foreground)
        .child(value),
    );
}

function unavailable(t, text = "unavailable") {
  return div().text_size(10.5).text_color(t.dim).child(text);
}

export default class SystemMonitor extends View {
  init(_props, cx) {
    this.probeState = { windows: {}, linux: {}, macos: {} };
    this.data = null;
    this.error = null;
    this.paused = false;
    this.inFlight = false;
    this.lastAt = 0;
    this.hasUsage = false;
    this.tick = 0;
    this.width = 0;
    this.fileSettings = null;
    this.history = { cpu: [], ram: [], down: [], up: [] };

    // The settings overlay owns shared("agentee.settings"); before it has set the
    // key, a directly launched panel still honours the persisted file.
    if (shared("agentee.settings") == null) {
      cx.spawn(async (cx) => {
        try {
          const text = await readTextFile(`${appHome()}/agentee-settings.json`);
          if (!text) return;
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && shared("agentee.settings") == null) {
            this.fileSettings = parsed;
            cx.notify();
          }
        } catch {
          // Absent or invalid settings file: defaults are fine.
        }
      });
    }

    cx.timer.every(1000, (timerCx) => this.maybeSample(timerCx));
    this.maybeSample(cx);
  }

  settings() {
    const value = shared("agentee.settings");
    return systemSettings(value == null ? this.fileSettings : value);
  }

  maybeSample(cx) {
    if (this.paused || this.inFlight) return;
    const settings = this.settings();
    if (!settings.enabled) return;
    // Hidden copies keep their timers (Herdr keeps a stack's other children
    // alive), so do not spawn probes nobody is looking at.
    if (shownInLayout(layout()) === false) return;
    const interval = Math.max(1, num(settings.interval) ?? 2) * 1000;
    // The first samples arrive a second apart so CPU/disk/network deltas exist
    // quickly; after that the configured interval decides.
    const wait = this.hasUsage || this.tick > 3 ? interval : 1000;
    // lastAt is the start of the last sample; the 1 s tick lands a little late.
    if (this.lastAt && Date.now() - this.lastAt < wait - 250) return;
    this.sample(cx);
  }

  sample(cx) {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastAt = Date.now();
    this.tick += 1;
    const slow = this.tick % 3 === 1;
    cx.spawn(async (spawnCx) => {
      let result = null;
      try {
        result = await collect(this.probeState, { slow });
      } catch (error) {
        result = { at: Date.now(), errors: [String(error && error.message ? error.message : error)] };
      }
      this.inFlight = false;
      const usable = Boolean(result && (result.cpu || result.ram || result.disks?.length || result.os));
      if (usable) {
        this.apply(result);
        this.error = null;
      } else {
        this.error = (result?.errors || []).join("; ") || "System probes returned nothing";
      }
      spawnCx.notify();
    });
  }

  apply(result) {
    this.data = result;
    if (num(result.cpu?.usage) !== null) {
      this.history.cpu.push(result.cpu.usage);
      this.hasUsage = true;
    }
    if (num(result.ram?.percent) !== null) this.history.ram.push(result.ram.percent);
    if (num(result.net?.down) !== null) {
      this.history.down.push(result.net.down);
      this.history.up.push(num(result.net.up) ?? 0);
      this.hasUsage = true;
    }
    for (const key of ["cpu", "ram", "down", "up"]) {
      const list = this.history[key];
      if (list.length > HISTORY_LENGTH) list.splice(0, list.length - HISTORY_LENGTH);
    }
  }

  render(cx) {
    const t = theme();
    const settings = this.settings();
    const compact = Boolean(settings.compact);
    const gap = compact ? 6 : 8;
    const pad = compact ? 7 : 9;
    const cards = this.cards(t, settings);

    const body = this.width >= 560 && cards.length > 2
      ? h_flex()
          .w_full()
          .items_start()
          .gap(gap)
          .children([0, 1].map((column) =>
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(gap)
              .children(cards.filter((_, index) => index % 2 === column)),
          ))
      : v_flex().w_full().gap(gap).children(cards);

    return v_flex()
      .id("agentee-system-root")
      .size_full()
      .bg(t.surface)
      .text_size(11)
      .on_size_change((size, sizeCx) => {
        const width = Math.round(size.width);
        if (Math.abs((this.width || 0) - width) > 8) {
          this.width = width;
          sizeCx.notify();
        }
      })
      .child(this.header(t, settings))
      .child(
        div()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .child(v_flex().w_full().p(pad).gap(gap).child(body)),
      );
  }

  header(t, settings) {
    const statusColor = this.error ? t.blocked : this.paused ? t.done : this.data ? t.working : t.dim;
    const statusText = this.error
      ? "error"
      : this.paused
        ? "paused"
        : this.data
          ? `updated ${clock(this.data.at)} \u00b7 ${Math.max(1, num(settings.interval) ?? 2)}s`
          : "sampling\u2026";
    return h_flex()
      .flex_none()
      .w_full()
      .h(30)
      .px(9)
      .items_center()
      .justify_between()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().w(5).h(5).rounded_full().bg(statusColor))
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("System"))
          .child(div().text_size(9.5).text_color(t.dim).child(statusText)),
      )
      .child(
        h_flex()
          .items_center()
          .gap(4)
          .child(
            this.button(t, "agentee-system-pause", this.paused ? "resume" : "pause", this.paused, (clickCx) => {
              this.paused = !this.paused;
              this.lastAt = 0;
              clickCx.notify();
            }),
          )
          .child(
            this.button(t, "agentee-system-refresh", "refresh", false, (clickCx) => {
              this.lastAt = 0;
              this.sample(clickCx);
            }),
          ),
      );
  }

  button(t, id, label, active, onClick) {
    return h_flex()
      .id(id)
      .h(18)
      .px(6)
      .items_center()
      .rounded(4)
      .bg(active ? t.selected : t.hover)
      .text_color(active ? t.foreground : t.muted)
      .text_size(10)
      .hover((style) => style.bg(t.selected))
      .on_click((_event, clickCx) => {
        clickCx.stop_propagation();
        onClick(clickCx);
      })
      .child(label);
  }

  cards(t, settings) {
    const data = this.data;
    const cards = [];
    if (!settings.enabled) {
      cards.push(
        card(t, settings.compact, [
          cardHead(t, "System"),
          unavailable(t, "System monitor is disabled in theme settings."),
        ]),
      );
      return cards;
    }
    if (this.error) {
      cards.push(
        card(t, settings.compact, [
          cardHead(t, "Probe"),
          div().text_size(10.5).text_color(t.blocked).child(this.error),
        ]),
      );
    }
    if (settings.showCpu) cards.push(this.cpuCard(t, settings, data));
    if (settings.showRam) cards.push(this.ramCard(t, settings, data));
    if (settings.showGpu) {
      const gpus = data?.gpu || [];
      if (gpus.length === 0) {
        cards.push(card(t, settings.compact, [cardHead(t, "GPU", "unavailable"), unavailable(t)]));
      } else {
        for (const gpu of gpus) cards.push(this.gpuCard(t, settings, gpu));
      }
    }
    if (settings.showStorage) cards.push(this.storageCard(t, settings, data));
    if (settings.showNetwork) cards.push(this.networkCard(t, settings, data));
    cards.push(this.systemCard(t, settings, data));
    return cards;
  }

  cpuCard(t, settings, data) {
    const cpu = data?.cpu;
    const usage = num(cpu?.usage);
    const children = [
      h_flex()
        .w_full()
        .items_center()
        .gap(8)
        .child(
          cpu?.model
            ? div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(cpu.model)
            : unavailable(t, "CPU model unavailable"),
        )
        .child(div().flex_none().text_size(10.5).text_color(t.muted).child(mhz(cpu?.mhz))),
      h_flex()
        .w_full()
        .items_end()
        .gap(10)
        .child(
          div()
            .flex_none()
            .text_size(22)
            .font_semibold()
            .text_color(usage === null ? t.dim : t.foreground)
            .child(usage === null ? "\u2014" : `${Math.round(usage)}%`),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(4)
            .child(bar(t, usage, 5))
            .child(
              usage === null
                ? div().text_size(9.5).text_color(t.dim).child("sampling\u2026")
                : sparkline(t, this.history.cpu, 100, meterColor(t, usage), 16),
            ),
        ),
    ];

    const cores = Array.isArray(cpu?.perCore) ? cpu.perCore : [];
    if (cores.length > 0 && !settings.compact) {
      children.push(
        h_flex()
          .w_full()
          .h(14)
          .gap(2)
          .children(
            cores.map((value, index) => {
              const coreHeight = value === null ? 1 : Math.max(2, Math.round((clamp(value, 0, 100) / 100) * 14));
              return v_flex()
                .id(`agentee-core-${index}`)
                .flex_1()
                .h(14)
                .rounded(1)
                .bg(t.hover)
                .justify_end()
                .overflow_hidden()
                .tooltip(value === null ? `core ${index + 1}: unavailable` : `core ${index + 1}: ${Math.round(value)}%`)
                .child(div().w_full().h(coreHeight).bg(meterColor(t, value)));
            }),
          ),
      );
    }

    const meta = [];
    if (cpu?.physical !== null && cpu?.physical !== undefined) meta.push(`${cpu.physical} cores`);
    if (cpu?.logical !== null && cpu?.logical !== undefined) meta.push(`${cpu.logical} threads`);
    if (settings.showTemp) meta.push(cpu?.tempC === null || cpu?.tempC === undefined ? "temp unavailable" : tempC(cpu.tempC));
    if (meta.length > 0) {
      children.push(div().w_full().text_size(9.5).text_color(t.dim).child(meta.join("  \u00b7  ")));
    }

    return card(t, settings.compact, [cardHead(t, "CPU", usage === null ? "sampling\u2026" : percent(usage)), ...children]);
  }

  ramCard(t, settings, data) {
    const ram = data?.ram;
    const value = num(ram?.percent);
    const children = [
      h_flex()
        .w_full()
        .items_end()
        .gap(10)
        .child(
          div()
            .flex_none()
            .text_size(22)
            .font_semibold()
            .text_color(value === null ? t.dim : t.foreground)
            .child(value === null ? "\u2014" : `${Math.round(value)}%`),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(4)
            .child(bar(t, value, 5))
            .child(sparkline(t, this.history.ram, 100, meterColor(t, value), 16)),
        ),
    ];
    if (ram) {
      children.push(
        labelValue(t, "Used", `${bytes(ram.used)} / ${bytes(ram.total)}`),
        labelValue(t, "Available", bytes(ram.available)),
        labelValue(t, "Free", bytes(ram.free)),
      );
      if (ram.swapTotal !== null && ram.swapTotal !== undefined && ram.swapTotal > 0) {
        children.push(labelValue(t, "Swap / page", `${bytes(ram.swapUsed)} / ${bytes(ram.swapTotal)}`));
      } else if (ram.swapTotal !== null && ram.swapTotal !== undefined) {
        children.push(labelValue(t, "Swap / page", "none", t.dim));
      }
    } else {
      children.push(unavailable(t));
    }
    return card(t, settings.compact, [cardHead(t, "Memory", ram ? `${bytes(ram.used)} / ${bytes(ram.total)}` : "unavailable"), ...children]);
  }

  gpuCard(t, settings, gpu) {
    const usage = num(gpu.usage);
    const memUsed = num(gpu.memUsed);
    const memTotal = num(gpu.memTotal);
    const children = [
      h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(gpu.name || "GPU"))
        .child(div().flex_none().text_size(9.5).text_color(t.dim).child(gpu.vendor || "GPU")),
    ];
    if (usage !== null) {
      children.push(
        h_flex()
          .w_full()
          .items_center()
          .gap(8)
          .child(div().flex_none().w(34).text_size(10).text_color(t.muted).child("usage"))
          .child(div().flex_1().min_w(0).child(bar(t, usage, 4)))
          .child(div().flex_none().text_size(10.5).text_color(t.foreground).child(percent(usage))),
      );
    }
    if (memTotal !== null) {
      const memPercent = memUsed !== null && memTotal > 0 ? (memUsed / memTotal) * 100 : null;
      children.push(
        h_flex()
          .w_full()
          .items_center()
          .gap(8)
          .child(div().flex_none().w(34).text_size(10).text_color(t.muted).child("vram"))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .child(bar(t, memPercent, 4))
              .child(
                div()
                  .text_size(9.5)
                  .text_color(t.dim)
                  .child(memUsed === null ? `used unavailable / ${bytes(memTotal)}` : `${bytes(memUsed)} / ${bytes(memTotal)}`),
              ),
          ),
      );
    }
    const meta = [];
    if (settings.showTemp && gpu.tempC !== null && gpu.tempC !== undefined) meta.push(tempC(gpu.tempC));
    if (gpu.mhz !== null && gpu.mhz !== undefined) meta.push(mhz(gpu.mhz));
    if (gpu.cores !== null && gpu.cores !== undefined) meta.push(`${gpu.cores} cores`);
    if (meta.length > 0) children.push(div().w_full().text_size(9.5).text_color(t.dim).child(meta.join("  \u00b7  ")));
    if (usage === null && memUsed === null) children.push(unavailable(t));
    return card(t, settings.compact, [cardHead(t, "GPU", null), ...children]);
  }

  storageCard(t, settings, data) {
    const disks = data?.disks || [];
    const children = [];
    if (disks.length === 0) {
      children.push(unavailable(t));
    } else {
      for (const disk of disks) {
        const value = num(disk.percent);
        const activity = disk.readBps !== null && disk.readBps !== undefined
          ? `R ${rate(disk.readBps)}  W ${rate(disk.writeBps)}`
          : "activity unavailable";
        children.push(
          v_flex()
            .w_full()
            .gap(3)
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(6)
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .child(`${disk.mount || disk.name}${disk.name && disk.name !== disk.mount ? `  ${disk.name}` : ""}`),
                )
                .child(
                  div()
                    .flex_none()
                    .text_size(9.5)
                    .text_color(t.muted)
                    .child(`${bytes(disk.free)} free of ${bytes(disk.total)}`),
                ),
            )
            .child(bar(t, value, 3))
            .child(
              h_flex()
                .w_full()
                .justify_between()
                .gap(6)
                .child(div().text_size(9).text_color(t.dim).child(`${bytes(disk.used)} used`))
                .child(div().text_size(9).text_color(t.dim).child(activity)),
            ),
        );
      }
    }
    return card(t, settings.compact, [cardHead(t, "Storage", `${disks.length} volume${disks.length === 1 ? "" : "s"}`), ...children]);
  }

  networkCard(t, settings, data) {
    const net = data?.net;
    const down = num(net?.down);
    const up = num(net?.up);
    const max = Math.max(1, ...this.history.down, ...this.history.up);
    const children = [
      h_flex()
        .w_full()
        .gap(12)
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .child(div().text_size(9.5).text_color(t.muted).child("DOWN"))
                .child(div().text_size(11).text_color(t.foreground).child(down === null ? "sampling\u2026" : rate(down))),
            )
            .child(sparkline(t, this.history.down, max, t.accent, 12)),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .child(div().text_size(9.5).text_color(t.muted).child("UP"))
                .child(div().text_size(11).text_color(t.foreground).child(up === null ? "sampling\u2026" : rate(up))),
            )
            .child(sparkline(t, this.history.up, max, t.ansi4, 12)),
        ),
    ];
    if (net) {
      children.push(
        labelValue(t, "Received", net.totalDown === null ? "unavailable" : bytes(net.totalDown)),
        labelValue(t, "Sent", net.totalUp === null ? "unavailable" : bytes(net.totalUp)),
      );
    } else {
      children.push(unavailable(t));
    }
    return card(t, settings.compact, [cardHead(t, "Network", net?.adapters ? `${net.adapters} interfaces` : null), ...children]);
  }

  systemCard(t, settings, data) {
    const os = data?.os;
    const rows = [];
    if (!os) {
      rows.push(unavailable(t));
    } else {
      rows.push(
        labelValue(t, "OS", os.name ? `${os.name}${os.version ? ` ${os.version}` : ""}` : "unavailable"),
        labelValue(t, "Build", os.build || "unavailable"),
        labelValue(t, "Arch", os.arch || "unavailable"),
        labelValue(t, "Host", os.hostname || "unavailable"),
        labelValue(t, "Uptime", uptime(os.uptime)),
      );
      if (os.battery) {
        rows.push(
          labelValue(
            t,
            "Battery",
            `${Math.round(os.battery.percent)}%${os.battery.charging ? " charging" : ""}`,
            os.battery.percent <= 20 ? t.blocked : t.foreground,
          ),
        );
      }
    }
    return card(t, settings.compact, [cardHead(t, "Machine", null), ...rows]);
  }
}

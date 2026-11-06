// agentee-agents — agents and token analytics for the Agentee theme.
//
// Live identity comes from `agents()`/`terminals()`/`panes()`/`spaces()`;
// token numbers come from provider usage records in the agents' own session
// logs, extracted by ./tokens.mjs (a narrowed copy of mods/insights' scanner,
// see the provenance note there). Every token number is measured; the mapping
// of a session to a live agent is estimated (folder or session label) and is
// marked "est." in the UI. A missing value renders "unavailable", never 0.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, theme, exec, appHome, home, shared, window } from "herdr";

const DEFAULTS = { enabled: true, interval: 15, showTokens: true, showHistory: true };
const MIN_INTERVAL = 2;
const SCRIPT = "mods/agentee-agents/tokens.mjs";
const CACHE = "data/agentee-agents/tokens-cache.json";
const MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

function nodeCandidates() {
  // GUI apps on macOS often start without the shell's PATH; the known
  // installers cover that without guessing on Windows or Linux.
  const platform = window()?.platform;
  if (platform === "macos") return ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"];
  if (platform === "linux") return ["node", "/usr/bin/node", "/usr/local/bin/node"];
  return ["node"];
}

function agentSettings() {
  const all = shared("agentee.settings");
  const value = all && typeof all === "object" && all.agents && typeof all.agents === "object" ? all.agents : {};
  const interval = Number(value.interval);
  return {
    enabled: value.enabled !== false,
    interval: Number.isFinite(interval)
      ? Math.max(MIN_INTERVAL, Math.min(3600, Math.round(interval)))
      : DEFAULTS.interval,
    showTokens: value.showTokens !== false,
    showHistory: value.showHistory !== false,
  };
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function compact(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "unavailable";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(v));
}

function exact(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v.toLocaleString() : "unavailable";
}

function ago(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return "unavailable";
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unavailable";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function normPath(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function shortPath(value) {
  const raw = String(value || "");
  if (!raw || raw === "unknown") return "unknown folder";
  const root = home().replace(/[\\/]+$/, "");
  const lowered = raw.toLowerCase();
  const loweredRoot = root.toLowerCase();
  let rest = raw;
  if (lowered === loweredRoot) rest = "";
  else if (lowered.startsWith(`${loweredRoot}/`) || lowered.startsWith(`${loweredRoot}\\`)) rest = raw.slice(root.length + 1);
  const parts = rest.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : "~";
}

function cleanError(text) {
  const line = String(text || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "unknown error";
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function statusWord(status) {
  if (status === "blocked") return "needs you";
  if (status === "done") return "done";
  if (status === "working") return "working";
  if (status === "error") return "failed";
  return "idle";
}

function statusColor(t, status) {
  if (status === "working") return t.working;
  if (status === "blocked" || status === "error") return t.blocked;
  if (status === "done") return t.done;
  return t.idle ?? t.dim;
}

function agentLabel(agent) {
  const program = agent.program?.name || agent.app || agent.address || "agent";
  const title = String(agent.title || "").trim();
  const telling = title
    && title !== program
    && title.toLowerCase() !== String(agent.program?.key || "").toLowerCase()
    && !/^[~/]|^[A-Za-z]:\\/.test(title)
    && !title.includes("@");
  return telling ? title : program;
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const series = raw.series && typeof raw.series === "object" ? raw.series : {};
  const list = (value) => (Array.isArray(value) ? value : []);
  const seriesOf = (value) => list(value)
    .filter((item) => item && typeof item.label === "string")
    .map((item) => ({ key: String(item.key ?? ""), label: item.label, total: number(item.total) }));
  return {
    generatedAt: number(raw.generatedAt),
    totals: {
      input: number(t.input),
      output: number(t.output),
      cacheRead: number(t.cacheRead),
      cacheWrite: number(t.cacheWrite),
      reasoning: number(t.reasoning),
      total: number(t.total),
      events: number(t.events),
    },
    models: list(raw.models)
      .filter((row) => row && typeof row.model === "string")
      .map((row) => ({
        model: row.model,
        harness: String(row.harness || ""),
        input: number(row.input),
        output: number(row.output),
        cacheRead: number(row.cacheRead),
        cacheWrite: number(row.cacheWrite),
        total: number(row.total),
        events: number(row.events),
      })),
    sessions: list(raw.sessions)
      .filter((row) => row && typeof row.id === "string" && row.tokens)
      .map((row) => ({
        id: row.id,
        harness: String(row.harness || ""),
        project: String(row.project || "unknown"),
        model: String(row.model || "unknown"),
        first: number(row.first),
        last: number(row.last),
        total: number(row.tokens.total),
        events: number(row.tokens.events),
      })),
    series: {
      hours: seriesOf(series.hours),
      days: seriesOf(series.days),
      months: seriesOf(series.months),
    },
    counts: {
      sessions: number(raw.counts?.sessions),
      events: number(raw.counts?.events),
      files: number(raw.counts?.files),
    },
    sources: list(raw.sources).filter((s) => s && typeof s.id === "string"),
    scan: raw.scan && typeof raw.scan === "object" ? raw.scan : null,
  };
}

export default class AgentsPanel extends View {
  init(_props, cx) {
    this.tokens = null;
    this.tokensError = null;
    this.scanning = false;
    this.nodeBinary = null;
    this.lastScan = 0;
    this.lastLive = 0;
    this.paused = false;
    this.width = 0;
    this.scan(cx);
    // One clock: it schedules the external scan, and redraws durations while
    // an agent is working. agents()/terminals() themselves are live, never polled.
    cx.timer.every(1000, (cx) => {
      const now = Date.now();
      const settings = agentSettings();
      if (!this.paused && settings.enabled && settings.showTokens && !this.scanning && now - this.lastScan >= settings.interval * 1000) {
        this.scan(cx);
      }
      const busy = agents().some((agent) => agent.status === "working");
      if (busy || now - this.lastLive >= 30000) {
        this.lastLive = now;
        cx.notify();
      }
    });
  }

  scan(cx) {
    if (this.scanning) return;
    const settings = agentSettings();
    if (!settings.enabled || !settings.showTokens) return;
    this.scanning = true;
    this.lastScan = Date.now();
    const script = `${appHome()}/${SCRIPT}`;
    const cache = `${appHome()}/${CACHE}`;
    cx.spawn(async (cx) => {
      let next = null;
      let error = null;
      try {
        if (!this.nodeBinary) {
          for (const candidate of nodeCandidates()) {
            try {
              const probe = await exec(candidate, ["--version"]);
              if (probe.code === 0) { this.nodeBinary = candidate; break; }
            } catch {
              // Try the next known location.
            }
          }
        }
        if (!this.nodeBinary) throw new Error("Node.js was not found; agent session logs cannot be read");
        const result = await exec(this.nodeBinary, [script, "--home", home(), "--cache", cache]);
        if (result.code !== 0) throw new Error(result.stderr || `node exited ${result.code}`);
        next = normalizeSnapshot(JSON.parse(result.stdout));
        if (!next) throw new Error("the token scan returned no data");
      } catch (reason) {
        this.nodeBinary = null;
        error = cleanError(reason?.message ?? reason);
      } finally {
        this.scanning = false;
        if (error) {
          this.tokensError = error;
        } else {
          this.tokens = next;
          this.tokensError = null;
        }
        cx.notify();
      }
    });
  }

  matchSession(agent, term, pane, sessions, used) {
    const labels = term?.labels && typeof term.labels === "object" ? term.labels : null;
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        if (!key.endsWith(".session") || typeof value !== "string" || !value) continue;
        const harness = key.slice(0, -".session".length);
        const id = `${harness}:${value}`;
        const hit = sessions.find((session) => session.id === id && !used.has(session.id));
        if (hit) return { session: hit, via: `${key} label` };
      }
    }
    const cwd = pane?.cwd || term?.cwd || null;
    if (!cwd) return null;
    const now = Date.now();
    const candidates = sessions
      .filter((session) => !used.has(session.id)
        && session.project !== "unknown"
        && normPath(session.project) === normPath(cwd)
        && session.last >= now - MATCH_WINDOW_MS)
      .sort((a, b) => b.last - a.last);
    return candidates.length ? { session: candidates[0], via: "folder match" } : null;
  }

  header(t, settings, now) {
    const status = !settings.enabled
      ? "analytics disabled in settings"
      : this.scanning
        ? "scanning session logs…"
        : this.tokensError
          ? "token data unavailable"
          : this.tokens
            ? `${this.paused ? "paused · " : ""}${compact(this.tokens.totals.total)} tokens · scanned ${ago(this.tokens.generatedAt, now)}`
            : "starting…";
    const action = (id, label, active, handler) => h_flex()
      .id(id)
      .h(20)
      .px(7)
      .rounded(4)
      .border(1)
      .border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.surface)
      .items_center()
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_click(handler)
      .child(div().text_size(10.5).text_color(active ? t.accent : t.muted).child(label));
    return h_flex()
      .h(34)
      .w_full()
      .flex_none()
      .items_center()
      .gap(8)
      .px(10)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(div().size(6).rounded_full().flex_none().bg(this.scanning ? t.working : this.tokensError ? t.blocked : t.accent))
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Agents"))
      .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(status))
      .child(div().flex_1())
      .when(settings.enabled, (el) => el
        .child(action(
          "agentee-agents-refresh",
          "Refresh",
          false,
          (_event, cx) => { this.lastScan = 0; this.scan(cx); },
        ))
        .child(action(
          "agentee-agents-pause",
          this.paused ? "Resume" : "Pause",
          this.paused,
          (_event, cx) => { this.paused = !this.paused; if (!this.paused) this.lastScan = 0; cx.notify(); },
        )));
  }

  section(t, title, subtitle = null, right = null) {
    return h_flex()
      .w_full()
      .items_center()
      .gap(6)
      .child(div().text_size(9.5).font_medium().text_color(t.dim).child(String(title).toUpperCase()))
      .when(Boolean(subtitle), (el) => el.child(div().min_w(0).truncate().text_size(9.5).text_color(t.dim).child(subtitle)))
      .child(div().flex_1())
      .when(Boolean(right), (el) => el.child(right));
  }

  card(t, children, padding = 9) {
    return v_flex()
      .w_full()
      .min_w(0)
      .p(padding)
      .gap(7)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .children(children);
  }

  stat(t, label, value, hint, valueColor = null) {
    return v_flex()
      .flex_1()
      .min_w(78)
      .p(7)
      .gap(2)
      .rounded(5)
      .border(1)
      .border_color(t.border)
      .bg(t.raised)
      .when(Boolean(hint), (el) => el.tooltip(hint))
      .child(div().text_size(9).font_medium().text_color(t.dim).child(label.toUpperCase()))
      .child(div().text_size(13.5).font_semibold().text_color(valueColor ?? t.foreground).child(value));
  }

  badge(t, text, color) {
    return div()
      .flex_none()
      .px(4)
      .h(14)
      .rounded(3)
      .bg(color + "1f")
      .flex()
      .items_center()
      .text_size(8.5)
      .font_medium()
      .text_color(color)
      .child(text);
  }

  notice(t, text, color) {
    return h_flex()
      .w_full()
      .gap(6)
      .p(8)
      .rounded(5)
      .border(1)
      .border_color(t.border)
      .bg(t.raised)
      .child(div().size(6).rounded_full().flex_none().bg(color))
      .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.muted).child(text));
  }

  overview(t, counts) {
    return this.card(t, [
      this.section(t, "Overview", `${counts.total} live agent${counts.total === 1 ? "" : "s"}`),
      h_flex().w_full().flex_wrap().gap(6).children([
        this.stat(t, "Total", String(counts.total), "Live agents reported by Herdr"),
        this.stat(t, "Active", String(counts.active), "working + needs you", t.working),
        this.stat(t, "Completed", String(counts.done), "finished while you were not looking", t.done),
        this.stat(t, "Failed", String(counts.failed), "terminals that reported an error", counts.failed ? t.blocked : null),
        this.stat(t, "Idle", String(counts.idle), "waiting for input", t.muted),
      ]),
    ]);
  }

  totalsCard(t, snapshot) {
    const totals = snapshot.totals;
    if (!totals.events) {
      return this.card(t, [
        this.section(t, "Tokens", "measured"),
        this.notice(t, "Token data unavailable: no provider usage records were found in the known session roots.", t.dim),
        this.sourcesLine(t, snapshot),
      ]);
    }
    return this.card(t, [
      this.section(
        t,
        "Tokens",
        "measured · provider usage records",
        this.badge(t, "measured", t.accent),
      ),
      h_flex().w_full().flex_wrap().gap(6).children([
        this.stat(t, "Input", compact(totals.input), `${exact(totals.input)} input tokens`),
        // Claude Code sub-agent transcripts log partial output usage: a floor.
        this.stat(t, "Output", `≥${compact(totals.output)}`, `at least ${exact(totals.output)} output tokens (reasoning included); Claude Code sub-agent transcripts log partial output usage`),
        this.stat(t, "Cached", compact(totals.cacheRead), `${exact(totals.cacheRead)} cache-read tokens (also counted in total)`),
        this.stat(t, "Total", `≥${compact(totals.total)}`, `at least ${exact(totals.total)} input + output + cache tokens`, t.accent),
      ]),
      h_flex().w_full().gap(8).items_center()
        .child(div().min_w(0).text_size(9.5).text_color(t.dim).child([
          `${exact(totals.events)} usage records`,
          `${exact(snapshot.counts.sessions || snapshot.sessions.length)} sessions`,
          snapshot.counts.files ? `${exact(snapshot.counts.files)} log files` : null,
          `cache write ${compact(totals.cacheWrite)}`,
        ].filter(Boolean).join(" · ")))
        .child(div().flex_1())
        .child(this.badge(t, "from transcripts · output is a floor", t.dim)),
      this.sourcesLine(t, snapshot),
      snapshot.scan
        ? div().text_size(9).text_color(t.dim).child([
          `probe: ${exact(snapshot.scan.files)} parsed`,
          `${exact(snapshot.scan.unchanged)} unchanged`,
          snapshot.scan.malformed ? `${exact(snapshot.scan.malformed)} malformed` : null,
          snapshot.scan.errors ? `${exact(snapshot.scan.errors)} errors` : null,
          `opencode ${snapshot.scan.opencode ?? "unknown"}`,
        ].filter(Boolean).join(" · "))
        : null,
    ].filter(Boolean));
  }

  sourcesLine(t, snapshot) {
    const sources = Array.isArray(snapshot.sources) && snapshot.sources.length
      ? snapshot.sources
      : [{ id: "claude", available: false }, { id: "codex", available: false }, { id: "pi", available: false }, { id: "opencode", available: false }];
    return h_flex().w_full().flex_wrap().gap(8).items_center().children(
      sources.map((source) => h_flex()
        .gap(4)
        .items_center()
        .tooltip(source.available
          ? `${source.id}: ${number(source.events)} usage records in ${number(source.files)} file(s)`
          : `${source.id}: no data`)
        .child(div().size(4).rounded_full().flex_none().bg(source.available ? t.accent : t.border))
        .child(div().text_size(9).text_color(source.available ? t.muted : t.dim).child(
          source.available ? `${source.id} ${compact(number(source.events))}` : `${source.id} unavailable`,
        ))),
    );
  }

  chart(t, title, items, step) {
    if (!items.length) {
      return v_flex().gap(3).child(div().text_size(9.5).text_color(t.dim).child(title))
        .child(div().text_size(10).text_color(t.dim).child("unavailable"));
    }
    const max = Math.max(1, ...items.map((item) => item.total));
    const sum = items.reduce((total, item) => total + item.total, 0);
    const bars = h_flex().w_full().h(40).items_end().gap(1).children(
      items.map((item) => v_flex()
        .flex_1()
        .h(40)
        .justify_end()
        .tooltip(`${item.label} · ${exact(item.total)} tokens`)
        .child(div()
          .w_full()
          .h(item.total > 0 ? Math.max(2, Math.round(38 * item.total / max)) : 1)
          .rounded(1)
          .bg(item.total > 0 ? t.accent : t.border))),
    );
    const labels = h_flex().w_full().gap(1).children(
      items.map((item, index) => h_flex()
        .flex_1()
        .justify_center()
        .child(div().text_size(8).text_color(t.dim).child(
          index % step === 0 || index === items.length - 1 ? item.label : "",
        ))),
    );
    return v_flex().w_full().min_w(0).gap(3)
      .child(h_flex().w_full().items_center().gap(6)
        .child(div().text_size(9.5).font_medium().text_color(t.muted).child(title))
        .child(div().flex_1())
        .child(div().text_size(9).text_color(t.dim).child(`max ${compact(max)} · total ${compact(sum)}`)))
      .child(bars)
      .child(labels);
  }

  historyCard(t, snapshot) {
    return this.card(t, [
      this.section(t, "History", "measured · local calendar", this.badge(t, "measured", t.accent)),
      this.chart(t, "Last 24 hours", snapshot.series.hours, 6),
      this.chart(t, "Last 30 days", snapshot.series.days, 5),
      this.chart(t, "Last 12 months", snapshot.series.months, 1),
    ]);
  }

  agentsCard(t, rows, settings, now) {
    const wide = this.width >= 460;
    const header = wide
      ? h_flex().w_full().gap(8).px(4).items_center()
        .child(div().flex_1().text_size(9).text_color(t.dim).child("AGENT"))
        .child(div().w(72).flex_none().text_size(9).text_color(t.dim).child("STATUS"))
        .when(settings.showTokens, (el) => el.child(div().w(74).flex_none().text_size(9).text_color(t.dim).child("TOKENS")))
        .child(div().w(64).flex_none().text_size(9).text_color(t.dim).child("ACTIVITY"))
      : null;
    const row = (entry) => {
      const a = entry.agent;
      const color = statusColor(t, entry.status);
      const detail = [a.space_name, a.tab_name].filter(Boolean).join(" · ");
      const tokenCell = settings.showTokens
        ? entry.session
          ? h_flex().w(74).flex_none().justify_end().items_center().gap(3)
            .child(div().text_size(10.5).text_color(t.foreground).child(compact(entry.session.total)))
            .child(this.badge(t, "est.", t.dim))
          : div().w(74).flex_none().text_size(9).text_color(t.dim).child("unavailable")
        : null;
      const tooltip = [
        `${agentLabel(a)} · ${statusWord(entry.status)}`,
        `space ${a.space_name} · tab ${a.tab_name}`,
        `model ${entry.session?.model ?? "unavailable"}`,
        entry.session
          ? `tokens measured; session matched by ${entry.via}`
          : "no recent session matched this agent",
        entry.session ? `session ${entry.session.id}` : null,
        entry.error ? `error: ${entry.error}` : null,
      ].filter(Boolean).join("\n");
      const main = h_flex().w_full().min_w(0).gap(8).items_center()
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(agentLabel(a)))
          .child(div().min_w(0).truncate().text_size(9).text_color(t.dim).child(detail || "—")))
        .child(h_flex().flex_none().items_center().gap(4).when(wide, (el) => el.w(72))
          .child(div().size(5).rounded_full().flex_none().bg(color))
          .child(div().text_size(10).text_color(color).child(statusWord(entry.status))))
        .when(settings.showTokens, (el) => el.child(tokenCell))
        .child(div().w(64).flex_none().text_size(9).text_color(t.muted).child(ago(entry.activity, now)));
      const sub = h_flex().w_full().flex_wrap().gap(8).items_center().children([
        div().text_size(9).text_color(t.dim).child(
          entry.session ? `session ${duration(now - entry.session.first)}· model ${entry.session.model}` : `model unavailable`,
        ),
        div().text_size(9).text_color(t.dim).child(`started ${entry.session ? ago(entry.session.first, now) : "unavailable"}`),
        entry.error ? div().text_size(9).text_color(t.blocked).child(`error: ${entry.error}`) : null,
      ].filter(Boolean));
      return v_flex()
        .id(`agentee-agent-${a.address}`)
        .w_full()
        .min_w(0)
        .gap(3)
        .p(6)
        .rounded(5)
        .border(1)
        .border_color(t.border)
        .bg(t.raised)
        .hover((style) => style.bg(t.hover))
        .tooltip(tooltip)
        .child(main)
        .child(sub);
    };
    return this.card(t, [
      this.section(
        t,
        "Agents",
        "live · Herdr",
        settings.showTokens ? this.badge(t, "est. mapping", t.dim) : null,
      ),
      ...(header ? [header] : []),
      ...(rows.length
        ? rows.map(row)
        : [this.notice(t, "No live agents. Herdr reports none right now.", t.dim)]),
      settings.showTokens
        ? div().text_size(9).text_color(t.dim).child("Tokens are measured from agent logs; which session belongs to an agent is estimated by folder or session label (est.).")
        : null,
    ].filter(Boolean));
  }

  modelsCard(t, snapshot) {
    const models = snapshot.models.slice(0, 8);
    const max = Math.max(1, ...models.map((model) => model.total));
    return this.card(t, [
      this.section(t, "By model", "measured", this.badge(t, "measured", t.accent)),
      ...(models.length
        ? models.map((model) => v_flex().w_full().min_w(0).gap(3)
          .tooltip(`${model.model} · ${exact(model.total)} tokens · ${exact(model.events)} usage records`)
          .child(h_flex().w_full().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(model.model))
            .child(div().flex_none().text_size(8.5).text_color(t.dim).child(model.harness))
            .child(div().flex_none().text_size(10).text_color(t.muted).child(compact(model.total))))
          .child(div().w_full().h(3).rounded_full().bg(t.border)
            .child(div().h(3).rounded_full().bg(t.accent).w(`${Math.max(1, Math.round(100 * model.total / max))}%`))))
        : [this.notice(t, "Model breakdown unavailable: no usage records.", t.dim)]),
    ]);
  }

  sessionsCard(t, snapshot, now) {
    const sessions = snapshot.sessions.slice(0, 10);
    return this.card(t, [
      this.section(t, "By session", "measured · newest first", this.badge(t, "measured", t.accent)),
      ...(sessions.length
        ? sessions.map((session) => h_flex()
          .w_full()
          .gap(7)
          .items_center()
          .p(5)
          .rounded(4)
          .hover((style) => style.bg(t.hover))
          .tooltip(`${session.id}\n${session.project}\n${exact(session.total)} tokens · ${exact(session.events)} records`)
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(shortPath(session.project)))
            .child(h_flex().gap(5).min_w(0)
              .child(div().flex_none().text_size(8.5).text_color(t.dim).child(session.harness))
              .child(div().min_w(0).truncate().text_size(9).text_color(t.muted).child(session.model))))
          .child(v_flex().flex_none().items_end().gap(1)
            .child(div().text_size(10.5).text_color(t.foreground).child(compact(session.total)))
            .child(div().text_size(8.5).text_color(t.dim).child(ago(session.last, now)))))
        : [this.notice(t, "Session breakdown unavailable: no usage records.", t.dim)]),
      (snapshot.counts.sessions || snapshot.sessions.length) > sessions.length
        ? div().text_size(9).text_color(t.dim).child(`showing ${sessions.length} of ${exact(snapshot.counts.sessions || snapshot.sessions.length)} sessions`)
        : null,
    ].filter(Boolean));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const settings = agentSettings();
    const list = agents();
    const all = terminals();
    const paneByTerminal = new Map(panes().filter((pane) => pane.terminal).map((pane) => [pane.terminal, pane]));
    const tabs = new Map();
    for (const space of spaces()) for (const tab of space.tabs) tabs.set(tab.id, tab);

    const used = new Set();
    const rows = list.map((agent) => {
      const term = all.find((item) => item.address === agent.address) ?? null;
      const pane = paneByTerminal.get(agent.address) ?? null;
      const match = settings.showTokens && this.tokens && !this.tokensError
        ? this.matchSession(agent, term, pane, this.tokens.sessions, used)
        : null;
      if (match) used.add(match.session.id);
      const tab = tabs.get(agent.tab) ?? null;
      const status = term?.status === "error" ? "error" : agent.status;
      const report = term?.report && typeof term.report === "object" ? term.report : null;
      const error = typeof report?.error === "string" && report.error
        ? cleanError(report.error)
        : null;
      return {
        agent,
        status,
        session: match?.session ?? null,
        via: match?.via ?? null,
        activity: match?.session.last ?? tab?.changed_at ?? null,
        error,
      };
    });
    const counts = {
      total: rows.length,
      active: rows.filter((row) => row.status === "working" || row.status === "blocked").length,
      done: rows.filter((row) => row.status === "done").length,
      failed: rows.filter((row) => row.status === "error").length,
      idle: rows.filter((row) => row.status === "idle").length,
    };

    const body = [];
    if (!settings.enabled) {
      body.push(this.notice(t, "Agents analytics are disabled in agentee-settings. The live list stays available; tokens and history are not scanned.", t.dim));
    }
    body.push(this.overview(t, counts));
    if (settings.showTokens && settings.enabled) {
      if (this.tokensError) {
        body.push(this.card(t, [
          this.section(t, "Tokens", "measured"),
          this.notice(t, `Token data unavailable: ${this.tokensError}`, t.blocked),
          this.sourcesLine(t, { sources: [] }),
          h_flex().gap(6).child(div()
            .id("agentee-agents-retry")
            .h(20).px(7).rounded(4).border(1).border_color(t.border).bg(t.surface)
            .flex().items_center().cursor_pointer().hover((style) => style.bg(t.hover))
            .on_click((_event, cx) => this.scan(cx))
            .child(div().text_size(10.5).text_color(t.muted).child("Retry scan"))),
        ]));
      } else if (!this.tokens) {
        body.push(this.card(t, [
          this.section(t, "Tokens", "measured"),
          this.notice(t, this.scanning ? "Scanning provider session logs…" : "No token scan has completed yet.", t.dim),
        ]));
      } else {
        body.push(this.totalsCard(t, this.tokens));
        if (settings.showHistory) body.push(this.historyCard(t, this.tokens));
      }
    }
    body.push(this.agentsCard(t, rows, settings, now));
    if (settings.showTokens && settings.enabled && this.tokens && !this.tokensError) {
      body.push(this.modelsCard(t, this.tokens));
      body.push(this.sessionsCard(t, this.tokens, now));
    }

    return v_flex()
      .id("agentee-agents-root")
      .size_full()
      .min_w(0)
      .bg(t.canvas)
      .text_size(11.5)
      .on_size_change((size, cx) => {
        if (Math.round(size.width) !== Math.round(this.width)) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(this.header(t, settings, now))
      .child(v_flex()
        .flex_1()
        .w_full()
        .min_h(0)
        .overflow_y_scrollbar()
        .p(8)
        .gap(8)
        .children(body));
  }
}

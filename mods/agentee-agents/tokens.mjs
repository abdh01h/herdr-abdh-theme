#!/usr/bin/env node
// Token usage extraction for the agentee-agents panel.
//
// Provenance: this is a compact rewrite of the data extraction in
// `mods/insights/core/scan.mjs` + `mods/insights/core/adapters.mjs`
// (same session roots and the same provider usage fields), narrowed to what
// this panel shows: totals, per model, per session and hour/day/month series.
// The hour/day/month bucketing and compact number formatting follow
// `mods/insights/analytics.js`. It deliberately lives in this folder instead
// of importing another mod.
//
// Sources (all measured: the numbers providers wrote into their own logs):
// - Claude Code: ~/.claude/projects/**/*.jsonl  assistant `message.usage`
// - Codex:       ~/.codex/sessions/**, ~/.codex/archived_sessions/**  token_count
// - Pi:          ~/.pi/agent/sessions/**/*.jsonl  message record `usage`
// - OpenCode:    ~/.local/share/opencode/opencode.db  assistant `tokens`
//
// Incremental: a per-file summary is cached, keyed by size + mtime, and only
// bytes appended since the last run are parsed. Aggregate values are rebuilt
// from those summaries, so a truncated or rewritten file is simply replaced.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_VERSION = 2;
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const HOUR_BUCKETS = 24;
const DAY_BUCKETS = 30;
const MONTH_BUCKETS = 12;
const MAX_SESSIONS = 200;
const MAX_MODELS = 40;

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, events: 0 };
}

function totalOf(tokens) {
  return (tokens.input || 0) + (tokens.output || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0);
}

function add(dst, src) {
  for (const field of FIELDS) dst[field] = (dst[field] || 0) + (src[field] || 0);
  dst.events = (dst.events || 0) + (src.events || 0);
}

function n(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function hourKey(date) {
  return `${dayKey(date)}T${pad(date.getHours())}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function stamp(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function hash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 20);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptySummary(harness) {
  return { harness, sessions: {}, models: {}, hours: {}, days: {}, months: {}, keys: {}, events: 0 };
}

/** Records one provider usage record into a file/source summary. */
function record(summary, { timestamp, session, model, project, tokens, key }) {
  if (!tokens) return false;
  const t = {
    input: n(tokens.input),
    output: n(tokens.output),
    cacheRead: n(tokens.cacheRead),
    cacheWrite: n(tokens.cacheWrite),
  };
  t.reasoning = n(tokens.reasoning);
  if (totalOf(t) <= 0) return false;
  const when = stamp(timestamp);
  if (when === null) return false;
  let events = 1;
  if (key) {
    const seen = summary.keys[key];
    if (seen) {
      // Claude Code writes one line per content block; a later line of the same
      // message can carry the larger, final output count. Add only the growth.
      if (!Array.isArray(seen) || t.output <= seen[0]) return false;
      const grown = { input: 0, output: t.output - seen[0], cacheRead: 0, cacheWrite: 0, reasoning: Math.max(0, t.reasoning - seen[1]) };
      summary.keys[key] = [t.output, Math.max(seen[1], t.reasoning)];
      Object.assign(t, grown);
      events = 0;
    } else {
      summary.keys[key] = [t.output, t.reasoning];
    }
  }
  const date = new Date(when);
  const label = model && model !== "unknown" ? String(model) : "unknown";
  const sessionId = session || `${summary.harness}:unknown`;
  let entry = summary.sessions[sessionId];
  if (!entry) {
    entry = {
      id: sessionId,
      harness: summary.harness,
      project: project || "unknown",
      model: label,
      first: when,
      last: when,
      tokens: zero(),
    };
    summary.sessions[sessionId] = entry;
  }
  entry.first = Math.min(entry.first, when);
  entry.last = Math.max(entry.last, when);
  entry.model = label;
  if (project && project !== "unknown") entry.project = project;
  add(entry.tokens, { ...t, events });

  let modelEntry = summary.models[label];
  if (!modelEntry) modelEntry = summary.models[label] = zero();
  add(modelEntry, { ...t, events });

  const hk = hourKey(date), dk = dayKey(date), mk = monthKey(date);
  summary.hours[hk] = (summary.hours[hk] || 0) + totalOf(t);
  summary.days[dk] = (summary.days[dk] || 0) + totalOf(t);
  summary.months[mk] = (summary.months[mk] || 0) + totalOf(t);
  summary.events += events;
  return true;
}

// ---------------------------------------------------------------------------
// Per-harness line parsers

function claudeCacheWrite(usage) {
  if (Number.isFinite(usage.cache_creation_input_tokens)) return n(usage.cache_creation_input_tokens);
  if (isObject(usage.cache_creation)) {
    let sum = 0;
    for (const value of Object.values(usage.cache_creation)) if (Number.isFinite(value) && value > 0) sum += value;
    return sum;
  }
  return 0;
}

function parseClaudeLine(recordLine, summary) {
  if (recordLine.type !== "assistant" || !isObject(recordLine.message)) return false;
  const message = recordLine.message;
  const usage = isObject(message.usage) ? message.usage : null;
  if (!usage) return false;
  const timestamp = recordLine.timestamp;
  if (!stamp(timestamp)) return false;
  const session = recordLine.sessionId || recordLine.session_id || null;
  const identity = message.id || recordLine.uuid || `${session}:${timestamp}:${message.model}`;
  return record(summary, {
    timestamp,
    session: session ? `claude:${session}` : null,
    model: message.model,
    project: recordLine.cwd,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: claudeCacheWrite(usage),
      reasoning: isObject(usage.output_tokens_details) ? usage.output_tokens_details.thinking_tokens : 0,
    },
    key: hash(`claude|${identity}`),
  });
}

function codexVector(raw) {
  if (!isObject(raw)) return null;
  const cached = n(raw.cached_input_tokens);
  const cacheWrite = n(raw.cache_write_input_tokens);
  return {
    input: Math.max(0, n(raw.input_tokens) - cached - cacheWrite),
    output: n(raw.output_tokens),
    cacheRead: cached,
    cacheWrite,
    reasoning: n(raw.reasoning_output_tokens),
  };
}

function parseCodexLine(recordLine, summary, state) {
  const payload = isObject(recordLine.payload) ? recordLine.payload : {};
  const timestamp = recordLine.timestamp || state.timestamp;
  if (recordLine.type === "session_meta") {
    const nextSession = payload.id || payload.session_id || state.session;
    if (nextSession && nextSession !== state.session) state.codexTotals = null;
    state.session = nextSession;
    state.project = payload.cwd || state.project;
    state.timestamp = timestamp || state.timestamp;
    return false;
  }
  if (recordLine.type === "turn_context") {
    state.model = payload.model || state.model;
    state.project = payload.cwd || state.project;
    return false;
  }
  if (recordLine.type === "token_usage_record") {
    // Modern payload: the usage of one response, sometimes repeated as a twin.
    const usage = codexVector(payload.usage);
    if (!usage) return false;
    const responseId = payload.response_id || `${state.session}:${timestamp}:${totalOf(usage)}`;
    return record(summary, {
      timestamp,
      session: state.session ? `codex:${state.session}` : null,
      model: state.model,
      project: state.project,
      tokens: usage,
      key: hash(`codex|${responseId}`),
    });
  }
  const eventPayload = isObject(recordLine.payload) ? recordLine.payload : null;
  if (!eventPayload || eventPayload.type !== "token_count") return false;
  const info = isObject(eventPayload.info) ? eventPayload.info : null;
  if (!info) return false;
  const last = codexVector(info.last_token_usage);
  const cumulative = codexVector(info.total_token_usage);
  // Prefer the cumulative counter: the delta since the previous event is the
  // real usage of this turn, and a repeated counter adds nothing.
  if (cumulative) {
    const prev = state.codexTotals || null;
    const rawInput = cumulative.input + cumulative.cacheRead + cumulative.cacheWrite;
    const prevRaw = prev ? prev.input + prev.cacheRead + prev.cacheWrite : 0;
    const dCacheRead = prev ? Math.max(0, cumulative.cacheRead - prev.cacheRead) : cumulative.cacheRead;
    const dCacheWrite = prev ? Math.max(0, cumulative.cacheWrite - prev.cacheWrite) : cumulative.cacheWrite;
    const delta = {
      // total_token_usage counts cached input inside input; keep the fields disjoint.
      input: Math.max(0, rawInput - prevRaw - dCacheRead - dCacheWrite),
      output: prev ? Math.max(0, cumulative.output - prev.output) : cumulative.output,
      cacheRead: dCacheRead,
      cacheWrite: dCacheWrite,
      reasoning: prev ? Math.max(0, cumulative.reasoning - prev.reasoning) : cumulative.reasoning,
    };
    state.codexTotals = {
      input: cumulative.input,
      output: cumulative.output,
      cacheRead: cumulative.cacheRead,
      cacheWrite: cumulative.cacheWrite,
      reasoning: cumulative.reasoning,
    };
    if (totalOf(delta) > 0) {
      record(summary, {
        timestamp,
        session: state.session ? `codex:${state.session}` : null,
        model: state.model,
        project: state.project,
        tokens: delta,
        key: hash(`codex-cum|${state.session}|${timestamp}|${cumulative.input}|${cumulative.output}|${cumulative.cacheRead}`),
      });
    }
    return true;
  }
  if (!last) return false;
  return record(summary, {
    timestamp,
    session: state.session ? `codex:${state.session}` : null,
    model: state.model,
    project: state.project,
    tokens: last,
    key: hash(`codex-last|${state.session}|${timestamp}|${totalOf(last)}|${last.input}|${last.output}`),
  });
}

function parsePiLine(recordLine, summary, state) {
  if (recordLine.type === "session") {
    state.session = recordLine.id || recordLine.sessionId || state.session;
    state.project = recordLine.cwd || state.project;
    state.timestamp = recordLine.timestamp || state.timestamp;
    return false;
  }
  const usage = isObject(recordLine.usage) ? recordLine.usage : null;
  if (!usage) return false;
  const timestamp = recordLine.timestamp || state.timestamp;
  const identity = recordLine.id || `${state.session}:${timestamp}`;
  return record(summary, {
    timestamp,
    session: state.session ? `pi:${state.session}` : null,
    model: recordLine.model,
    project: state.project,
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens,
      cacheWrite: usage.cacheWrite ?? usage.cache_write_input_tokens,
      reasoning: usage.reasoning,
    },
    key: hash(`pi|${identity}|${timestamp}`),
  });
}

// ---------------------------------------------------------------------------
// File walking

async function walk(root, predicate, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(full, predicate, out, depth + 1);
    } else if (entry.isFile() && predicate(entry.name)) {
      out.push(full);
    }
  }
}

async function statOrNull(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

/** Parses the bytes appended to a JSONL file since `offset`. */
async function readNewLines(file, offset, onLine) {
  const stream = createReadStream(file, { start: offset });
  let buffered = Buffer.alloc(0);
  let consumed = 0;
  try {
    for await (const chunk of stream) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      let index;
      while ((index = buffered.indexOf(10)) !== -1) {
        const line = buffered.subarray(0, index).toString("utf8").replace(/\r$/, "");
        consumed += index + 1;
        buffered = buffered.subarray(index + 1);
        if (line.trim()) onLine(line);
      }
    }
  } finally {
    stream.destroy();
  }
  return consumed;
}

// ---------------------------------------------------------------------------
// Claude / Codex / Pi files

const LINE_PARSERS = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  pi: parsePiLine,
};

async function scanJsonl(harness, file, cache, stats) {
  const info = await statOrNull(file);
  if (!info || !info.isFile()) return null;
  const previous = cache.files[file];
  const unchanged = previous
    && previous.harness === harness
    && previous.size === info.size
    && previous.mtimeMs === info.mtimeMs;
  if (unchanged) {
    stats.unchanged += 1;
    return previous;
  }
  let summary;
  let offset = 0;
  if (previous && previous.harness === harness && previous.offset <= info.size && info.size >= previous.size) {
    summary = previous.summary;
    offset = previous.offset;
  } else {
    summary = emptySummary(harness);
  }
  const state = {
    session: summary.lastSession || null,
    project: summary.lastProject || null,
    model: summary.lastModel || null,
    timestamp: summary.lastTimestamp || null,
    codexTotals: summary.codexTotals || null,
  };
  const parse = LINE_PARSERS[harness];
  try {
    const consumed = await readNewLines(file, offset, (line) => {
      let recordLine;
      try {
        recordLine = JSON.parse(line);
      } catch {
        stats.malformed += 1;
        return;
      }
      if (!isObject(recordLine)) return;
      try {
        parse(recordLine, summary, state);
      } catch {
        stats.malformed += 1;
      }
    });
    // Persist parser state so an appended file keeps its session/thread context.
    summary.lastSession = state.session || null;
    summary.lastProject = state.project || null;
    summary.lastModel = state.model || null;
    summary.lastTimestamp = state.timestamp || null;
    summary.codexTotals = state.codexTotals || null;
    cache.files[file] = {
      harness,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: offset + consumed,
      summary,
    };
    stats.files += 1;
    return cache.files[file];
  } catch {
    stats.errors += 1;
    return previous || null;
  }
}

// ---------------------------------------------------------------------------
// OpenCode database

async function scanOpenCode(file, cache, stats) {
  const info = await statOrNull(file);
  if (!info || !info.isFile()) return null;
  let wal = null;
  try {
    wal = await stat(`${file}-wal`);
  } catch { /* no WAL */ }
  const fingerprint = `${info.mtimeMs}:${info.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
  if (cache.opencode && cache.opencode.fingerprint === fingerprint) {
    stats.unchanged += 1;
    return cache.opencode;
  }
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    stats.opencodeUnsupported = true;
    return null;
  }
  const summary = emptySummary("opencode");
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
    );
    const table = tables.has("session_message") ? "session_message" : tables.has("message") ? "message" : null;
    if (!table) return null;
    const projectOf = new Map();
    if (tables.has("session_v2")) {
      for (const row of db.prepare("SELECT id, directory FROM session_v2").all()) {
        projectOf.set(row.id, row.directory);
      }
    }
    const rows = db.prepare(`SELECT session_id, type, time_created, data FROM ${table}`).all();
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        stats.malformed += 1;
        continue;
      }
      const role = data?.role ?? row.type;
      if (!isObject(data) || role !== "assistant" || !isObject(data.tokens)) continue;
      const created = n(data.time?.created) || n(row.time_created);
      if (!created) continue;
      const tokens = {
        input: data.tokens.input,
        output: data.tokens.output,
        cacheRead: data.tokens.cache?.read,
        cacheWrite: data.tokens.cache?.write,
        reasoning: data.tokens.reasoning,
      };
      if (totalOf({ input: n(tokens.input), output: n(tokens.output), cacheRead: n(tokens.cacheRead), cacheWrite: n(tokens.cacheWrite) }) <= 0) continue;
      const session = String(row.session_id || "unknown");
      record(summary, {
        timestamp: created,
        session: `opencode:${session}`,
        model: data.model?.id || data.model?.modelID || data.modelID,
        project: projectOf.get(session),
        tokens,
        key: null,
      });
    }
    cache.opencode = { fingerprint, summary };
    stats.files += 1;
    return cache.opencode;
  } catch {
    stats.errors += 1;
    return cache.opencode || null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Aggregate

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, events: 0 };
}

function addTotals(target, tokens) {
  target.input += tokens.input || 0;
  target.output += tokens.output || 0;
  target.cacheRead += tokens.cacheRead || 0;
  target.cacheWrite += tokens.cacheWrite || 0;
  target.reasoning += tokens.reasoning || 0;
  target.events += tokens.events || 0;
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite;
}

function seriesFrom(map, keys, labels) {
  return keys.map((key, index) => ({ key, label: labels(key, index), total: map[key] || 0 }));
}

function buildSeries(summaries, now) {
  const hours = {}, days = {}, months = {};
  for (const summary of summaries) {
    for (const [key, value] of Object.entries(summary.hours || {})) hours[key] = (hours[key] || 0) + value;
    for (const [key, value] of Object.entries(summary.days || {})) days[key] = (days[key] || 0) + value;
    for (const [key, value] of Object.entries(summary.months || {})) months[key] = (months[key] || 0) + value;
  }
  const hourKeys = [];
  for (let i = HOUR_BUCKETS - 1; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() - i);
    hourKeys.push(hourKey(date));
  }
  const dayKeys = [], dayDates = [];
  for (let i = DAY_BUCKETS - 1; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    dayDates.push(date);
    dayKeys.push(dayKey(date));
  }
  const monthKeys = [];
  for (let i = MONTH_BUCKETS - 1; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setDate(1);
    date.setMonth(date.getMonth() - i);
    monthKeys.push(monthKey(date));
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    hours: seriesFrom(hours, hourKeys, (key) => key.slice(11, 13) + ":00"),
    days: seriesFrom(days, dayKeys, (key, index) => `${dayDates[index].getDate()}`),
    months: seriesFrom(months, monthKeys, (key) => MONTHS[Number(key.slice(5, 7)) - 1] || key),
  };
}

function build(cache, now) {
  const summaries = [];
  const sources = [];
  const byHarness = new Map();
  for (const entry of Object.values(cache.files || {})) {
    if (!entry?.summary) continue;
    summaries.push(entry.summary);
    const statEntry = byHarness.get(entry.harness) || { harness: entry.harness, files: 0, events: 0 };
    statEntry.files += 1;
    statEntry.events += entry.summary.events || 0;
    byHarness.set(entry.harness, statEntry);
  }
  if (cache.opencode?.summary) {
    summaries.push(cache.opencode.summary);
    byHarness.set("opencode", {
      harness: "opencode",
      files: 1,
      events: cache.opencode.summary.events || 0,
    });
  }
  const totals = emptyTotals();
  const models = new Map();
  const sessionsById = new Map();
  for (const summary of summaries) {
    for (const entry of Object.values(summary.sessions || {})) {
      addTotals(totals, entry.tokens);
      // One Claude session can continue in another folder, so the same id may
      // appear in several file summaries; tokens add up, identity does not.
      const key = `${entry.harness}|${entry.id}`;
      const existing = sessionsById.get(key);
      if (!existing) {
        sessionsById.set(key, {
          ...entry,
          tokens: { ...entry.tokens, total: totalOf(entry.tokens) },
        });
        continue;
      }
      for (const field of FIELDS) existing.tokens[field] = (existing.tokens[field] || 0) + (entry.tokens[field] || 0);
      existing.tokens.events = (existing.tokens.events || 0) + (entry.tokens.events || 0);
      existing.tokens.total = totalOf(existing.tokens);
      existing.first = Math.min(existing.first, entry.first);
      if (entry.last >= existing.last) {
        existing.last = entry.last;
        existing.project = entry.project;
        existing.model = entry.model;
      }
    }
    for (const [model, tokens] of Object.entries(summary.models || {})) {
      let row = models.get(model);
      if (!row) row = models.set(model, { model, harness: summary.harness, ...emptyTotals() }).get(model);
      addTotals(row, tokens);
    }
  }
  for (const [harness, stat] of byHarness) {
    sources.push({
      id: harness,
      available: stat.events > 0,
      files: stat.files,
      events: stat.events,
    });
  }
  const sessions = [...sessionsById.values()];
  sessions.sort((a, b) => b.last - a.last);
  const series = buildSeries(summaries, now);
  return {
    generatedAt: now,
    measured: true,
    totals,
    models: [...models.values()]
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, MAX_MODELS),
    sessions: sessions.slice(0, MAX_SESSIONS),
    counts: { sessions: sessions.length, events: totals.events, files: summaries.length },
    series,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Main

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function loadCache(file) {
  try {
    const text = await readFile(file, "utf8");
    const cache = JSON.parse(text);
    if (!isObject(cache) || cache.version !== CACHE_VERSION) return { cache: null, ignored: true };
    cache.files = isObject(cache.files) ? cache.files : {};
    return { cache, ignored: false };
  } catch {
    return { cache: null, ignored: false };
  }
}

async function saveCache(file, cache) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(cache));
  await rename(temp, file).catch(async (error) => {
    await unlink(temp).catch(() => {});
    throw error;
  });
}

async function main() {
  const home = arg("home", process.env.USERPROFILE || process.env.HOME || ".");
  const cacheFile = arg("cache", null);
  const now = Date.now();
  const loaded = cacheFile ? await loadCache(cacheFile) : { cache: null };
  const cache = loaded.cache || { version: CACHE_VERSION, files: {}, opencode: null };
  cache.version = CACHE_VERSION;
  const stats = { files: 0, unchanged: 0, malformed: 0, errors: 0, opencodeUnsupported: false };

  const claudeFiles = [];
  await walk(path.join(home, ".claude", "projects"), (name) => name.endsWith(".jsonl"), claudeFiles);
  const codexFiles = [];
  await walk(path.join(home, ".codex", "sessions"), (name) => name.endsWith(".jsonl"), codexFiles);
  await walk(path.join(home, ".codex", "archived_sessions"), (name) => name.endsWith(".jsonl"), codexFiles);
  const piFiles = [];
  await walk(path.join(home, ".pi", "agent", "sessions"), (name) => name.endsWith(".jsonl"), piFiles);

  for (const file of claudeFiles) await scanJsonl("claude", file, cache, stats);
  for (const file of codexFiles) await scanJsonl("codex", file, cache, stats);
  for (const file of piFiles) await scanJsonl("pi", file, cache, stats);
  const opencode = await scanOpenCode(path.join(home, ".local", "share", "opencode", "opencode.db"), cache, stats);

  // Drop summaries for files that vanished, so deleted logs stop counting.
  const known = new Set([...claudeFiles, ...codexFiles, ...piFiles]);
  let removed = 0;
  for (const file of Object.keys(cache.files)) {
    if (known.has(file)) continue;
    delete cache.files[file];
    removed += 1;
  }

  const snapshot = build(cache, now);
  snapshot.scan = {
    at: now,
    files: stats.files,
    unchanged: stats.unchanged,
    malformed: stats.malformed,
    errors: stats.errors,
    opencode: opencode ? "read" : stats.opencodeUnsupported ? "unsupported" : "absent",
    roots: {
      claude: path.join(home, ".claude", "projects"),
      codex: path.join(home, ".codex", "sessions"),
      pi: path.join(home, ".pi", "agent", "sessions"),
      opencode: path.join(home, ".local", "share", "opencode", "opencode.db"),
    },
  };
  if (cacheFile && (stats.files > 0 || removed > 0)) {
    try {
      await saveCache(cacheFile, cache);
    } catch (error) {
      snapshot.cacheError = String(error?.message || error);
    }
  }
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

await main();

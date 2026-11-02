// Pure parsing for the git output abdh-git reads, with no herdr imports so it
// stays testable with node.
//
// `parseStatus` follows Herdr's shipped `changes` mod's status reader
// (Apache-2.0); `ago` follows the same mod. The blame field order is git's
// `--line-porcelain` documentation, verified against git 2.55.
//
// Reads are prefixed so they write nothing under .git: no index refresh, no
// lock, no fsmonitor cookie.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// refname, short name, commit time, upstream, upstream track, subject.
export const REF_FORMAT = "%(refname)%00%(refname:short)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track)%00%(subject)";

// `git status --porcelain=v2 --branch -z`: header lines, then one entry per
// path. `counts` is null-safe: callers get zeroes only when status succeeded.
export function parseStatus(text) {
  const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0, detached: false };
  const entries = [];
  for (const entry of (text ?? "").split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const at = entry.indexOf(" ", 2);
      const field = entry.slice(2, at < 0 ? undefined : at);
      const value = at < 0 ? "" : entry.slice(at + 1);
      if (field === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (field === "branch.head") {
        branch.detached = value === "(detached)";
        branch.head = branch.detached ? null : value;
      } else if (field === "branch.upstream") branch.upstream = value;
      else if (field === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = entry[0];
    if (kind === "?") {
      entries.push({ path: entry.slice(2), staged: false, unstaged: true, untracked: true, conflict: false });
      continue;
    }
    if (kind === "u") {
      const parts = entry.split(" ");
      entries.push({ path: parts.slice(10).join(" "), staged: true, unstaged: true, untracked: false, conflict: true });
      continue;
    }
    if (kind !== "1" && kind !== "2") continue;
    const parts = entry.split(" ");
    const path = parts.slice(kind === "1" ? 8 : 9).join(" ");
    const xy = parts[1] ?? "..";
    // A rename would need its original path (kind 2); READ asks for --no-renames,
    // so a stray kind 2 is reported by its new path alone.
    entries.push({ path, staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, conflict: false });
  }
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const entry of entries) {
    if (entry.conflict) counts.conflicts++;
    else if (entry.untracked) counts.untracked++;
    else {
      if (entry.staged) counts.staged++;
      if (entry.unstaged) counts.unstaged++;
    }
  }
  return { branch, entries, counts };
}

// `%(upstream:track)`: "[ahead 2, behind 1]", "[gone]", or "" without an upstream.
// null means git did not say (no upstream, or the ref has none).
function parseTrack(text) {
  const s = text ?? "";
  const ahead = /ahead (\d+)/.exec(s);
  const behind = /behind (\d+)/.exec(s);
  return {
    ahead: ahead ? Number(ahead[1]) : null,
    behind: behind ? Number(behind[1]) : null,
    gone: s.includes("gone"),
  };
}

// One record per line from REF_FORMAT. Remote HEAD aliases are dropped.
export function parseBranches(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    const [ref, short, at, upstream, track, subject] = line.split("\0");
    if (!ref) continue;
    let kind;
    if (ref.startsWith("refs/heads/")) kind = "local";
    else if (ref.startsWith("refs/remotes/")) {
      if (ref.endsWith("/HEAD")) continue;
      kind = "remote";
    } else continue;
    out.push({
      kind,
      name: short || ref,
      ref,
      at: Number(at) || 0,
      upstream: upstream || null,
      track: parseTrack(track),
      subject: subject ?? "",
    });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Short relative time, as the Changes panel shows it.
export function ago(seconds, now = Date.now()) {
  if (!seconds) return "\u2014";
  const s = now / 1000 - seconds;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  const d = new Date(seconds * 1000);
  return d.getFullYear() === new Date(now).getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// `git blame --line-porcelain -L n,n -- file`. The first header line is
// "<hash> <orig-line> <final-line> <count>"; an all-zero hash is a line that is
// not committed yet (git then writes "Not Committed Yet").
export function parseBlame(text) {
  const lines = (text ?? "").split("\n");
  const head = (lines[0] ?? "").split(" ");
  const hash = head[0] ?? "";
  const out = { hash, short: hash.slice(0, 7), author: "", time: null, summary: "", committed: false };
  for (const line of lines.slice(1)) {
    if (line === "" || line.startsWith("\t")) break;
    if (line.startsWith("author ")) out.author = line.slice(7);
    else if (line.startsWith("author-time ")) out.time = Number(line.slice(12)) || null;
    else if (line.startsWith("summary ")) out.summary = line.slice(8);
  }
  out.committed = Boolean(hash) && !/^0+$/.test(hash) && out.time !== null;
  return out;
}

// The local name a remote branch checks out as: origin/topic -> topic.
function localNameOf(remote) {
  const at = remote.indexOf("/");
  return at < 0 ? remote : remote.slice(at + 1);
}

// The ref a selection acts on: a local branch by name; a remote branch by its
// full short ref (origin/topic) unless a same-named local branch exists.
export function targetOf(selection, branches) {
  if (!selection) return null;
  if (selection.kind === "local") return { ref: selection.name, track: false };
  const local = localNameOf(selection.name);
  if (branches.some((b) => b.kind === "local" && b.name === local)) return { ref: local, track: false };
  return { ref: selection.name, track: true };
}

// Whole-file `git blame --line-porcelain`: one entry per line.
export function parseFileBlame(text) {
  const out = [];
  let cur = null;
  for (const line of (text ?? "").split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (head) {
      cur = { hash: head[1], short: head[1].slice(0, 7), line: Number(head[2]), author: "", time: null, summary: "", text: "" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\t")) {
      cur.text = line.slice(1);
      if (/^0+$/.test(cur.hash)) { cur.author = "Not committed"; cur.time = null; cur.summary = "uncommitted change"; }
      out.push(cur);
      cur = null;
    } else if (line.startsWith("author ")) cur.author = line.slice(7);
    else if (line.startsWith("author-time ")) cur.time = Number(line.slice(12)) || null;
    else if (line.startsWith("summary ")) cur.summary = line.slice(8);
  }
  return out;
}

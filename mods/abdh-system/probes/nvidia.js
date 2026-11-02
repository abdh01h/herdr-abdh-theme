// NVIDIA GPU metrics through nvidia-smi (Windows and Linux). Every field comes
// from the tool's own CSV output; a missing tool or a failed query returns null
// and the view renders "unavailable" for those fields. `run` is the host's exec
// function, passed in so this module stays testable without Herdr.

import { megabytes, num } from "../format.js";

const FIELDS = [
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "clocks.current.graphics",
  "utilization.memory",
].join(",");

export function parseNvidia(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(",").map((s) => s.trim());
    if (!parts[0]) continue;
    rows.push({
      name: parts[0],
      usage: num(parts[1]),
      memUsed: megabytes(parts[2]),
      memTotal: megabytes(parts[3]),
      memUtil: num(parts[6]),
      tempC: num(parts[4]),
      mhz: num(parts[5]),
      vendor: "NVIDIA",
    });
  }
  return rows;
}

/**
 * Queries every NVIDIA GPU. `state` caches "the tool is missing" for five
 * minutes so a machine without it is not probed on every sample.
 */
export async function readNvidia(run, state, now = Date.now()) {
  const cache = state.nvidia || (state.nvidia = {});
  if (cache.missing && now - (cache.checkedAt || 0) < 300000) return null;
  cache.checkedAt = now;
  try {
    const result = await run("nvidia-smi", [
      `--query-gpu=${FIELDS}`,
      "--format=csv,noheader,nounits",
    ]);
    if (!result || result.code !== 0) {
      cache.missing = true;
      return null;
    }
    cache.missing = false;
    return parseNvidia(result.stdout);
  } catch {
    cache.missing = true;
    return null;
  }
}

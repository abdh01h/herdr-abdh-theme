// macOS probes. Static identity (OS, CPU, displays) is cached for five
// minutes; the sample reads vm_stat, df, netstat and one `top` interval for
// CPU. `top -l 2 -s 1` is the only non-root way to get a true system CPU
// sample, so it costs about a second per sample on this platform.
//
// Field sources:
//   CPU usage              top -l 2 -stats pid,cpu ("CPU usage: ... idle")
//   CPU model, cores       sysctl machdep.cpu.brand_string / hw.physicalcpu / hw.logicalcpu
//   CPU temperature        unavailable without root (powermetrics)
//   RAM, swap              vm_stat + sysctl vm.swapusage
//   Storage                df -Pk (activity unavailable)
//   GPU                    system_profiler SPDisplaysDataType (model only)
//   Network                netstat -ibn <Link#> byte deltas
//   OS, uptime, battery    sw_vers, sysctl kern.boottime, pmset -g batt

import { num, sizeText, vendorName } from "../format.js";

export const MACOS_STATIC_SCRIPT = String.raw`
echo '@@sys'
sw_vers 2>/dev/null
printf 'machine|%s\n' "$(uname -m 2>/dev/null)"
printf 'hostname|%s\n' "$(hostname 2>/dev/null)"
printf 'boot|%s\n' "$(sysctl -n kern.boottime 2>/dev/null)"
printf 'brand|%s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
printf 'physical|%s\n' "$(sysctl -n hw.physicalcpu 2>/dev/null)"
printf 'logical|%s\n' "$(sysctl -n hw.logicalcpu 2>/dev/null)"
printf 'mem|%s\n' "$(sysctl -n hw.memsize 2>/dev/null)"
echo '@@gpu'
system_profiler SPDisplaysDataType 2>/dev/null
`;

export const MACOS_SAMPLE_SCRIPT = String.raw`
echo '@@vm'
vm_stat 2>/dev/null
printf 'swap|%s\n' "$(sysctl -n vm.swapusage 2>/dev/null)"
echo '@@df'
df -Pk 2>/dev/null
echo '@@net'
netstat -ibn 2>/dev/null
echo '@@top'
top -l 2 -n 0 -s 1 -stats pid,cpu 2>/dev/null | grep 'CPU usage'
echo '@@batt'
pmset -g batt 2>/dev/null
`;

function sections(stdout) {
  const out = {};
  let key = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const marker = /^@@([a-z]+)$/.exec(line);
    if (marker) {
      key = marker[1];
      out[key] = [];
      continue;
    }
    if (key) out[key].push(line);
  }
  return out;
}

function nonEmpty(lines) {
  return (lines || []).map((line) => line.trim()).filter(Boolean);
}

function kv(lines) {
  const values = {};
  for (const line of lines || []) {
    const index = line.indexOf("|");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function readPageSize(lines) {
  for (const line of lines || []) {
    const match = /page size of (\d+) bytes/.exec(line);
    if (match) return Number(match[1]);
  }
  return 4096;
}

function readVm(lines) {
  const pageSize = readPageSize(lines);
  const pages = {};
  for (const line of lines || []) {
    const match = /^([^:]+):\s+(\d+)\.?$/.exec(line.trim());
    if (match) pages[match[1].trim()] = Number(match[2]);
  }
  const get = (key) => pages[key] ?? 0;
  const active = get("Pages active");
  const wired = get("Pages wired down");
  const compressor = get("Pages occupied by compressor");
  const free = get("Pages free");
  const inactive = get("Pages inactive");
  const speculative = get("Pages speculative");
  const used = (active + wired + compressor) * pageSize;
  const available = (free + inactive + speculative) * pageSize;
  return { pageSize, used, available, free: free * pageSize };
}

function readSwap(text) {
  const match = /total = ([\d.]+\w?)\s+used = ([\d.]+\w?)\s+free = ([\d.]+\w?)/.exec(String(text || ""));
  if (!match) return { total: null, used: null };
  return { total: sizeText(match[1]), used: sizeText(match[2]) };
}

function readDisks(lines) {
  const disks = [];
  const seen = new Set();
  const skip = /^(devfs|map|autofs)/i;
  for (const line of lines || []) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const source = match[1];
    const mount = match[6];
    if (skip.test(source)) continue;
    if (!source.startsWith("/dev/") && mount !== "/") continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    const total = Number(match[2]) * 1024;
    const used = Number(match[3]) * 1024;
    const free = Number(match[4]) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    disks.push({
      id: source,
      name: mount,
      mount,
      device: source,
      format: null,
      total,
      used,
      free,
      percent: Number(match[5]),
      readBps: null,
      writeBps: null,
      source: "df -Pk",
    });
  }
  return disks;
}

function readNet(lines, previous, elapsedMs) {
  const next = {};
  let totalDown = 0;
  let totalUp = 0;
  for (const line of lines || []) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const name = fields[0];
    if (!fields[2] || !fields[2].startsWith("<Link")) continue;
    if (!/^(en|utun|bridge|wl|pdp_ip|ipsec)/.test(name)) continue;
    const rx = Number(fields[6]) || 0;
    const tx = Number(fields[9]) || 0;
    next[name] = { rx, tx };
    totalDown += rx;
    totalUp += tx;
  }
  let down = null;
  let up = null;
  if (previous && elapsedMs > 0) {
    let deltaDown = 0;
    let deltaUp = 0;
    let counted = 0;
    for (const [name, value] of Object.entries(next)) {
      const prev = previous[name];
      if (!prev) continue;
      if (value.rx < prev.rx || value.tx < prev.tx) continue;
      deltaDown += value.rx - prev.rx;
      deltaUp += value.tx - prev.tx;
      counted += 1;
    }
    if (counted > 0) {
      down = (deltaDown * 1000) / elapsedMs;
      up = (deltaUp * 1000) / elapsedMs;
    }
  }
  return { next, totalDown, totalUp, down, up };
}

function readTop(lines) {
  const rows = nonEmpty(lines).filter((line) => line.includes("CPU usage:"));
  const line = rows[rows.length - 1];
  if (!line) return null;
  const idle = /([\d.]+)%\s*idle/.exec(line);
  if (idle) return Math.max(0, 100 - Number(idle[1]));
  const total = /CPU usage:\s*([\d.]+)%/.exec(line);
  return total ? Number(total[1]) : null;
}

function readDisplays(lines) {
  const gpus = [];
  let current = null;
  for (const raw of lines || []) {
    const line = raw.replace(/\t/g, "    ");
    const header = /^ {4}(\S.*):\s*$/.exec(line);
    if (header && !/^(Displays|Graphics\/Displays)$/i.test(header[1])) {
      current = { name: header[1].trim(), vendor: null, memTotal: null, usage: null, memUsed: null, tempC: null, mhz: null };
      gpus.push(current);
      continue;
    }
    if (!current) continue;
    const chipset = /^\s+Chipset Model:\s*(.+)$/.exec(line);
    if (chipset) {
      current.name = chipset[1].trim();
      current.vendor = vendorName(chipset[1]);
      continue;
    }
    const vendor = /^\s+Vendor:\s*(.+)$/.exec(line);
    if (vendor) {
      current.vendor = vendorName(vendor[1], current.vendor || "GPU");
      continue;
    }
    const cores = /^\s+Total Number of Cores:\s*(\d+)/.exec(line);
    if (cores) {
      current.cores = Number(cores[1]);
      continue;
    }
    const vram = /^\s+VRAM.*:\s*(.+)$/.exec(line);
    if (vram) {
      current.memTotal = sizeText(vram[1]);
      continue;
    }
  }
  return gpus.map((gpu) => ({
    id: `mac:${gpu.name}`,
    name: gpu.name,
    vendor: gpu.vendor || vendorName(gpu.name),
    usage: gpu.usage,
    memUsed: gpu.memUsed,
    memTotal: gpu.memTotal,
    tempC: gpu.tempC,
    mhz: gpu.mhz,
    cores: gpu.cores ?? null,
    source: "system_profiler SPDisplaysDataType",
  }));
}

function readBattery(text) {
  const body = String(text || "");
  const percent = /(\d+)%/.exec(body);
  if (!percent) return null;
  return {
    percent: Number(percent[1]),
    charging: /charging|charged|AC Power/i.test(body) && !/discharging/i.test(body),
  };
}

async function runShell(run, script) {
  const result = await run("sh", ["-c", script]);
  if (!result || result.code !== 0) {
    throw new Error((result && result.stderr && result.stderr.trim()) || "macOS probe failed");
  }
  return sections(result.stdout);
}

export async function collectMacos(state, options = {}, run) {
  const st = state.macos || (state.macos = {});
  const now = Date.now();
  const sampleTask = runShell(run, MACOS_SAMPLE_SCRIPT);
  let staticTask;
  if (!st.static || now - (st.staticAt || 0) > 300000) {
    st.staticAt = now;
    staticTask = runShell(run, MACOS_STATIC_SCRIPT)
      .then((value) => {
        if (value) st.static = value;
        return value;
      })
      .catch(() => st.static || null);
  } else {
    staticTask = Promise.resolve(st.static);
  }

  const [sample, stat] = await Promise.all([sampleTask, staticTask]);
  const errors = [];
  if (!sample.vm) errors.push("vm_stat unavailable");

  const vm = readVm(sample.vm);
  const swap = readSwap((sample.vm || []).find((line) => line.startsWith("swap|")));
  const sysValues = kv(stat?.sys);
  const total = num(sysValues.mem);
  const ram = total !== null
    ? {
        total,
        used: vm.used,
        free: vm.free,
        available: vm.available,
        percent: total > 0 ? (vm.used / total) * 100 : null,
        swapTotal: swap.total,
        swapUsed: swap.used,
        source: "vm_stat",
      }
    : null;

  const elapsed = st.prevAt ? now - st.prevAt : 0;
  const net = readNet(sample.net, st.prevNet, elapsed);
  if (Object.keys(net.next).length > 0) st.prevNet = net.next;
  st.prevAt = now;

  const usage = readTop(sample.top);
  const physical = num(sysValues.physical);
  const logical = num(sysValues.logical);
  const bootMatch = /sec = (\d+)/.exec(sysValues.boot || "");

  const osValues = {};
  for (const line of nonEmpty(stat?.sys)) {
    const match = /^(ProductName|ProductVersion|BuildVersion):\s*(.+)$/.exec(line);
    if (match) osValues[match[1]] = match[2];
  }

  return {
    at: now,
    platform: "macos",
    os: {
      name: osValues.ProductName || "macOS",
      version: osValues.ProductVersion || null,
      build: osValues.BuildVersion || sysValues.release || null,
      arch: sysValues.machine || null,
      hostname: sysValues.hostname || null,
      bootAt: bootMatch ? Number(bootMatch[1]) * 1000 : null,
      uptime: bootMatch ? Math.max(0, now / 1000 - Number(bootMatch[1])) : null,
      battery: readBattery(nonEmpty(sample.batt).join(" ")),
      source: "sw_vers, sysctl, pmset",
    },
    cpu: {
      model: sysValues.brand || null,
      vendor: vendorName(sysValues.brand || "Apple", "Apple"),
      physical,
      logical,
      usage: usage === null ? null : Math.round(usage * 10) / 10,
      perCore: null,
      mhz: null,
      maxMhz: null,
      tempC: null,
    },
    gpu: readDisplays(stat?.gpu),
    ram,
    disks: readDisks(sample.df),
    net: {
      down: net.down,
      up: net.up,
      totalDown: net.totalDown,
      totalUp: net.totalUp,
      adapters: Object.keys(net.next).length,
      source: "netstat -ibn",
    },
    errors,
  };
}

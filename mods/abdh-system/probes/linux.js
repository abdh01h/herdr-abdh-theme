// Linux probes. One POSIX shell read of /proc and /sys per sample; CPU, disk
// and network rates are deltas against the previous sample. nvidia-smi covers
// NVIDIA cards, sysfs covers amdgpu/i915/Xe where the kernel exposes counters.
//
// Field sources:
//   CPU usage / per core     /proc/stat (busy = total - idle - iowait)
//   CPU model, cores         /proc/cpuinfo (+ cpufreq scaling_cur_freq)
//   CPU temperature          /sys/class/thermal/thermal_zone*/temp, /sys/class/hwmon
//   RAM / swap               /proc/meminfo (MemAvailable, SwapTotal/SwapFree)
//   Storage                  df -Pk + /proc/diskstats (sector deltas for activity)
//   GPU                      nvidia-smi, /sys/class/drm/card*/device (amdgpu/i915)
//   Network                  /proc/net/dev deltas
//   OS, uptime, battery      /etc/os-release, uname, /proc/uptime, /sys/class/power_supply

import { clamp, num, vendorName } from "../format.js";
import { readNvidia } from "./nvidia.js";

export const LINUX_SCRIPT = String.raw`
echo '@@os'
printf 'sysname|%s\n' "$(uname -s 2>/dev/null)"
printf 'release|%s\n' "$(uname -r 2>/dev/null)"
printf 'machine|%s\n' "$(uname -m 2>/dev/null)"
printf 'hostname|%s\n' "$(hostname 2>/dev/null)"
cat /etc/os-release 2>/dev/null
echo '@@stat'
cat /proc/stat 2>/dev/null
echo '@@mem'
cat /proc/meminfo 2>/dev/null
echo '@@cpuinfo'
printf 'model|%s\n' "$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
printf 'hardware|%s\n' "$(grep -m1 '^Hardware' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
printf 'vendor|%s\n' "$(grep -m1 '^vendor_id' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
printf 'logical|%s\n' "$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
printf 'cores|%s\n' "$(grep -m1 '^cpu cores' /proc/cpuinfo 2>/dev/null | sed 's/[^0-9]//g')"
printf 'sockets|%s\n' "$(grep '^physical id' /proc/cpuinfo 2>/dev/null | sort -u | wc -l | tr -d ' ')"
echo '@@freq'
printf 'cur|%s\n' "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null)"
printf 'max|%s\n' "$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null)"
echo '@@uptime'
printf 'uptime|%s\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
echo '@@net'
cat /proc/net/dev 2>/dev/null
echo '@@df'
df -Pk 2>/dev/null
echo '@@diskstats'
cat /proc/diskstats 2>/dev/null
echo '@@thermal'
for z in /sys/class/thermal/thermal_zone*; do
  [ -r "$z/temp" ] || continue
  printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"
done
echo '@@hwmon'
for h in /sys/class/hwmon/hwmon*; do
  [ -r "$h/name" ] || continue
  n=$(cat "$h/name" 2>/dev/null)
  for f in "$h"/temp*_input; do
    [ -r "$f" ] || continue
    printf '%s %s %s\n' "$n" "$(basename "$f")" "$(cat "$f" 2>/dev/null)"
  done
done
echo '@@gpu'
for d in /sys/class/drm/card*/device; do
  [ -d "$d" ] || continue
  echo "gpu|$d|$(cat "$d/product_name" 2>/dev/null)|$(cat "$d/gpu_busy_percent" 2>/dev/null)|$(cat "$d/mem_info_vram_used" 2>/dev/null)|$(cat "$d/mem_info_vram_total" 2>/dev/null)|$(grep -m1 '^DRIVER=' "$d/uevent" 2>/dev/null)"
  echo "clk|$d|$(grep '\*' "$d/pp_dpm_sclk" 2>/dev/null | head -1)"
done
for t in /sys/class/drm/card*/device/hwmon/hwmon*/temp1_input; do
  [ -r "$t" ] || continue
  printf 'temp|%s|%s\n' "$t" "$(cat "$t" 2>/dev/null)"
done
echo '@@battery'
for b in /sys/class/power_supply/BAT*; do
  [ -r "$b/capacity" ] || continue
  printf '%s %s\n' "$(cat "$b/capacity" 2>/dev/null)" "$(cat "$b/status" 2>/dev/null)"
done
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

function readStat(lines) {
  let total = null;
  const per = [];
  for (const line of lines || []) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const fields = match[2].trim().split(/\s+/).map((value) => Number(value) || 0);
    const idle = (fields[3] || 0) + (fields[4] || 0);
    const sum = fields.slice(0, 8).reduce((a, b) => a + b, 0);
    const entry = { busy: sum - idle, total: sum };
    if (match[1] === "") total = entry;
    else per.push({ index: Number(match[1]), ...entry });
  }
  per.sort((a, b) => a.index - b.index);
  return { total, per };
}

function usageBetween(previous, current) {
  if (!previous || !current) return null;
  const dt = current.total - previous.total;
  const db = current.busy - previous.busy;
  if (dt <= 0 || db < 0) return null;
  return clamp((db / dt) * 100, 0, 100);
}

function meminfo(lines) {
  const values = {};
  for (const line of lines || []) {
    const match = /^(\w+):\s*(\d+)/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

function readCpuInfo(lines) {
  const values = kv(lines);
  const model = values.model || values.hardware || null;
  const vendor = values.vendor || null;
  const logical = num(values.logical);
  const coresPerSocket = num(values.cores);
  const sockets = num(values.sockets);
  const physical = coresPerSocket !== null && sockets !== null && sockets > 0
    ? coresPerSocket * sockets
    : null;
  return { model, vendor, logical, physical };
}

function readFrequency(lines) {
  const values = kv(lines);
  const current = num(values.cur);
  const max = num(values.max);
  return {
    mhz: current !== null ? current / 1000 : null,
    maxMhz: max !== null ? max / 1000 : null,
  };
}

function readDisks(lines, previous, elapsedMs) {
  const next = {};
  for (const line of lines || []) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2];
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/.test(name)) continue;
    next[name] = {
      read: (Number(fields[5]) || 0) * 512,
      write: (Number(fields[9]) || 0) * 512,
    };
  }
  const rates = {};
  if (previous && elapsedMs > 0) {
    for (const [name, value] of Object.entries(next)) {
      const prev = previous[name];
      if (!prev) continue;
      const dr = value.read - prev.read;
      const dw = value.write - prev.write;
      if (dr >= 0 && dw >= 0) {
        rates[name] = { read: (dr * 1000) / elapsedMs, write: (dw * 1000) / elapsedMs };
      }
    }
  }
  return { next, rates };
}

function diskDevice(mountSource, diskNames) {
  const base = String(mountSource).replace(/^.*\//, "");
  if (diskNames.has(base)) return base;
  const stripped = base.replace(/^(nvme\d+n\d+|mmcblk\d+)p\d+$/, "$1").replace(/^([a-z]+)\d+$/, "$1");
  return diskNames.has(stripped) ? stripped : null;
}

function readDf(lines) {
  const disks = [];
  const seen = new Set();
  const skip = /^(tmpfs|devtmpfs|udev|none|proc|sysfs|efivarfs|cgroup|ramfs|squashfs|nsfs|securityfs|debugfs|tracefs|pstore|bpf|configfs|fusectl|hugetlbfs|mqueue|devpts|autofs)$/i;
  for (const line of lines || []) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const source = match[1];
    const mount = match[6];
    if (skip.test(source)) continue;
    if (!source.startsWith("/dev/") && source !== "overlay" && !source.startsWith("/dev")) continue;
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
    const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (name === "lo" || /^lo:/.test(name)) continue;
    const fields = match[2].trim().split(/\s+/).map((value) => Number(value) || 0);
    const rx = fields[0] || 0;
    const tx = fields[8] || 0;
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
      const dr = value.rx - prev.rx;
      const du = value.tx - prev.tx;
      if (dr < 0 || du < 0) continue;
      deltaDown += dr;
      deltaUp += du;
      counted += 1;
    }
    if (counted > 0) {
      down = (deltaDown * 1000) / elapsedMs;
      up = (deltaUp * 1000) / elapsedMs;
    }
  }
  return { next, totalDown, totalUp, down, up };
}

function readTemperatures(thermalLines, hwmonLines) {
  const all = [];
  for (const line of thermalLines || []) {
    const [type, raw] = line.trim().split(/\s+/);
    const value = num(raw);
    if (value !== null) all.push({ type: type || "", celsius: value / 1000 });
  }
  for (const line of hwmonLines || []) {
    const [name, input, raw] = line.trim().split(/\s+/);
    const value = num(raw);
    if (value !== null) all.push({ type: `${name || ""} ${input || ""}`, celsius: value / 1000 });
  }
  const plausible = all.filter((entry) => entry.celsius > 0 && entry.celsius < 150);
  if (plausible.length === 0) return { cpu: null, all };
  const preferred = plausible.filter((entry) => /x86_pkg_temp|coretemp|k10temp|zenpower|cpu|soc|package/i.test(entry.type));
  const pool = preferred.length > 0 ? preferred : plausible;
  return { cpu: Math.max(...pool.map((entry) => entry.celsius)), all };
}

function readSysfsGpus(lines) {
  const byPath = {};
  const clocks = {};
  const temps = {};
  for (const line of lines || []) {
    const [tag, path, value] = line.trim().split("|");
    if (tag !== "clk" || !path) continue;
    const match = /(\d+(?:\.\d+)?)\s*Mhz/i.exec(value || "");
    if (match) clocks[path] = Number(match[1]);
  }
  for (const line of lines || []) {
    const [tag, path, raw] = line.trim().split("|");
    if (tag !== "temp" || !path) continue;
    const value = num(raw);
    if (value !== null) temps[path.replace(/\/hwmon\/[^/]+\/temp1_input$/, "")] = value / 1000;
  }
  for (const line of lines || []) {
    const [tag, path, product, busy, used, total, driver] = line.trim().split("|");
    if (tag !== "gpu" || !path) continue;
    const driverName = (driver || "").replace(/^DRIVER=/, "");
    const name = (product || "").trim() || (driverName === "amdgpu" ? "AMD GPU" : driverName === "i915" || driverName === "xe" ? "Intel GPU" : "GPU");
    const entry = {
      id: `linux:${path}`,
      name,
      vendor: name === "GPU" ? vendorName(driverName, "GPU") : vendorName(name),
      usage: num(busy),
      memUsed: num(used),
      memTotal: num(total),
      tempC: temps[path] ?? null,
      mhz: clocks[path] ?? null,
      source: `sysfs (${driverName || "drm"})`,
    };
    // card0 is often the first GPU; a later card with the same model is separate.
    if (!byPath[path]) byPath[path] = entry;
  }
  return Object.values(byPath);
}

function mergeGpus(sysfsRows, nvidiaRows) {
  const result = [...sysfsRows];
  for (const row of nvidiaRows || []) {
    const same = result.find(
      (candidate) =>
        candidate.name.toLowerCase() === row.name.toLowerCase() ||
        candidate.name.toLowerCase().includes(row.name.toLowerCase()),
    );
    if (same) {
      same.usage = row.usage;
      same.memUsed = row.memUsed;
      same.memTotal = row.memTotal ?? same.memTotal;
      same.tempC = row.tempC ?? same.tempC;
      same.mhz = row.mhz ?? same.mhz;
      same.source = "sysfs + nvidia-smi";
    } else {
      result.push({
        id: `linux:nv:${row.name}`,
        name: row.name,
        vendor: "NVIDIA",
        usage: row.usage,
        memUsed: row.memUsed,
        memTotal: row.memTotal,
        tempC: row.tempC,
        mhz: row.mhz,
        source: "nvidia-smi",
      });
    }
  }
  return result;
}

export async function collectLinux(state, options = {}, run) {
  const st = state.linux || (state.linux = {});
  const now = Date.now();
  const result = await run("sh", ["-c", LINUX_SCRIPT]);
  if (!result || result.code !== 0) {
    throw new Error((result && result.stderr && result.stderr.trim()) || "Linux probe failed");
  }
  const data = sections(result.stdout);
  const errors = [];
  if (!data.stat) errors.push("/proc/stat unavailable");

  const stat = readStat(data.stat);
  const cpuUsage = usageBetween(st.prevStat?.total, stat.total);
  const perCore = stat.per.map((entry, index) => {
    const prev = st.prevStat?.per?.[index];
    return usageBetween(prev, entry);
  });
  if (stat.total) st.prevStat = stat;

  const info = readCpuInfo(data.cpuinfo);
  const freq = readFrequency(data.freq);
  const mem = meminfo(data.mem);
  const totalMem = num(mem.MemTotal) !== null ? mem.MemTotal * 1024 : null;
  const availableMem = num(mem.MemAvailable) !== null
    ? mem.MemAvailable * 1024
    : num(mem.MemFree) !== null
      ? (mem.MemFree + (mem.Buffers || 0) + (mem.Cached || 0)) * 1024
      : null;
  const freeMem = num(mem.MemFree) !== null ? mem.MemFree * 1024 : null;
  const swapTotal = num(mem.SwapTotal) !== null ? mem.SwapTotal * 1024 : null;
  const swapUsed = num(mem.SwapTotal) !== null && num(mem.SwapFree) !== null
    ? (mem.SwapTotal - mem.SwapFree) * 1024
    : null;
  const ram = totalMem !== null && availableMem !== null
    ? {
        total: totalMem,
        used: Math.max(0, totalMem - availableMem),
        free: freeMem,
        available: availableMem,
        percent: totalMem > 0 ? ((totalMem - availableMem) / totalMem) * 100 : null,
        swapTotal,
        swapUsed,
        source: "/proc/meminfo",
      }
    : null;

  const elapsed = st.prevAt ? now - st.prevAt : 0;
  const diskstat = readDisks(data.diskstats, st.prevDisk, elapsed);
  if (Object.keys(diskstat.next).length > 0) st.prevDisk = diskstat.next;
  const disks = readDf(data.df);
  const diskNames = new Set(Object.keys(diskstat.next));
  for (const disk of disks) {
    const device = diskDevice(disk.id, diskNames);
    const activity = device ? diskstat.rates[device] : null;
    if (activity) {
      disk.readBps = activity.read;
      disk.writeBps = activity.write;
    }
  }

  const net = readNet(data.net, st.prevNet, elapsed);
  if (Object.keys(net.next).length > 0) st.prevNet = net.next;
  st.prevAt = now;

  const temps = readTemperatures(data.thermal, data.hwmon);
  const sysfsGpus = readSysfsGpus(data.gpu);
  const nvidiaRows = await readNvidia(run, st, now).catch(() => null);

  const os = nonEmpty(data.os);
  const osValues = kv(os);
  const pretty = os.find((line) => line.startsWith("PRETTY_NAME="));
  const uptimeValues = kv(data.uptime);
  const uptimeRow = num(uptimeValues.uptime);

  const batteryRows = nonEmpty(data.battery)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 1);
  const battery = batteryRows.length > 0 && num(batteryRows[0][0]) !== null
    ? { percent: Number(batteryRows[0][0]), charging: /charging|full/i.test(batteryRows[0][1] || "") }
    : null;

  return {
    at: now,
    platform: "linux",
    os: {
      name: pretty ? pretty.split("=").slice(1).join("=").replace(/^"|"$/g, "") : (osValues.sysname || null),
      version: osValues.release || null,
      build: osValues.release || null,
      arch: osValues.machine || null,
      hostname: osValues.hostname || null,
      bootAt: uptimeRow !== null ? now - uptimeRow * 1000 : null,
      uptime: num(uptimeValues.uptime),
      battery,
      source: "/etc/os-release, uname, /proc/uptime",
    },
    cpu: {
      model: info.model,
      vendor: info.vendor,
      physical: info.physical,
      logical: info.logical,
      usage: cpuUsage === null ? null : Math.round(cpuUsage * 10) / 10,
      perCore: perCore.every((value) => value === null) ? null : perCore.map((value) => (value === null ? null : Math.round(value * 10) / 10)),
      mhz: freq.mhz,
      maxMhz: freq.maxMhz,
      tempC: temps.cpu,
    },
    gpu: mergeGpus(sysfsGpus, nvidiaRows),
    ram,
    disks,
    net: {
      down: net.down,
      up: net.up,
      totalDown: net.totalDown,
      totalUp: net.totalUp,
      adapters: Object.keys(net.next).length,
      source: "/proc/net/dev",
    },
    errors,
  };
}

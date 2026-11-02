// Windows probes. One PowerShell process per sample, using CIM classes and the
// raw performance counters (bytes/100ns are cumulative, so the panel computes
// real deltas itself; nothing is inferred). ConvertTo-Json keeps field names
// stable across locales.
//
// Field sources:
//   CPU usage, per core    Win32_PerfRawData_PerfOS_Processor (busy 100ns / timestamp)
//   CPU model, cores, freq Win32_Processor (static)
//   CPU temperature        MSAcpi_ThermalZoneTemperature (root/wmi; absent on most desktops)
//   RAM, page file          Win32_OperatingSystem (visible/free physical, total/free virtual)
//   Disks                   Win32_LogicalDisk (DriveType=3) + Win32_PerfRawData_PerfDisk_LogicalDisk
//   GPU model/vendor/VRAM   Win32_VideoController + display class registry qwMemorySize (static)
//   GPU usage/VRAM/temp     nvidia-smi when installed; GPUEngine counters only when unambiguous
//   Network                 Win32_PerfRawData_Tcpip_NetworkInterface deltas
//   OS, uptime, battery     Win32_OperatingSystem, Win32_Battery (static)

import { clamp, num, vendorName } from "../format.js";
import { readNvidia } from "./nvidia.js";

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command"];

export const WINDOWS_STATIC_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$os = @(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime)
$cpu = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,CurrentClockSpeed,Manufacturer)
$vc = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion)
$bat = @(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus)
$thermal = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object CurrentTemperature)
$lhm = @()
try { $lhm = @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq 'Temperature' } | Select-Object Name,Value) } catch { }
$keys = @()
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object { $keys += Get-ItemProperty $_.PSPath }
$gpus = @()
foreach ($v in $vc) {
  $mem = $null
  foreach ($k in $keys) { if ($k.'HardwareInformation.AdapterString' -eq $v.Name) { $mem = $k.'HardwareInformation.qwMemorySize' } }
  $gpus += [pscustomobject]@{ name = $v.Name; vendor = $v.AdapterCompatibility; driver = $v.DriverVersion; vramTotal = $mem }
}
$boot = $null
if ($os.Count -gt 0 -and $os[0].LastBootUpTime) { $boot = ([DateTimeOffset]$os[0].LastBootUpTime).ToUnixTimeMilliseconds() }
$osInfo = $null
if ($os.Count -gt 0) { $osInfo = [pscustomobject]@{ name = $os[0].Caption; version = $os[0].Version; build = $os[0].BuildNumber } }
$cpuInfo = $null
if ($cpu.Count -gt 0) { $cpuInfo = [pscustomobject]@{ model = $cpu[0].Name; cores = $cpu[0].NumberOfCores; logical = $cpu[0].NumberOfLogicalProcessors; maxMhz = $cpu[0].MaxClockSpeed; mhz = $cpu[0].CurrentClockSpeed; vendor = $cpu[0].Manufacturer } }
$batInfo = $null
if ($bat.Count -gt 0) { $batInfo = [pscustomobject]@{ percent = $bat[0].EstimatedChargeRemaining; status = $bat[0].BatteryStatus } }
$temps = @()
foreach ($t in $thermal) { if ($t.CurrentTemperature) { $temps += [double]$t.CurrentTemperature } }
$obj = [pscustomobject]@{
  hostname = $env:COMPUTERNAME
  arch = $env:PROCESSOR_ARCHITECTURE
  bootAt = $boot
  os = $osInfo
  cpu = $cpuInfo
  gpus = $gpus
  battery = $batInfo
  thermal = $temps
  lhm = $lhm
}
$obj | ConvertTo-Json -Compress -Depth 5
`;

const GPU_ENGINE_CODE = String.raw`
$groups = @{}
foreach ($e in @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
  if ($e.Name -match 'luid_0x[0-9A-Fa-f]+_0x([0-9A-Fa-f]+)') {
    $k = $matches[1]
    if (-not $groups.ContainsKey($k)) { $groups[$k] = 0.0 }
    $groups[$k] = $groups[$k] + [double]$e.UtilizationPercentage
  }
}
$eng = @($groups.GetEnumerator() | ForEach-Object { [pscustomobject]@{ luid = $_.Key; util = [math]::Round([math]::Min(100.0, $_.Value), 1) } })
`;

export function windowsDynamicScript(slow) {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$os = @(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory)
$raw = @(Get-CimInstance Win32_PerfRawData_PerfOS_Processor | Select-Object Name,PercentProcessorTime,PercentIdleTime,Timestamp_Sys100NS)
$ld = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem)
$dsk = @(Get-CimInstance Win32_PerfRawData_PerfDisk_LogicalDisk | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,PercentDiskTime,Timestamp_Sys100NS)
$net = @(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | Select-Object Name,BytesReceivedPersec,BytesSentPersec,Timestamp_Sys100NS)
$pf = @(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage)
$eng = @()
${slow ? GPU_ENGINE_CODE : ""}
$obj = [pscustomobject]@{
  at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  os = $os
  perfCpu = $raw
  disks = $ld
  perfDisk = $dsk
  net = $net
  pageFile = $pf
  gpuEngine = $eng
}
$obj | ConvertTo-Json -Compress -Depth 5
`;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function list(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

async function runJson(run, script) {
  const result = await run("powershell.exe", [...POWERSHELL_ARGS, script]);
  if (!result || result.code !== 0) {
    throw new Error((result && result.stderr && result.stderr.trim()) || "PowerShell probe failed");
  }
  const text = String(result.stdout || "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function cpuDeltas(rows, previous) {
  const next = {};
  const values = {};
  for (const row of list(rows)) {
    const name = String(row.Name ?? "");
    const busy = num(row.PercentProcessorTime);
    const ts = num(row.Timestamp_Sys100NS);
    if (!name || busy === null || ts === null) continue;
    next[name] = { busy, ts };
    const prev = previous?.[name];
    if (prev && ts > prev.ts && busy >= prev.busy) {
      // PERF_100NSEC_TIMER_INV: the raw counter accumulates idle time, so the
      // cooked "processor time" is its inverse. Without this the panel showed
      // idle as usage (87% while Task Manager said 17%).
      values[name] = clamp(100 - ((busy - prev.busy) / (ts - prev.ts)) * 100, 0, 100);
    }
  }
  const cores = Object.keys(values)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b))
    .map((name) => values[name]);
  let usage = values._Total ?? null;
  if (usage === null && cores.length > 0) {
    usage = cores.reduce((sum, value) => sum + value, 0) / cores.length;
  }
  return { next, usage, cores };
}

// Raw counters store cumulative bytes in their "Persec" fields; multiplying the
// delta by 1e7 / delta(100ns timestamp) yields bytes per second.
function counterRates(rows, previous, readKey, writeKey) {
  const next = {};
  const rates = {};
  for (const row of list(rows)) {
    const name = String(row.Name ?? "");
    const ts = num(row.Timestamp_Sys100NS);
    const read = num(row[readKey]);
    const write = writeKey ? num(row[writeKey]) : 0;
    if (!name || ts === null || read === null) continue;
    next[name] = { ts, read, write: write ?? 0 };
    const prev = previous?.[name];
    if (prev && ts > prev.ts && read >= prev.read && (write ?? 0) >= prev.write) {
      const scale = 1e7 / (ts - prev.ts);
      rates[name] = {
        read: (read - prev.read) * scale,
        write: ((write ?? 0) - prev.write) * scale,
      };
    }
  }
  return { next, rates };
}

function windowsCpu(perf, staticCpu, previous) {
  const { next, usage, cores } = cpuDeltas(perf, previous);
  const base = staticCpu || {};
  return {
    next,
    cpu: {
      model: base.model ? String(base.model).replace(/\s+/g, " ").trim() : null,
      vendor: base.vendor || null,
      physical: num(base.cores),
      logical: num(base.logical),
      usage: usage === null ? null : Math.round(usage * 10) / 10,
      perCore: cores.length > 0 ? cores.map((v) => Math.round(v * 10) / 10) : null,
      mhz: num(base.mhz),
      maxMhz: num(base.maxMhz),
      tempC: null,
    },
  };
}

function windowsTemps(thermal, lhm) {
  // LibreHardwareMonitor exposes real package/core sensors when installed;
  // prefer those over ACPI zones, which are not the CPU's core temperature.
  const core = list(lhm)
    .filter((sensor) => /cpu|core|package|tctl|tdie|ccd/i.test(String(sensor.Name ?? "")))
    .map((sensor) => num(sensor.Value))
    .filter((value) => value !== null && value > 0 && value < 150);
  if (core.length > 0) return Math.max(...core);
  const values = list(thermal)
    .map((value) => (num(value) === null ? null : Number(value) / 10 - 273.15))
    .filter((value) => value !== null && value > 0 && value < 150);
  return values.length > 0 ? Math.max(...values) : null;
}

function windowsGpus(staticGpus, nvidiaRows, engineRows) {
  const result = [];
  const used = new Set();
  for (const gpu of list(staticGpus)) {
    const name = String(gpu.name || "GPU").replace(/\s+/g, " ").trim();
    const vendor = vendorName(gpu.vendor || name);
    const row = {
      id: `win:${name}`,
      name,
      vendor,
      usage: null,
      memUsed: null,
      memTotal: num(gpu.vramTotal),
      tempC: null,
      mhz: null,
      source: "Win32_VideoController",
    };
    const match = list(nvidiaRows).find(
      (candidate) =>
        !used.has(candidate.name) &&
        (candidate.name.toLowerCase() === name.toLowerCase() ||
          name.toLowerCase().includes(candidate.name.toLowerCase())),
    );
    if (match) {
      used.add(match.name);
      row.usage = match.usage;
      row.memUsed = match.memUsed;
      row.memTotal = match.memTotal ?? row.memTotal;
      row.tempC = match.tempC;
      row.mhz = match.mhz;
      row.source = "Win32_VideoController + nvidia-smi";
    }
    result.push(row);
  }
  for (const row of list(nvidiaRows)) {
    if (used.has(row.name)) continue;
    result.push({
      id: `nv:${row.name}`,
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
  // GPUEngine counters are per LUID and Windows has no stable LUID-to-adapter
  // map, so attribute their usage only when there is exactly one adapter.
  if (result.length === 1 && result[0].usage === null) {
    const engines = list(engineRows);
    if (engines.length === 1 && num(engines[0].util) !== null) {
      result[0].usage = num(engines[0].util);
      result[0].source = "GPUEngine counters (single adapter)";
    }
  }
  return result;
}

export async function collectWindows(state, options = {}, run) {
  const st = state.windows || (state.windows = {});
  const now = Date.now();
  const dynamic = runJson(run, windowsDynamicScript(options.slow !== false)).catch((error) => ({
    error: String(error && error.message ? error.message : error),
  }));
  let staticTask;
  if (!st.static || now - (st.staticAt || 0) > 300000) {
    st.staticAt = now;
    staticTask = runJson(run, WINDOWS_STATIC_SCRIPT)
      .then((value) => {
        if (value) st.static = value;
        return value;
      })
      .catch(() => st.static || null);
  } else {
    staticTask = Promise.resolve(st.static);
  }
  const nvidiaTask = readNvidia(run, st, now).catch(() => null);

  const [dynamicResult, stat, nvidiaRows] = await Promise.all([dynamic, staticTask, nvidiaTask]);
  const errors = [];
  if (!dynamicResult || dynamicResult.error) {
    errors.push(dynamicResult?.error || "PowerShell performance probe returned nothing");
  }

  const perfCpu = dynamicResult?.perfCpu;
  const previousCpu = st.prevCpu;
  const cpuResult = windowsCpu(perfCpu, stat?.cpu, previousCpu);
  if (perfCpu) st.prevCpu = cpuResult.next;
  const cpu = cpuResult.cpu;
  cpu.tempC = windowsTemps(stat?.thermal, stat?.lhm);
  if (cpu.usage === null) errors.push("CPU usage needs two samples");

  const osRow = first(dynamicResult?.os);
  let ram = null;
  if (osRow) {
    const total = num(osRow.TotalVisibleMemorySize);
    const free = num(osRow.FreePhysicalMemory);
    if (total !== null && free !== null) {
      const totalBytes = total * 1024;
      const freeBytes = free * 1024;
      const used = Math.max(0, totalBytes - freeBytes);
      // Win32_PageFileUsage reports the page file in megabytes; without one
      // (or on a machine that has none) swap stays unavailable.
      const pageFile = first(dynamicResult?.pageFile);
      const allocatedMb = num(pageFile?.AllocatedBaseSize);
      const currentMb = num(pageFile?.CurrentUsage);
      const swapTotal = allocatedMb !== null ? allocatedMb * 1024 * 1024 : null;
      const swapUsed = currentMb !== null ? currentMb * 1024 * 1024 : null;
      ram = {
        total: totalBytes,
        used,
        free: freeBytes,
        available: freeBytes,
        percent: totalBytes > 0 ? (used / totalBytes) * 100 : null,
        swapTotal,
        swapUsed,
        source: "Win32_OperatingSystem",
      };
    }
  }

  const diskPerfRows = list(dynamicResult?.perfDisk);
  const diskState = counterRates(diskPerfRows, st.prevDisk, "DiskReadBytesPersec", "DiskWriteBytesPersec");
  if (diskPerfRows.length > 0) st.prevDisk = diskState.next;
  const perfByName = new Map(diskPerfRows.map((row) => [String(row.Name || ""), row]));
  const disks = list(dynamicResult?.disks)
    .map((disk) => {
      const id = String(disk.DeviceID || "");
      const total = num(disk.Size);
      const free = num(disk.FreeSpace);
      const perf = perfByName.get(id);
      const activity = perf ? diskState.rates[id] : null;
      const used = total !== null && free !== null ? Math.max(0, total - free) : null;
      return {
        id,
        name: disk.VolumeName ? String(disk.VolumeName) : id,
        mount: id,
        format: disk.FileSystem ? String(disk.FileSystem) : null,
        total,
        used,
        free,
        percent: total && used !== null ? (used / total) * 100 : null,
        readBps: activity ? activity.read : null,
        writeBps: activity ? activity.write : null,
        source: "Win32_LogicalDisk",
      };
    })
    .filter((disk) => disk.total !== null);

  const networkRows = list(dynamicResult?.net).filter(
    (row) => !/loopback|isatap|teredo|pseudo|_total/i.test(String(row.Name || "")),
  );
  const netState = counterRates(networkRows, st.prevNet, "BytesReceivedPersec", "BytesSentPersec");
  if (networkRows.length > 0) st.prevNet = netState.next;
  let down = null;
  let up = null;
  if (networkRows.length > 0) {
    const rated = Object.values(netState.rates);
    if (rated.length > 0) {
      down = rated.reduce((sum, value) => sum + value.read, 0);
      up = rated.reduce((sum, value) => sum + value.write, 0);
    }
  }
  const net = {
    down,
    up,
    totalDown: networkRows.reduce((sum, row) => sum + (num(row.BytesReceivedPersec) ?? 0), 0),
    totalUp: networkRows.reduce((sum, row) => sum + (num(row.BytesSentPersec) ?? 0), 0),
    adapters: networkRows.length,
    source: "Win32_PerfRawData_Tcpip_NetworkInterface",
  };

  const bootAt = num(stat?.bootAt);
  const batteryRow = stat?.battery;
  const batteryPercent = num(batteryRow?.percent);
  const battery = batteryPercent === null
    ? null
    : {
        percent: batteryPercent,
        charging: [2, 3, 6, 7, 8, 9].includes(Number(batteryRow.status)),
      };

  return {
    at: num(dynamicResult?.at) ?? now,
    platform: "windows",
    os: {
      name: stat?.os?.name ? String(stat.os.name) : null,
      version: stat?.os?.version ? String(stat.os.version) : null,
      build: stat?.os?.build ? String(stat.os.build) : null,
      arch: stat?.arch ? String(stat.arch) : null,
      hostname: stat?.hostname ? String(stat.hostname) : null,
      bootAt,
      uptime: bootAt === null ? null : Math.max(0, (now - bootAt) / 1000),
      battery,
      source: "Win32_OperatingSystem / Win32_Battery",
    },
    cpu,
    gpu: windowsGpus(stat?.gpus, nvidiaRows, dynamicResult?.gpuEngine),
    ram,
    disks,
    net,
    errors,
  };
}

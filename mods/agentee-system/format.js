// Number and text formatting for the System panel. Kept free of any host import
// so the probe modules and the view can share it.

export function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clamp(value, low, high) {
  const n = num(value);
  if (n === null) return null;
  return Math.min(high, Math.max(low, n));
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(value) {
  const n = num(value);
  if (n === null || n < 0) return "unavailable";
  let unit = 0;
  let size = n;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${UNITS[unit]}`;
}

export function rate(value) {
  const n = num(value);
  if (n === null || n < 0) return "unavailable";
  return `${bytes(n)}/s`;
}

export function percent(value) {
  const n = num(value);
  if (n === null) return "unavailable";
  return `${Math.round(n)}%`;
}

export function mhz(value) {
  const n = num(value);
  if (n === null || n <= 0) return "unavailable";
  return n >= 1000 ? `${(n / 1000).toFixed(2)} GHz` : `${Math.round(n)} MHz`;
}

export function tempC(value) {
  const n = num(value);
  if (n === null) return "unavailable";
  return `${Math.round(n)}\u00b0C`;
}

export function uptime(seconds) {
  const n = num(seconds);
  if (n === null || n < 0) return "unavailable";
  const total = Math.floor(n);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export function clock(at) {
  const n = num(at);
  if (n === null) return "unavailable";
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function vendorName(raw, fallback = "GPU") {
  const text = String(raw || "");
  if (/nvidia/i.test(text)) return "NVIDIA";
  if (/advanced micro devices|amd|radeon/i.test(text)) return "AMD";
  if (/intel/i.test(text)) return "Intel";
  if (/apple/i.test(text)) return "Apple";
  return text.trim() || fallback;
}

export function megabytes(value) {
  const n = num(value);
  return n === null ? null : n * 1024 * 1024;
}

export function gigabytes(value) {
  const n = num(value);
  return n === null ? null : n * 1024 * 1024 * 1024;
}

// Parses "2048.00M", "1.5G", "512K", bare bytes.
export function sizeText(text) {
  const match = /^([\d.]+)\s*([KMGTkmgt])?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const power = { K: 1, M: 2, G: 3, T: 4 }[(match[2] || "B").toUpperCase()] ?? 0;
  return base * Math.pow(1024, power);
}

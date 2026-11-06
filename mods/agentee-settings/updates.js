// Agentee updates: compare the installed bundle with the repository's `main`,
// and run the official installer when the person asks for the update.
//
// The check downloads the same archive the installer consumes (codeload's
// tar.gz of main) and compares the shipped files byte for byte, after
// normalizing line endings. No GitHub API (rate limits), no version file to
// bump: any commit that touches a shipped file shows up, and so does a hand
// edit to an installed one. Check and install read the same source, so the two
// cannot disagree about what "main" is.
//
// The mod runtime's `fs/promises` is a sandboxed subset of Node's (mkdir,
// readFile, readdir, writeFile, unlink, rmdir, exists; no stat/rm/chmod), and
// it only touches the app folder. `exec`, `fs` and the folders are injected so
// the logic also runs under plain Node in a test harness.

export const REPO = "abdh01h/herdr-agentee-theme";
export const BRANCH = "main";
export const SITE = `https://github.com/${REPO}`;
const ARCHIVE = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const AGENT = "Agentee-updater";

// Exactly what the installers copy: the theme, the layout pair and every
// `agentee-*` mod. Generated files an installed mod grows (gpui-kit.d.ts,
// jsconfig.json) are not shipped and never read as drift.
export function shipped(path) {
  return (
    path === "themes/agentee.json" ||
    path === "layouts/agentee.json" ||
    path === "layouts/agentee.svg" ||
    (path.startsWith("mods/agentee-") && !path.endsWith("/"))
  );
}

// A copy taken from a CRLF checkout has to compare equal to the archive's LF
// files.
function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function detail(result) {
  const text = (result.stderr || result.stdout || "").trim();
  return text || `exit ${result.code}`;
}

// The runtime fs has no `rm -r`; walk it.
async function purge(fs, dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await purge(fs, path);
    else await fs.unlink(path).catch(() => {});
  }
  await fs.rmdir(dir).catch(() => {});
}

// Every shipped file under a checkout or an unpacked archive.
async function collect(fs, base) {
  const out = [];
  for (const folder of ["themes", "layouts"]) {
    let entries = [];
    try {
      entries = await fs.readdir(`${base}/${folder}`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (!entry.isDirectory() && shipped(path)) out.push(path);
    }
  }
  let mods = [];
  try {
    mods = await fs.readdir(`${base}/mods`, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of mods) {
    if (!entry.isDirectory() || !entry.name.startsWith("agentee-")) continue;
    await walk(fs, `${base}/mods/${entry.name}`, `mods/${entry.name}`, out);
  }
  return out;
}

async function walk(fs, dir, prefix, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(fs, `${dir}/${entry.name}`, path, out);
    else out.push(path);
  }
}

// Fetch main, unpack it in `dir` (inside the app folder: the mod's fs grant),
// compare, then clear the unpacked copy away.
export async function check({ exec, fs, dir, root }) {
  await purge(fs, dir);
  await fs.mkdir(dir, { recursive: true });
  const archive = `${dir}/main.tar.gz`;
  const download = await exec("curl", ["-fsSL", "--max-time", "60", "-H", `User-Agent: ${AGENT}`, "-o", archive, ARCHIVE]);
  if (download.code !== 0) {
    await purge(fs, dir);
    throw new Error(`Could not download main: ${detail(download)}`);
  }
  const unpack = await exec("tar", ["-xzf", archive, "-C", dir]);
  if (unpack.code !== 0) {
    await purge(fs, dir);
    throw new Error(`Could not unpack main: ${detail(unpack)}`);
  }
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const folder = entries.find((entry) => entry.isDirectory());
  if (!folder) {
    await purge(fs, dir);
    throw new Error("The archive had no repository folder.");
  }
  const source = `${dir}/${folder.name}`;
  const paths = await collect(fs, source);
  if (!paths.length) {
    await purge(fs, dir);
    throw new Error("The archive had no Agentee files.");
  }
  const changed = [];
  for (const path of paths) {
    let remote = "";
    try {
      remote = await fs.readFile(`${source}/${path}`, "utf8");
    } catch {
      continue;
    }
    let local = null;
    try {
      local = await fs.readFile(`${root}/${path}`, "utf8");
    } catch {
      changed.push(path);
      continue;
    }
    if (normalize(local) !== normalize(remote)) changed.push(path);
  }
  await purge(fs, dir);
  return { at: Date.now(), changed };
}

const q = (value) => value.replace(/'/g, "''");

// A launcher, not a copy of the installer: the repository's own script stays
// the one source of truth for backups, key merge, mod checks and the files it
// writes. It runs detached (the app must not block on a download) and records
// its outcome in `install.result`, which the settings panel polls.
function ps(dir) {
  return `$ErrorActionPreference = "Stop"
$dir = '${q(dir)}'
$log = Join-Path $dir "install.log"
$result = Join-Path $dir "install.result"
try {
  $src = Join-Path $dir "agentee-install.ps1"
  Invoke-WebRequest -UseBasicParsing "${RAW}/install.ps1" -OutFile $src
  & $src *> $log
  Set-Content -LiteralPath $result -Value "ok" -Encoding utf8
} catch {
  ("error: " + $_.Exception.Message) | Set-Content -LiteralPath $result -Encoding utf8
}
`;
}

function sh(dir) {
  return `#!/bin/sh
dir='${dir.replace(/'/g, "'\\''")}'
log="$dir/install.log"
result="$dir/install.result"
src="$dir/agentee-install.sh"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${RAW}/install.sh" -o "$src"
else
  wget -qO "$src" "${RAW}/install.sh"
fi
if [ -s "$src" ] && sh "$src" >"$log" 2>&1; then
  echo ok > "$result"
else
  echo "error: install.sh failed; see $log" > "$result"
fi
`;
}

export function script(dir, platform) {
  return platform === "windows"
    ? { path: `${dir}/agentee-update.ps1`, content: ps(dir) }
    : { path: `${dir}/agentee-update.sh`, content: sh(dir) };
}

export async function startInstall({ exec, fs, dir, platform }) {
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.unlink(`${dir}/install.result`);
  } catch {
    // no previous result to clear
  }
  const file = script(dir, platform);
  await fs.writeFile(file.path, file.content, "utf8");
  if (platform === "windows") {
    await exec("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Start-Process -WindowStyle Hidden -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${q(file.path)}'`,
    ]);
  } else {
    await exec("sh", ["-c", `nohup sh '${file.path.replace(/'/g, "'\\''")}' >/dev/null 2>&1 &`]);
  }
  return file.path;
}

export async function result(fs, dir) {
  try {
    // Windows PowerShell's `Set-Content -Encoding utf8` writes a BOM.
    return (await fs.readFile(`${dir}/install.result`, "utf8")).replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

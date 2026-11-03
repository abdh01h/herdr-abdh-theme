# Agentee - one-command install for Windows.
#
#   irm https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.ps1 | iex
#
# Or with options:
#   ./install.ps1 -HerdrHome "D:\herdr" -Branch main -NoLayout
#
# It downloads the repository archive, backs up anything it replaces, installs
# the theme, layout and mods into the Herdr home, merges the editor keys, runs
# `herdr-app check` for every mod, and switches to the layout when a window is
# running. Nothing outside the Herdr home is touched.

param(
  [Alias("Home")][string]$HerdrHome = "",
  [string]$Repo = "abdh01h/herdr-abdh-theme",
  [string]$Branch = "main",
  [switch]$NoLayout
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$homeDir = if ($HerdrHome) { $HerdrHome }
  elseif ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME }
  else { Join-Path $HOME ".config\herdr-app" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backups = New-Object System.Collections.Generic.List[string]

function Backup([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $target = "$path.bak-$stamp"
  Copy-Item -LiteralPath $path -Destination $target -Recurse -Force
  $backups.Add((Split-Path -Leaf $target)) | Out-Null
}

function To-Hashtable($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}
    foreach ($p in $value.PSObject.Properties) { $h[$p.Name] = To-Hashtable $p.Value }
    return $h
  }
  if ($value -is [System.Collections.IEnumerable] -and $value -isnot [string]) {
    return ,@($value | ForEach-Object { To-Hashtable $_ })
  }
  return $value
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("abdh-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "==> Agentee: downloading $Repo@$Branch"
  $zip = Join-Path $tmp "theme.zip"
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $root) { throw "The archive did not contain a repository folder." }

  foreach ($dir in @("themes", "layouts", "mods")) {
    $full = Join-Path $homeDir $dir
    if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Path $full | Out-Null }
  }

  Write-Host "==> Agentee: installing into $homeDir"
  foreach ($file in @("themes\agentee.json", "layouts\agentee.json", "layouts\agentee.svg")) {
    $src = Join-Path $root.FullName $file
    $dst = Join-Path $homeDir $file
    Backup $dst
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
  foreach ($mod in Get-ChildItem -LiteralPath (Join-Path $root.FullName "mods") -Directory -Filter "abdh-*" | Where-Object { $_.Name -notmatch '\.bak-' }) {
    $dst = Join-Path $homeDir ("mods\" + $mod.Name)
    Backup $dst
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
    Copy-Item -LiteralPath $mod.FullName -Destination $dst -Recurse -Force
  }

  # Editor keys: add the section, keep any chord the person already uses.
  $keysPath = Join-Path $homeDir "keys.json"
  $snippetPath = Join-Path $root.FullName "keys.snippet.json"
  if (Test-Path -LiteralPath $snippetPath) {
    Backup $keysPath
    $snippet = To-Hashtable (Get-Content -LiteralPath $snippetPath -Raw | ConvertFrom-Json)
    $keys = @{}
    if (Test-Path -LiteralPath $keysPath) {
      try { $keys = To-Hashtable (Get-Content -LiteralPath $keysPath -Raw | ConvertFrom-Json) }
      catch { Write-Warning "keys.json is not valid JSON; left it untouched ($keysPath)."; $keys = $null }
    }
    if ($null -ne $keys) {
      foreach ($section in $snippet.Keys) {
        if (-not $keys.ContainsKey($section) -or $keys[$section] -isnot [hashtable]) { $keys[$section] = @{} }
        foreach ($chord in $snippet[$section].Keys) {
          if (-not $keys[$section].ContainsKey($chord)) { $keys[$section][$chord] = $snippet[$section][$chord] }
        }
      }
      $json = $keys | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($keysPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    }
  }

  $exe = $null
  $cmd = Get-Command herdr-app -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
  elseif (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe")) {
    $exe = Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe"
  }

  $shipped = Test-Path -LiteralPath (Join-Path $homeDir "mods\workspace-chrome")
  if ($exe -and $shipped) {
    # The binary is GUI-subsystem: `& $exe` leaves $LASTEXITCODE empty, so run
    # it through Start-Process and read the process exit code.
    function Invoke-Herdr([string[]]$parts) {
      $args = $parts | ForEach-Object { if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
      $proc = Start-Process -FilePath $exe -ArgumentList $args -Wait -PassThru -WindowStyle Hidden
      return $proc.ExitCode
    }
    Write-Host "==> Agentee: checking mods"
    $failed = 0
    foreach ($mod in Get-ChildItem -LiteralPath (Join-Path $homeDir "mods") -Directory -Filter "abdh-*" | Where-Object { $_.Name -notmatch '\.bak-' }) {
      if ((Invoke-Herdr @("check", $mod.FullName)) -ne 0) { $failed += 1; Write-Warning "check failed: $($mod.Name)" }
    }
    if ($failed -eq 0) { Write-Host "    all Agentee mods pass" }

    if (-not $NoLayout) {
      if ((Invoke-Herdr @("do", "layout.switch", "--name", "agentee")) -eq 0) { Write-Host "==> Agentee: layout switched" }
      else { Write-Host "==> Agentee: open Herdr and run: herdr-app do layout.switch --name agentee" }
    }
  } elseif ($exe) {
    Write-Host "==> Agentee: start Herdr once (it installs its shipped mods), then: herdr-app check <each Agentee mod>"
  } else {
    Write-Host "==> Agentee: herdr-app not found; open Herdr and run: herdr-app do layout.switch --name agentee"
  }

  if ($backups.Count -gt 0) { Write-Host ("==> Agentee: backups (" + $backups.Count + ") - " + ($backups -join ", ")) }
  Write-Host "==> Agentee: done. Settings: $homeDir\abdh-settings.json (open Theme settings in the sidebar footer)."
}
catch {
  Write-Error "Agentee install failed: $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

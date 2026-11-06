---
name: agentee-install
description: Install or update the Agentee Herdr layout/theme on this machine from github.com/abdh01h/herdr-agentee-theme. Use when the person says install Agentee, set up the Agentee theme/layout, update their Herdr theme, or asks what to run to get it.
---

# Install Agentee for Herdr

Goal: install the Agentee layout, theme and mods into this machine's Herdr home,
verify them, and switch the layout. Report what changed.

Read the full brief when in doubt:
https://raw.githubusercontent.com/abdh01h/herdr-agentee-theme/main/AGENT_INSTALL.md

## Steps

1. Find the Herdr home: `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`,
   else `~/.config/herdr-app` (Windows: `C:\Users\<name>\.config\herdr-app`).
2. Run the installer for the OS.

   Windows:
   ```powershell
   powershell -NoProfile -Command "irm https://raw.githubusercontent.com/abdh01h/herdr-agentee-theme/main/install.ps1 | iex"
   ```

   macOS / Linux:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/abdh01h/herdr-agentee-theme/main/install.sh | sh
   ```

   It backs up replacements (`*.bak-<timestamp>`), installs `themes/agentee.json`,
   `layouts/agentee.*`, `mods/agentee-*`, merges `keys.snippet.json` without replacing
   existing chords, checks the mods, and switches layout when a window runs.
3. If piping is blocked, download and run the script file; if execution is
   blocked, install manually from a clone: copy theme/layout/mod folders and
   merge the key snippet, then verify.
4. Verify:
   ```sh
   herdr-app check <herdr-home>/mods/agentee-<each>
   herdr-app do layout.switch --name agentee
   herdr-app status      # layout "agentee", errors []
   ```
   Windows fallback binary: `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`.
5. Report the Herdr home, backups, checks, layout switch (or the exact pending
   command), and `<herdr-home>/agentee-settings.json`.

## Do not

- Edit `frame/` or Herdr's shipped mods; Herdr rewrites them.
- Delete themes or replace a key chord the person already uses.
- Enable telemetry, change unrelated settings, or claim installation/layout
  success without the `herdr-app status` output.
- Fabricate hardware values: CPU core temps need LibreHardwareMonitor; otherwise
  the card shows `temp unavailable`.

Rollback: restore the `*.bak-<timestamp>` entries and switch back with
`herdr-app do layout.switch --name <previous>`.

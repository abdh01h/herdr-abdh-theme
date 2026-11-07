# Agent install brief — Agentee Herdr theme

You are installing the **Agentee** layout/theme for Herdr on the person's machine.
Do it end to end, then report exactly what changed. Do not rewrite unrelated
Herdr settings or delete anything you did not create.

Repository: https://github.com/abdh01h/herdr-agentee-theme
Herdr home: `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`, else
`~/.config/herdr-app` (on Windows that is `C:\Users\<name>\.config\herdr-app`).

## 1. Preferred: run the installer

Windows (PowerShell 5.1+):

```powershell
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/abdh01h/herdr-agentee-theme/main/install.ps1 | iex"
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/abdh01h/herdr-agentee-theme/main/install.sh | sh
```

The installer downloads the repository, backs up what it replaces as
`*.bak-<timestamp>`, installs `themes/agentee.json`, `layouts/agentee.json` +
`agentee.svg`, all `mods/agentee-*`, merges `keys.snippet.json` into `keys.json`
without replacing existing chords, runs `herdr-app check` on each Agentee mod, and
switches to the layout when a window is running.

It also migrates a machine that ran the older `abdh` build: `mods/abdh-*` folders
are backed up and removed (so the layout never loads both), `abdh-settings.json`
moves to `agentee-settings.json`, `abdh-recovery/` moves to `agentee-recovery/`,
the stale `abdh-update/` staging folder is removed, and the old
`mod:abdh-editor` section is dropped from `keys.json`.

Useful options: `-HerdrHome <path>` / `HERDR_APP_HOME=<path>`,
`-Branch <name>` / `BRANCH=<name>`, `-NoLayout` / `NO_LAYOUT=1`.

If the person runs the agent with a tool that forbids piping scripts to a shell,
download the two files and run them instead — do not hand-edit the copies they
would install.

## 2. Check the result

```sh
herdr-app check <herdr-home>/mods/agentee-<name>   # every Agentee mod must pass
herdr-app do layout.switch --name agentee
herdr-app status                                 # expect layout "agentee", errors []
```

If `herdr-app` is not on PATH on Windows, use
`%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`.
If no window is running, say so and leave the command for when Herdr is open.

## 3. If the installer cannot run

Copy from a checkout/archive of this repository into the Herdr home:

- `themes/agentee.json` → `themes/`
- `layouts/agentee.json`, `layouts/agentee.svg` → `layouts/`
- every `mods/agentee-*` → `mods/` (replace those folders; keep backups)
- merge `keys.snippet.json` into `keys.json`, adding only chords the person
  does not already use
- on a machine that ran the old `abdh` build: back up and delete the `mods/abdh-*`
  folders, move `abdh-settings.json` to `agentee-settings.json` (and
  `abdh-recovery/` to `agentee-recovery/`), and delete the old `mod:abdh-editor`
  section from `keys.json`
- then run the checks and layout switch above

Never edit `frame/` (Herdr rewrites it at startup) and never edit Herdr's shipped
mods (`spaces`, `agents`, `menu`, `new-menu`, `pane`, `picker`) — the theme uses
its own `agentee-spaces`, `agentee-agents-list` and `agentee-new-menu`.

## 4. Report

- Herdr home used and the timestamped backups created
- mods installed and the `check` result
- whether the layout was switched, or the exact command left for the person
- settings file path: `<herdr-home>/agentee-settings.json`
- anything skipped (for example key merge without python3/node on Unix)

## Known limits (do not "fix" by inventing data)

- CPU core temperature needs LibreHardwareMonitor running (WMI); otherwise the
  panel says `temp unavailable`.
- Blame is whole-file and Diff is a separate view: `EditorState` has no cursor
  position or decorations.
- Remote (ssh) files open read-only.
- Herdr's own Settings → Look renders a card per theme file and can stall with a
  large library; use **Theme settings → Themes** (paged) instead.
- Do not claim the layout is active unless `herdr-app status` says so.

## Rollback

Restore the `*.bak-<timestamp>` files/folders created by the installer, then
`herdr-app do layout.switch --name <previous layout>` (or `ctrl-shift-l`).

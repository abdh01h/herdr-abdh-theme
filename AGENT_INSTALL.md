# Agent install brief — abdh Herdr theme

You are installing the **abdh** layout/theme for Herdr on the person's machine.
Do it end to end, then report exactly what changed. Do not rewrite unrelated
Herdr settings or delete anything you did not create.

Repository: https://github.com/abdh01h/herdr-abdh-theme
Herdr home: `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`, else
`~/.config/herdr-app` (on Windows that is `C:\Users\<name>\.config\herdr-app`).

## 1. Preferred: run the installer

Windows (PowerShell 5.1+):

```powershell
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.ps1 | iex"
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.sh | sh
```

The installer downloads the repository, backs up what it replaces as
`*.bak-<timestamp>`, installs `themes/abdh.json`, `layouts/abdh.json` +
`abdh.svg`, all `mods/abdh-*`, merges `keys.snippet.json` into `keys.json`
without replacing existing chords, runs `herdr-app check` on each abdh mod, and
switches to the layout when a window is running.

Useful options: `-HerdrHome <path>` / `HERDR_APP_HOME=<path>`,
`-Branch <name>` / `BRANCH=<name>`, `-NoLayout` / `NO_LAYOUT=1`.

If the person runs the agent with a tool that forbids piping scripts to a shell,
download the two files and run them instead — do not hand-edit the copies they
would install.

## 2. Check the result

```sh
herdr-app check <herdr-home>/mods/abdh-<name>   # every abdh mod must pass
herdr-app do layout.switch --name abdh
herdr-app status                                 # expect layout "abdh", errors []
```

If `herdr-app` is not on PATH on Windows, use
`%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`.
If no window is running, say so and leave the command for when Herdr is open.

## 3. If the installer cannot run

Copy from a checkout/archive of this repository into the Herdr home:

- `themes/abdh.json` → `themes/`
- `layouts/abdh.json`, `layouts/abdh.svg` → `layouts/`
- every `mods/abdh-*` → `mods/` (replace those folders; keep backups)
- merge `keys.snippet.json` into `keys.json`, adding only chords the person
  does not already use
- then run the checks and layout switch above

Never edit `frame/` (Herdr rewrites it at startup) and never edit Herdr's shipped
mods (`spaces`, `agents`, `menu`, `new-menu`, `pane`, `picker`) — the theme uses
its own `abdh-spaces` and `abdh-agents-list`.

## 4. Report

- Herdr home used and the timestamped backups created
- mods installed and the `check` result
- whether the layout was switched, or the exact command left for the person
- settings file path: `<herdr-home>/abdh-settings.json`
- anything skipped (for example key merge without python3/node on Unix)

## Known limits (do not "fix" by inventing data)

- CPU core temperature needs LibreHardwareMonitor running (WMI); otherwise the
  panel says `temp unavailable`.
- Blame is whole-file and Diff is a separate view: `EditorState` has no cursor
  position or decorations.
- Remote (ssh) files open read-only.
- Herdr's own Settings → Look renders a card per theme file and can stall with a
  large library; use **abdh settings → Themes** (paged) instead.
- Do not claim the layout is active unless `herdr-app status` says so.

## Rollback

Restore the `*.bak-<timestamp>` files/folders created by the installer, then
`herdr-app do layout.switch --name <previous layout>` (or `ctrl-shift-l`).

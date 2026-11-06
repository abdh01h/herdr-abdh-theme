---
name: agentee-herdr-theme
description: Work on the Agentee Herdr layout/theme in this repository — install it into ~/.config/herdr-app, verify it, change its Carbon palette, layout blocks, tabs, editor, or Files/Agents/System panels, and publish updates. Use when the user mentions Agentee, the Herdr theme/layout, its editor or panels, or asks to install/update this project.
---

# Agentee Herdr theme

This repo is a Herdr **layout bundle**: one layout + theme + the personal mods it
references. Herdr runs it from `~/.config/herdr-app` (`$HERDR_APP_HOME` overrides).

```
layouts/agentee.json      window tree (left rail, tabs, work area, right panel, status)
layouts/agentee.svg       layout picker preview
themes/agentee.json       Carbon palette (background/foreground/selection/cursor/ansi/colors)
mods/agentee-*            layout, panels, editor, tabs, settings, git, system probes
keys.snippet.json      keys.json section to merge (editor save/close)
preview.png, RECIPE.md publishing metadata
```

## Install or update on this machine

1. Copy `themes/agentee.json` to `~/.config/herdr-app/themes/`.
2. Copy `layouts/agentee.json` and `layouts/agentee.svg` to `~/.config/herdr-app/layouts/`.
3. Copy every `mods/agentee-*` folder to `~/.config/herdr-app/mods/` (replace).
4. Merge `keys.snippet.json` into `~/.config/herdr-app/keys.json` (do not drop
   existing sections; on conflict ask before replacing a user key).
5. Check each mod, then switch the layout:

```sh
for m in ~/.config/herdr-app/mods/agentee-*; do herdr-app check "$m"; done
herdr-app do layout.switch --name agentee
herdr-app status   # expect layout "agentee", errors []
```

Herdr rewrites `~/.config/herdr-app/frame/` at every start. Never fix things
there. Shipped mods (`spaces`, `agents`, `menu`, `new-menu`, `pane`, `picker`)
are rewritten too; `agentee-spaces` and `agentee-agents-list` are the editable forks.

## Where to change what

- **Palette / density**: `themes/agentee.json` (`background`, `foreground`,
  `selection`, 16 `ansi`, `colors` overrides such as `chrome`, `surface`,
  `raised`, `accent`, `border`, `done`, `blocked`). Panel colors that are not
  named there are derived by Herdr, so prefer named overrides.
- **Layout structure**: `layouts/agentee.json`. Keep ids unique — a collision
  between the sidebar `agents` block and a panel stack child once moved the
  token panel into the left rail (panel children are `panel-files`,
  `panel-agents`, `panel-system`). Root flags: `theme`, `movable: false`,
  `titlebar: "none"`, `traffic_lights`, `preview`.
- **Top-right tools / app tabs**: `mods/agentee-tabs/main.js` (`panelButton`,
  the Git button, plus button, active-tab styling). Panel selection uses
  `layout.show`/`layout.hide`/`layout.select` with `panel-body`.
- **Files**: `mods/agentee-explorer/main.js` — tree, dialogs, context menu,
  clipboard, search. When the editor is focused it roots the panel at the open
  file's git project (`rev-parse --show-toplevel`, fallback its folder), not the
  tab terminal's home. Keep search bounded (`git grep` in repos, `rg -j 2
  --max-depth 12` otherwise, content search off at `~`); unbounded scans spike
  the CPU.
- **Editor**: `mods/agentee-editor/main.js` — save/dirty, external-change flow,
  file tabs, `lineDiff`, blame hand-off, pane close. `EditorState` has no
  cursor/selection/decorations, so do not promise inline gutters or a Cut/Copy/Paste
  menu (a right press clears the selection; `dispatch_action` reaches Herdr's
  commands, not `input::*`).
- **Selection color**: the shell paints an unset editor selection with Base
  `accent` at 40 %, and the app maps `accent` from the theme's `hover`.
  `agentee-chrome` republishes Base tokens with `set_theme` from **gpui-base**
  (use `cx.theme().colors`, not `.tokens`). Keep that sync or selection becomes
  invisible. Colours read from `cx.theme().colors` lose their alpha, so the sync
  takes them from `theme()`; it also clears Base `border` to hide indent guides.
- **Editor gutter**: the line-number column is painted with Base `surface`; a
  light Base palette leaves a white strip beside dark code. `agentee-chrome` pins
  Base `surface`, `background`, `foreground` and `muted_foreground` from the
  running theme. Keep those pins when changing the sync.
- **Event handlers**: use the handler's own `cx`, never `render`'s (stale after
  render returns: clicks change state but never redraw).
- **Panels**: `agentee-agents` (`main.js` + `tokens.mjs`, tokens from agent session logs), `agentee-system`
  (`probes/windows.js`, `probes/linux.js`, `probes/macos.js`), `agentee-git`,
  `agentee-status`, `agentee-settings` (its own `agentee-settings.json`, paged themes),
  `agentee-menu`.
- **Git**: `agentee-git` has Changes (per-file Stage/Unstage, Stage all, commit
  message + Commit, click opens the file), Branches, History, New branch, Merge,
  and header Fetch/Pull/Push (Push is confirmed and needs an upstream). Commit
  only writes the index; stage uses `git add -A --`, unstage
  `git restore --staged --`. Theme settings → Git → Open as a tab
  (`agentee.settings.git.openInTab`, off by default) makes the Git button focus or
  create a Git tab in the active space instead of the dialog; the tab's X/Esc
  closes its pane. The status bar publishes the focused editor file's project
  root as `shared("agentee.project")`; Files, Git and the home space row use it, so
  keep that sync when changing any of them.

## Gotchas that already cost time

- Windows CPU raw counter is inverted: `usage = 100 − Δ(PercentProcessorTime)/Δt×100`.
- Real CPU temperature needs LibreHardwareMonitor (WMI) or admin ACPI; ACPI
  thermal-zone perf counters are ambient, not core temperature.
- Herdr Settings → Look renders a card per theme file and interrupts with a
  large library. Use the paged theme picker in `agentee-settings → Themes`.
- `movable: false` is intentional: it removes the pane grip that covered content.
- Dialog copies of the explorer must not start timers/watchers or consume shared
  commands, and menu commands are one-shot — otherwise reloads flood overlays.
- Remote (ssh) files are read-only in the editor.
- App/tab close writes dirty buffers to `~/.config/herdr-app/agentee-recovery/`.

## Verify before saying done

```sh
herdr-app check <mod dir>                     # every changed mod
herdr-app do layout.switch --name agentee
herdr-app status                              # layout + errors
herdr-app shot /tmp/agentee.png                  # visual proof
```

Exercise the changed surface: open a file and save it (mtime changes), select
text (highlight visible), toggle Diff on a modified file, switch panel icons,
search a repo for a string, and compare the System CPU reading with
`Get-Counter '\Processor(_Total)\% Processor Time'`.

## Publish an update

```sh
git add -A && git commit -m "..." && git push
```

Keep the GitHub topic `herdr-layout`, refresh `preview.png` when the look
changes, and update `RECIPE.md` with any behavior that changed.

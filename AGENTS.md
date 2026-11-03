# AGENTS.md — Agentee Herdr theme

This repository is a Herdr **layout bundle** (layout + theme + personal mods).

- **Installing or updating the theme on a machine**: read `AGENT_INSTALL.md` and
  follow it. The short version:
  Windows `powershell -NoProfile -Command "irm https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.ps1 | iex"`,
  macOS/Linux `curl -fsSL https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.sh | sh`,
  then `herdr-app do layout.switch --name agentee` and `herdr-app status`.
- **Changing the theme**: `RECIPE.md` documents the layout tree, mods and known
  traps. Verify with `herdr-app check <mod>` for every changed mod and a real
  window render (`herdr-app shot`).
- Do not edit `frame/` or Herdr's shipped mods (`spaces`, `agents`, `menu`,
  `new-menu`, `pane`, `picker`); `abdh-spaces` and `abdh-agents-list` are the
  editable forks.
- Never fabricate metrics: temperatures need LibreHardwareMonitor, blame is
  whole-file, diff is a separate view.
- Keep the published GitHub topic `herdr-layout`; update `preview.png` when the
  look changes.

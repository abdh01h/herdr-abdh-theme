// Platform dispatch for the System panel. The actual collectors take a `run`
// function so they can be exercised without Herdr; here it is the host's exec.

import { exec, window } from "herdr";
import { collectWindows } from "./probes/windows.js";
import { collectLinux } from "./probes/linux.js";
import { collectMacos } from "./probes/macos.js";

const run = (command, args) => exec(command, args);

/**
 * Samples the machine. `state` is a plain object the view owns; collectors use
 * it for deltas and for caching static information. Never throws: a failed
 * probe yields `errors` for the affected fields only.
 */
export async function collect(state, options = {}) {
  const platform = window()?.platform;
  try {
    if (platform === "windows") return await collectWindows(state, options, run);
    if (platform === "linux") return await collectLinux(state, options, run);
    if (platform === "macos") return await collectMacos(state, options, run);
    return {
      at: Date.now(),
      platform: platform || "unknown",
      errors: [`System monitor: unsupported platform "${platform || "unknown"}"`],
    };
  } catch (error) {
    return {
      at: Date.now(),
      platform: platform || "unknown",
      errors: [String(error && error.message ? error.message : error)],
    };
  }
}

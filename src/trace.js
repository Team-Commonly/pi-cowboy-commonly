// Opt-in diagnostics for walks: COMMONLY_PI_COWBOY_LOG=<absolute path> appends
// one JSON line per pi event the plugin sees and per post it makes. It records
// shapes and statuses only, never message text, task names or the token, so
// the file is safe to hand to whoever is debugging the walk.

import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const isObject = (v) => typeof v === "object" && v !== null;

/** @returns {((entry: object) => void) | undefined} */
export function openTrace(env) {
  const path = env.COMMONLY_PI_COWBOY_LOG?.trim();
  if (!path || !isAbsolute(path)) return undefined;
  return (entry) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, { mode: 0o600 });
    } catch {
      // Diagnostics must never affect the run.
    }
  };
}

/** The parts of an event that decide which lines it yields. */
export function eventShape(name, event) {
  const e = isObject(event) ? event : {};
  const shape = { event: name };
  if (typeof e.toolName === "string") shape.toolName = e.toolName;
  if (typeof e.isError === "boolean") shape.isError = e.isError;
  if (isObject(e.result)) {
    const details = e.result.details;
    shape.result = {
      keys: Object.keys(e.result).sort(),
      detailsKeys: isObject(details) ? Object.keys(details).sort() : null,
      agentStatuses: isObject(details) && Array.isArray(details.agents)
        ? details.agents.map((a) => (isObject(a) ? a.status ?? null : typeof a))
        : null,
    };
  }
  if (isObject(e.message)) {
    shape.message = { role: e.message.role ?? null, customType: e.message.customType ?? null };
  }
  return shape;
}

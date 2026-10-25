// pi-cowboy plugin: posts each subagent's start, hand-off and result to a
// Commonly pod. Off unless COMMONLY_AGENT_TOKEN and COMMONLY_POD_ID are set.
//
// pi-cowboy's plugin API has no subagent hooks of its own; it hands plugins
// pi's extension API as `api.pi`, and every lifecycle step is visible there:
//   start    tool_execution_start  for cowboy_agent
//   hand-off tool_execution_end    for cowboy_agent (background) and steer_cowboy_agent
//   result   tool_execution_end    for cowboy_agent (foreground), and
//            message_end           for the "subagent-result" message a background agent sends back

import { readConfig, postLine } from "./post.js";
import { onToolStart, onToolEnd, onMessageEnd } from "./lines.js";
import { openTrace, eventShape } from "./trace.js";

const DRAIN_MS = 3000;

/**
 * @param {{ pi: { on: (event: string, handler: Function) => (() => void) } }} api
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch }} [deps] for tests
 */
export function createPlugin(api, deps = {}) {
  const env = deps.env ?? process.env;
  const trace = openTrace(env);
  const config = readConfig(env);
  trace?.({ plugin: config ? "loaded" : "off: COMMONLY_AGENT_TOKEN or COMMONLY_POD_ID unset" });
  if (!config) return undefined;
  let queue = Promise.resolve();
  let warned = false;

  // A headless run (pi -p) has no UI, so ctx.ui.notify shows nothing there.
  // Fall back to stderr so a failing post is visible in every mode.
  const warn = (ctx, text) => {
    try {
      if (ctx?.hasUI !== false && typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(text, "warning");
        return;
      }
    } catch {
      // ctx can be stale after a session switch.
    }
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      // nowhere left to report
    }
  };

  // Posts go out one at a time so the pod reads in order. The handler returns
  // at once: pi awaits extension handlers, and a slow post must not slow a run.
  const send = (lines, ctx) => {
    for (const line of lines) {
      queue = queue.then(async () => {
        const res = await postLine(config, line, deps.fetch);
        trace?.({ post: res.ok ? "ok" : "failed", status: res.status ?? null });
        if (!res.ok && !warned) {
          warned = true;
          warn(ctx, `pi-cowboy-commonly: could not post to the pod${res.status ? ` (HTTP ${res.status})` : ""}; later posts fail silently`);
        }
      });
    }
  };

  const guard = (name, toLines) => (event, ctx) => {
    try {
      const lines = toLines(event);
      trace?.({ ...eventShape(name, event), lines: lines.length });
      send(lines, ctx);
    } catch {
      // Never let a formatting surprise reach pi.
    }
    return undefined;
  };

  const off = [
    api.pi.on("tool_execution_start", guard("tool_execution_start", onToolStart)),
    api.pi.on("tool_execution_end", guard("tool_execution_end", onToolEnd)),
    api.pi.on("message_end", guard("message_end", onMessageEnd)),
  ];

  return async () => {
    trace?.({ plugin: "disposed" });
    for (const unsubscribe of off) {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    }
    // Give queued posts (often the final result) a moment, but never hold up shutdown for long.
    await Promise.race([queue, new Promise((r) => setTimeout(r, DRAIN_MS).unref?.())]);
  };
}

export default function piCowboyCommonly(api) {
  return createPlugin(api);
}

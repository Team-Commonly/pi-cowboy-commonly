// Report guard: a pi extension that runs inside a pi-cowboy subagent and
// settles a run whose subagent ended without writing its report.
//
// Why it exists. pi-cowboy settles a run only when the subagent writes
// result.md in its staging directory; nothing else ends a run. Its read-only
// agent types (the built-in `explore`) are told never to create a file, and
// have no write or edit tool, while the same system prompt tells them to write
// result.md. When the model keeps the read-only rule, it ends its turn without a
// report and a foreground cowboy_agent call waits forever.
//
// What it does. pi-cowboy stays inert inside a subagent, so the pi-cowboy plugin
// never loads there; this file is declared under the package's `pi.extensions`
// and pi loads it into the subagent's pi like any installed extension. It acts
// only when all of these hold:
//   - this process is a pi-cowboy subagent (its argv carries pi-cowboy's own
//     `cowboy-subagent-<id>` marker and a --system-prompt file that names the
//     result file);
//   - pi reports `agent_settled`, not aborted: the run is over and pi has no
//     retry, compaction or queued message left to run;
//   - the subagent has no write or edit tool, so it may not be able to write
//     the report it was asked for;
//   - the result file is still missing or blank.
// Then it writes a notice to that file, which says plainly that the report is
// missing, and pi-cowboy settles through its own contract. The notice never
// invents a report: it quotes the subagent's last message unchanged, labelled
// as not being one. A report the subagent writes later replaces the notice and
// reaches the parent as a follow-up.
//
// In the parent session (no marker in argv) it registers nothing.

import fs from "node:fs";
import path from "node:path";

export const NOTICE_TITLE = "# No report: this subagent ended without writing one";

const TOKEN = /cowboy-subagent-([A-Za-z0-9_-]+)/;
const WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_QUOTE = 4000;
const FILE_MODE = 0o600; // pi-cowboy's own mode for files in the staging dir

const isObject = (v) => typeof v === "object" && v !== null;

/**
 * The subagent run this process belongs to, or undefined when it is not a
 * pi-cowboy subagent. The result file is the one pi-cowboy's system prompt
 * names, beside that prompt file; when the prompt does not name it, nothing is
 * claimed, so the guard can only ever write the file the subagent was told to.
 * @param {readonly string[]} argv
 * @param {(file: string, enc: string) => string} [readFile]
 * @returns {{ agentId: string, resultFile: string } | undefined}
 */
export function findSubagentRun(argv, readFile = fs.readFileSync) {
  if (!Array.isArray(argv)) return undefined;
  let agentId;
  for (const arg of argv) {
    const m = typeof arg === "string" ? TOKEN.exec(arg) : null;
    if (m) {
      agentId = m[1];
      break;
    }
  }
  if (!agentId) return undefined;
  const at = argv.indexOf("--system-prompt");
  const systemFile = at >= 0 ? argv[at + 1] : undefined;
  if (typeof systemFile !== "string" || !path.isAbsolute(systemFile)) return undefined;
  const resultFile = path.join(path.dirname(systemFile), "result.md");
  try {
    if (!String(readFile(systemFile, "utf8")).includes(resultFile)) return undefined;
  } catch {
    return undefined;
  }
  return { agentId, resultFile };
}

/** The subagent's tool names: pi's active set, else the --tools list in argv, else unknown. */
export function toolNames(pi, argv) {
  try {
    const names = pi.getActiveTools();
    if (Array.isArray(names)) return names.map(String);
  } catch {
    // fall through to argv
  }
  const at = Array.isArray(argv) ? argv.indexOf("--tools") : -1;
  if (at >= 0 && typeof argv[at + 1] === "string") return argv[at + 1].split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function textOf(message) {
  if (!isObject(message)) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((p) => isObject(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function howItEnded(last) {
  if (!isObject(last)) return "it ended before the model replied";
  if (last.stopReason === "error") {
    const why = typeof last.errorMessage === "string" ? last.errorMessage.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    return `its last model request failed${why ? `: ${why}` : ""}`;
  }
  if (last.stopReason === "length") return "the model stopped at its output limit";
  return "the model ended its turn";
}

/**
 * The file's text. States that the report is missing and quotes the subagent's
 * last message unchanged; it never summarises or completes anything.
 */
export function missingReportNotice({ agentId, last, tools }) {
  const quoted = textOf(last).trim();
  const cut = quoted.length > MAX_QUOTE;
  const body = cut ? quoted.slice(0, MAX_QUOTE) : quoted;
  const lines = [
    NOTICE_TITLE,
    "",
    "The subagent did not write this file. pi-cowboy-commonly wrote it because the",
    "subagent's run ended and the report it was asked to write here was still",
    "missing; without this file the parent would wait for it forever. Treat the",
    "task as not done.",
    "",
    `- Agent: ${agentId}`,
    `- How its run ended: ${howItEnded(last)}.`,
    `- Its tools: ${tools.length ? tools.join(", ") : "none"}. It has no write or edit tool; read-only agent types are told not to create files, so it may have declined to write this one.`,
    "",
  ];
  if (body) {
    lines.push(
      "Its last message, quoted unchanged. This is not a report: it may be incomplete, or a refusal.",
      "",
      ...body.split("\n").map((l) => (l ? `> ${l}` : ">")),
    );
    if (cut) lines.push("", `(Quote cut at ${MAX_QUOTE} characters.)`);
  } else {
    lines.push("It left no text message.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the notice unless a report is there. A non-blank file is never
 * touched. The notice goes to a temp file first and is linked into place, so
 * pi-cowboy never reads half of it, and a report that lands in the same
 * instant wins (the link fails with EEXIST).
 * @returns {"written" | "present" | "failed"}
 */
export function writeNoticeIfMissing(resultFile, text, fsImpl = fs) {
  try {
    if (fsImpl.readFileSync(resultFile, "utf8").trim() !== "") return "present";
  } catch {
    // missing: write it
  }
  const tmp = path.join(path.dirname(resultFile), `.result.md.no-report-${process.pid}`);
  try {
    fsImpl.writeFileSync(tmp, text, { encoding: "utf8", mode: FILE_MODE });
    try {
      fsImpl.linkSync(tmp, resultFile);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // A file appeared. Replace it only if it is still blank.
      if (fsImpl.readFileSync(resultFile, "utf8").trim() !== "") return "present";
      fsImpl.renameSync(tmp, resultFile);
    }
    return "written";
  } catch {
    return "failed";
  } finally {
    try {
      fsImpl.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * @param {{ on: (event: string, handler: Function) => (() => void), getActiveTools?: () => string[] }} pi
 * @param {{ argv?: readonly string[], fs?: typeof fs }} [deps] for tests
 */
export function createReportGuard(pi, deps = {}) {
  const argv = deps.argv ?? process.argv;
  const fsImpl = deps.fs ?? fs;
  // Cheap check first: the parent session has no marker and gets no handlers.
  if (!argv.some((a) => typeof a === "string" && TOKEN.test(a))) return undefined;

  let last; // the last assistant message of the latest low-level run
  const offs = [
    pi.on("agent_end", (event) => {
      try {
        const msgs = isObject(event) && Array.isArray(event.messages) ? event.messages : [];
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          if (isObject(msgs[i]) && msgs[i].role === "assistant") {
            last = msgs[i];
            break;
          }
        }
      } catch {
        // never reach pi
      }
      return undefined;
    }),
    pi.on("agent_settled", (event, ctx) => {
      try {
        // An aborted run was stopped by a person in the pane, who is driving it.
        if (!isObject(event) || event.aborted !== false) return undefined;
        const run = findSubagentRun(argv, fsImpl.readFileSync);
        if (!run) return undefined;
        const tools = toolNames(pi, argv);
        // Unknown tools, or an agent that can write its report: upstream's rule stands.
        if (!tools || tools.some((t) => WRITE_TOOLS.has(t))) return undefined;
        const outcome = writeNoticeIfMissing(run.resultFile, missingReportNotice({ agentId: run.agentId, last, tools }), fsImpl);
        if (outcome === "written") {
          try {
            if (ctx?.hasUI !== false) ctx?.ui?.notify?.("pi-cowboy-commonly: this agent ended without writing its report; the parent was told the report is missing.", "warning");
          } catch {
            // ctx can be stale
          }
        }
      } catch {
        // never reach pi
      }
      return undefined;
    }),
  ];
  return () => {
    for (const off of offs) {
      try {
        off?.();
      } catch {
        // ignore
      }
    }
  };
}

export default function reportGuard(pi) {
  createReportGuard(pi);
}

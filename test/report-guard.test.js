import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createReportGuard,
  findSubagentRun,
  missingReportNotice,
  writeNoticeIfMissing,
  NOTICE_TITLE,
} from "../src/report-guard.js";
import { onToolEnd, onMessageEnd } from "../src/lines.js";

const EXPLORE_TOOLS = ["read", "bash", "grep", "find"];

/** A pi-cowboy staging dir as a spawn leaves it: system.md naming result.md, prompt.md, no result. */
function stagedRun(id = "7K3M9QX2") {
  const dir = path.join(fs.mkdtempSync(path.join(tmpdir(), "pcc-guard-")), "pi-cowboy", id);
  fs.mkdirSync(dir, { recursive: true });
  const systemFile = path.join(dir, "system.md");
  const resultFile = path.join(dir, "result.md");
  fs.writeFileSync(systemFile, `# CRITICAL: READ-ONLY MODE\n\n## Your report\n\nWhen the task is done ... write your complete final answer, once, to the file:\n${resultFile}\n`);
  fs.writeFileSync(path.join(dir, "prompt.md"), "Read README.md and summarise it.");
  const argv = [
    "node", "/usr/bin/pi",
    "--system-prompt", systemFile,
    "--append-system-prompt", `cowboy-subagent-${id}`,
    "--name", id, "--no-context-files",
    "--tools", EXPLORE_TOOLS.join(","),
    "--approve", `@${path.join(dir, "prompt.md")}`,
  ];
  return { id, dir, systemFile, resultFile, argv };
}

function fakePi(tools = EXPLORE_TOOLS) {
  const handlers = new Map();
  return {
    handlers,
    getActiveTools: () => [...tools],
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    emit(name, event, ctx) {
      return handlers.get(name)?.(event, ctx);
    },
  };
}

const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });
const REFUSAL = "I am in strict read-only mode and have no write tool, so I cannot create result.md.\n\nREADME.md says the repo exists to test a subagent summary.";

/** pi-cowboy's own settlement test (deliverable.ts): a non-blank result file. */
const piCowboyWouldSettle = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim() !== "";
  } catch {
    return false;
  }
};

test("in the parent session (no subagent marker) the guard registers nothing", () => {
  const pi = fakePi();
  assert.equal(createReportGuard(pi, { argv: ["node", "/usr/bin/pi"] }), undefined);
  assert.equal(pi.handlers.size, 0);
});

test("findSubagentRun: the result file is the one pi-cowboy's system prompt names", () => {
  const run = stagedRun();
  assert.deepEqual(findSubagentRun(run.argv), { agentId: run.id, resultFile: run.resultFile });
  // No --system-prompt, a relative one, or a prompt that names no result file: nothing is claimed.
  assert.equal(findSubagentRun(run.argv.filter((a) => a !== "--system-prompt" && a !== run.systemFile)), undefined);
  assert.equal(findSubagentRun(run.argv.map((a) => (a === run.systemFile ? "system.md" : a))), undefined);
  fs.writeFileSync(run.systemFile, "a prompt with no report section");
  assert.equal(findSubagentRun(run.argv), undefined);
  assert.equal(findSubagentRun(["node", "pi"]), undefined);
  assert.equal(findSubagentRun(undefined), undefined);
});

test("KEY: an explore subagent that settles without a report gets a missing-report notice, so pi-cowboy settles", () => {
  const run = stagedRun();
  const pi = fakePi();
  const notes = [];
  createReportGuard(pi, { argv: run.argv });
  pi.emit("agent_start", { type: "agent_start" });
  pi.emit("agent_end", { type: "agent_end", messages: [{ role: "user", content: "task" }, assistant(REFUSAL)] });
  // agent_end alone is not the end: pi may still retry, compact or run queued work.
  assert.equal(fs.existsSync(run.resultFile), false, "nothing is written before pi reports the run settled");
  pi.emit("agent_settled", { type: "agent_settled", aborted: false }, { hasUI: true, ui: { notify: (m) => notes.push(m) } });

  assert.equal(piCowboyWouldSettle(run.resultFile), true);
  const text = fs.readFileSync(run.resultFile, "utf8");
  assert.ok(text.startsWith(`${NOTICE_TITLE}\n`), "the first line says the report is missing");
  assert.match(text, /The subagent did not write this file/);
  assert.match(text, /Treat the\ntask as not done/);
  assert.match(text, new RegExp(`Agent: ${run.id}`));
  assert.match(text, /How its run ended: the model ended its turn\./);
  assert.match(text, /This is not a report/);
  // The last message is quoted unchanged, line by line, and nothing else is claimed.
  assert.ok(text.includes("> I am in strict read-only mode and have no write tool, so I cannot create result.md.\n>\n> README.md says the repo exists to test a subagent summary."));
  assert.equal(fs.statSync(run.resultFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(run.dir).sort(), ["prompt.md", "result.md", "system.md"], "no temp file left behind");
  assert.equal(notes.length, 1);
});

test("a report the subagent wrote is never touched", () => {
  const run = stagedRun();
  fs.writeFileSync(run.resultFile, "# Report\nThe real answer.\n");
  const before = fs.readFileSync(run.resultFile);
  const pi = fakePi();
  createReportGuard(pi, { argv: run.argv });
  pi.emit("agent_end", { messages: [assistant("Done, wrote the report.")] });
  pi.emit("agent_settled", { aborted: false });
  assert.deepEqual(fs.readFileSync(run.resultFile), before);
});

test("a blank result file counts as missing, as pi-cowboy counts it", () => {
  const run = stagedRun();
  fs.writeFileSync(run.resultFile, "  \n");
  const pi = fakePi();
  createReportGuard(pi, { argv: run.argv });
  pi.emit("agent_end", { messages: [assistant("no report")] });
  pi.emit("agent_settled", { aborted: false });
  assert.ok(fs.readFileSync(run.resultFile, "utf8").startsWith(NOTICE_TITLE));
});

test("an aborted run, or a pi too old to say, is left alone", () => {
  for (const settled of [{ aborted: true }, {}]) {
    const run = stagedRun();
    const pi = fakePi();
    createReportGuard(pi, { argv: run.argv });
    pi.emit("agent_end", { messages: [assistant("stopped")] });
    pi.emit("agent_settled", settled);
    assert.equal(fs.existsSync(run.resultFile), false);
  }
});

test("an agent that has a write or edit tool keeps pi-cowboy's wait-for-a-report rule", () => {
  for (const tools of [["read", "bash", "edit", "write"], ["read", "write"], ["edit"]]) {
    const run = stagedRun();
    const pi = fakePi(tools);
    createReportGuard(pi, { argv: run.argv });
    pi.emit("agent_end", { messages: [assistant("forgot the report")] });
    pi.emit("agent_settled", { aborted: false });
    assert.equal(fs.existsSync(run.resultFile), false, `tools ${tools}`);
  }
});

test("tools fall back to argv --tools when pi cannot list them, and unknown tools mean no action", () => {
  const run = stagedRun();
  const pi = fakePi();
  pi.getActiveTools = () => {
    throw new Error("not available");
  };
  createReportGuard(pi, { argv: run.argv });
  pi.emit("agent_settled", { aborted: false });
  assert.ok(fs.readFileSync(run.resultFile, "utf8").startsWith(NOTICE_TITLE));

  const run2 = stagedRun();
  const pi2 = fakePi();
  delete pi2.getActiveTools;
  createReportGuard(pi2, { argv: run2.argv.filter((a, i, all) => a !== "--tools" && all[i - 1] !== "--tools") });
  pi2.emit("agent_settled", { aborted: false });
  assert.equal(fs.existsSync(run2.resultFile), false);
});

test("a second settle after the notice changes nothing", () => {
  const run = stagedRun();
  const pi = fakePi();
  createReportGuard(pi, { argv: run.argv });
  pi.emit("agent_end", { messages: [assistant("first")] });
  pi.emit("agent_settled", { aborted: false });
  const first = fs.readFileSync(run.resultFile);
  pi.emit("agent_end", { messages: [assistant("second")] });
  pi.emit("agent_settled", { aborted: false });
  assert.deepEqual(fs.readFileSync(run.resultFile), first);
});

test("notice wording for an error, a silent end and a long message", () => {
  const err = missingReportNotice({ agentId: "A", last: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate\nlimited" }, tools: ["read"] });
  assert.match(err, /How its run ended: its last model request failed: 429 rate limited\./);
  assert.match(err, /It left no text message\./);
  const none = missingReportNotice({ agentId: "A", last: undefined, tools: [] });
  assert.match(none, /it ended before the model replied/);
  assert.match(none, /Its tools: none\./);
  const long = missingReportNotice({ agentId: "A", last: assistant("x".repeat(5000)), tools: ["read"] });
  assert.match(long, /Quote cut at 4000 characters/);
  assert.ok(!long.includes("x".repeat(4001)));
});

test("writeNoticeIfMissing: a report that lands first wins the race", () => {
  const run = stagedRun();
  const realFs = fs;
  const racing = {
    ...realFs,
    readFileSync: realFs.readFileSync,
    writeFileSync: realFs.writeFileSync,
    rmSync: realFs.rmSync,
    renameSync: realFs.renameSync,
    linkSync: (from, to) => {
      realFs.writeFileSync(to, "# Report\nlanded meanwhile\n");
      return realFs.linkSync(from, to);
    },
  };
  assert.equal(writeNoticeIfMissing(run.resultFile, "notice", racing), "present");
  assert.equal(fs.readFileSync(run.resultFile, "utf8"), "# Report\nlanded meanwhile\n");
  assert.deepEqual(fs.readdirSync(run.dir).sort(), ["prompt.md", "result.md", "system.md"]);
});

test("writeNoticeIfMissing: a missing staging dir is a failure, never a new directory", () => {
  const gone = path.join(tmpdir(), `pcc-missing-${process.pid}`, "result.md");
  assert.equal(writeNoticeIfMissing(gone, "notice"), "failed");
  assert.equal(fs.existsSync(path.dirname(gone)), false);
});

test("handlers never throw into pi", () => {
  const run = stagedRun();
  const pi = fakePi();
  createReportGuard(pi, { argv: run.argv, fs: { ...fs, readFileSync: () => { throw new Error("boom"); } } });
  for (const v of [undefined, null, 3, {}, { messages: "x" }, { messages: [null, 1] }]) {
    assert.doesNotThrow(() => pi.emit("agent_end", v));
    assert.doesNotThrow(() => pi.emit("agent_settled", v));
  }
  assert.doesNotThrow(() => pi.emit("agent_settled", { aborted: false }, { ui: { notify: () => { throw new Error("stale"); } } }));
});

test("the pod line names a missing-report settlement, foreground and background", () => {
  const notice = missingReportNotice({ agentId: "7K3M9QX2", last: assistant(REFUSAL), tools: EXPLORE_TOOLS });
  const fg = onToolEnd({
    toolName: "cowboy_agent",
    isError: false,
    result: {
      content: [{ type: "text", text: `[Cowboy agent "explore" 7K3M9QX2 completed]\n\n${notice}` }],
      details: { agents: [{ type: "explore", description: "read readme", agentId: "7K3M9QX2", durationMs: 9_000 }] },
    },
  });
  assert.deepEqual(fg, ['explore agent 7K3M9QX2 "read readme" ended without a report in 9s']);
  const bg = onMessageEnd({
    message: {
      role: "custom",
      customType: "subagent-result",
      content: `[Cowboy agent "explore" 7K3M9QX2 completed]\n\n${notice}`,
      details: { type: "explore", description: "read readme", status: "completed" },
    },
  });
  assert.deepEqual(bg, ['explore agent 7K3M9QX2 "read readme" ended without a report']);
});

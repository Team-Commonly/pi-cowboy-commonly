import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlugin } from "../src/plugin.js";
import { readConfig, postLine } from "../src/post.js";
import { onToolStart, onToolEnd, onMessageEnd, clean } from "../src/lines.js";

const ENV = {
  COMMONLY_AGENT_TOKEN: "test-token",
  COMMONLY_POD_ID: "pod123",
  COMMONLY_API_URL: "https://api.example.test/",
};

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    emit(name, event, ctx) {
      return handlers.get(name)?.(event, ctx);
    },
  };
}

function fakeFetch({ status = 200, throws = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throws) throw new Error("network down");
    return { ok: status >= 200 && status < 300, status };
  };
  fn.calls = calls;
  return fn;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("does nothing when the env vars are unset", () => {
  const pi = fakePi();
  assert.equal(createPlugin({ pi }, { env: {} }), undefined);
  assert.equal(createPlugin({ pi }, { env: { COMMONLY_AGENT_TOKEN: "t" } }), undefined);
  assert.equal(createPlugin({ pi }, { env: { COMMONLY_POD_ID: "p" } }), undefined);
  assert.equal(pi.handlers.size, 0);
});

test("readConfig defaults the API URL and trims a trailing slash", () => {
  assert.equal(readConfig({ COMMONLY_AGENT_TOKEN: "t", COMMONLY_POD_ID: "p" }).apiUrl, "https://api.commonly.me");
  assert.equal(readConfig(ENV).apiUrl, "https://api.example.test");
});

test("postLine sends the runtime request with bearer auth and a non-default User-Agent", async () => {
  const fetch = fakeFetch();
  const res = await postLine(readConfig(ENV), "hello", fetch);
  assert.deepEqual(res, { ok: true, status: 200 });
  const [call] = fetch.calls;
  assert.equal(call.url, "https://api.example.test/api/agents/runtime/pods/pod123/messages");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer test-token");
  assert.match(call.init.headers["User-Agent"], /^pi-cowboy-commonly\//);
  assert.deepEqual(call.body, { content: "hello", continueAnyway: true });
});

test("User-Agent version matches package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const fetch = fakeFetch();
  await postLine(readConfig(ENV), "x", fetch);
  assert.equal(fetch.calls[0].init.headers["User-Agent"], `pi-cowboy-commonly/${pkg.version}`);
});

test("package name keeps the pi-cowboy- prefix pi-cowboy's discovery requires", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.ok(pkg.name.startsWith("pi-cowboy-"), "pi-cowboy only loads packages named pi-cowboy-*");
  assert.equal(pkg["pi-cowboy"].plugin, "./src/plugin.js");
  // pi loads a local package that has neither a pi manifest nor an extensions/
  // directory as one extension and requires the folder itself, which fails. An
  // empty list says the package carries no pi extensions; pi-cowboy loads the plugin.
  assert.deepEqual(pkg.pi, { extensions: [] }, "a plugin must not be declared under pi.extensions");
});

test("postLine never throws: network errors and HTTP errors both resolve", async () => {
  assert.deepEqual(await postLine(readConfig(ENV), "x", fakeFetch({ throws: true })), { ok: false });
  assert.deepEqual(await postLine(readConfig(ENV), "x", fakeFetch({ status: 403 })), { ok: false, status: 403 });
});

test("start: one line per agent in a cowboy_agent call", () => {
  const lines = onToolStart({
    toolName: "cowboy_agent",
    args: {
      agents: [
        { task_name: "fix login flow", agent_type: "explore", prompt: "long secret prompt" },
        { task_name: "write tests", agent_type: null, prompt: "..." },
      ],
      run_in_background: true,
    },
  });
  assert.deepEqual(lines, ['started explore agent "fix login flow"', 'started agent "write tests"']);
  assert.ok(!lines.join(" ").includes("secret"), "the prompt is never posted");
  assert.deepEqual(onToolStart({ toolName: "bash", args: { command: "ls" } }), []);
});

test("hand-off: background spawn and queue acknowledgements", () => {
  const lines = onToolEnd({
    toolName: "cowboy_agent",
    isError: false,
    result: {
      content: [{ type: "text", text: "[Agent spawned] ..." }],
      details: {
        agents: [
          { type: "explore", description: "fix login flow", agentId: "7K3M9QX2", status: "spawned", worktreeBranch: "cow/fix-login-flow-7k3m9qx2" },
          { type: "general-purpose", description: "write tests", agentId: "B1C2D3E4", status: "queued" },
        ],
      },
    },
  });
  assert.deepEqual(lines, [
    'handed off "fix login flow" to explore agent 7K3M9QX2 on cow/fix-login-flow-7k3m9qx2, running in the background',
    'handed off "write tests" to general-purpose agent B1C2D3E4, queued',
  ]);
});

test("hand-off: steer deliveries, refusals skipped", () => {
  const lines = onToolEnd({
    toolName: "steer_cowboy_agent",
    isError: false,
    result: {
      details: {
        agents: [
          { kind: "delivered", agentId: "7K3M9QX2" },
          { kind: "refused", agentId: "ZZZZZZZZ", reason: "unknown" },
        ],
      },
    },
  });
  assert.deepEqual(lines, ["handed new instructions to agent 7K3M9QX2"]);
});

test("result: foreground cowboy_agent settles inside the tool call", () => {
  const lines = onToolEnd({
    toolName: "cowboy_agent",
    isError: false,
    result: {
      content: [{ type: "text", text: '[Cowboy agent "explore" 7K3M9QX2 completed]\n\n# Report\nFound the redirect bug in auth.ts.\nMore detail...' }],
      details: { agents: [{ type: "explore", description: "fix login flow", agentId: "7K3M9QX2", durationMs: 72_000 }] },
    },
  });
  assert.deepEqual(lines, ['explore agent 7K3M9QX2 "fix login flow" completed in 1m 12s: Found the redirect bug in auth.ts.']);
});

test("result: foreground failure", () => {
  const lines = onToolEnd({
    toolName: "cowboy_agent",
    isError: true,
    result: { content: [{ type: "text", text: "agent 7K3M9QX2 stopped with an error: model unavailable" }] },
  });
  assert.deepEqual(lines, ["cowboy_agent call failed: agent 7K3M9QX2 stopped with an error: model unavailable"]);
});

test("result: background subagent-result message, each status", () => {
  const msg = (status, body) => ({
    message: {
      role: "custom",
      customType: "subagent-result",
      content: `[Cowboy agent "explore" 7K3M9QX2 ${status}]\n\n${body}`,
      details: { type: "explore", description: "fix login flow", status, durationMs: 5_000 },
    },
  });
  assert.deepEqual(onMessageEnd(msg("completed", "Fixed it.")), ['explore agent 7K3M9QX2 "fix login flow" completed in 5s: Fixed it.']);
  assert.deepEqual(onMessageEnd(msg("error", "")), ['explore agent 7K3M9QX2 "fix login flow" failed in 5s']);
  assert.deepEqual(onMessageEnd(msg("stopped", "")), ['explore agent 7K3M9QX2 "fix login flow" was stopped in 5s']);
  assert.deepEqual(onMessageEnd({ message: { role: "assistant", content: "hi" } }), []);
  assert.deepEqual(onMessageEnd({ message: { role: "custom", customType: "other", content: "x" } }), []);
});

test("result: a later report after settling", () => {
  const lines = onMessageEnd({
    message: {
      role: "custom",
      customType: "subagent-result",
      content: '[Cowboy agent "explore" 7K3M9QX2 reported again after settling]\n\nAlso fixed logout.',
      details: { type: "explore", description: "fix login flow", status: "completed" },
    },
  });
  assert.deepEqual(lines, ["explore agent 7K3M9QX2 reported again: Also fixed logout."]);
});

test("clean: single line, capped, and @mentions defused", () => {
  assert.equal(clean("a\n\n b"), "a b");
  assert.equal(clean("ping @sam now"), "ping @​sam now");
  assert.equal(clean("x".repeat(500)).length, 280);
});

test("odd input never throws", () => {
  for (const fn of [onToolStart, onToolEnd, onMessageEnd]) {
    for (const v of [undefined, null, 1, "x", {}, { toolName: "cowboy_agent" }, { toolName: "cowboy_agent", args: { agents: [null, 3] }, result: { details: { agents: "no" } } }]) {
      assert.doesNotThrow(() => fn(v));
    }
  }
});

test("plugin wiring: posts each event in order, returns at once, unsubscribes on dispose", async () => {
  const pi = fakePi();
  const fetch = fakeFetch();
  const dispose = createPlugin({ pi }, { env: ENV, fetch });
  assert.deepEqual([...pi.handlers.keys()].sort(), ["message_end", "tool_execution_end", "tool_execution_start"]);

  assert.equal(pi.emit("tool_execution_start", { toolName: "cowboy_agent", args: { agents: [{ task_name: "fix login flow", agent_type: "explore" }] } }), undefined);
  pi.emit("tool_execution_end", { toolName: "cowboy_agent", isError: false, result: { details: { agents: [{ type: "explore", description: "fix login flow", agentId: "7K3M9QX2", status: "spawned" }] } } });
  pi.emit("tool_execution_start", { toolName: "bash", args: {} });
  pi.emit("message_end", { message: { role: "custom", customType: "subagent-result", content: '[Cowboy agent "explore" 7K3M9QX2 completed]\n\nDone.', details: { type: "explore", description: "fix login flow", status: "completed" } } });

  await dispose();
  assert.deepEqual(fetch.calls.map((c) => c.body.content), [
    'started explore agent "fix login flow"',
    'handed off "fix login flow" to explore agent 7K3M9QX2, running in the background',
    'explore agent 7K3M9QX2 "fix login flow" completed: Done.',
  ]);
  assert.equal(pi.handlers.size, 0);
});

test("a failing post never breaks the run and warns once", async () => {
  const pi = fakePi();
  const fetch = fakeFetch({ status: 401 });
  const notes = [];
  const ctx = { ui: { notify: (m, k) => notes.push([m, k]) } };
  createPlugin({ pi }, { env: ENV, fetch });
  const ev = { toolName: "cowboy_agent", args: { agents: [{ task_name: "a" }, { task_name: "b" }] } };
  assert.doesNotThrow(() => pi.emit("tool_execution_start", ev, ctx));
  await settle();
  assert.equal(fetch.calls.length, 2);
  assert.equal(notes.length, 1);
  assert.match(notes[0][0], /HTTP 401/);
});

test("a throwing fetch and a throwing notify are both contained", async () => {
  const pi = fakePi();
  createPlugin({ pi }, { env: ENV, fetch: fakeFetch({ throws: true }) });
  const ctx = { ui: { notify: () => { throw new Error("stale ctx"); } } };
  assert.doesNotThrow(() => pi.emit("tool_execution_start", { toolName: "cowboy_agent", args: { agents: [{ task_name: "a" }] } }, ctx));
  await settle();
});

test("COMMONLY_PI_COWBOY_LOG records event shapes and post statuses, never text or the token", async () => {
  const { mkdtempSync, readFileSync: read, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const log = join(mkdtempSync(join(tmpdir(), "pcc-")), "trace.jsonl");
  const pi = fakePi();
  const fetch = fakeFetch({ status: 409 });
  const dispose = createPlugin({ pi }, { env: { ...ENV, COMMONLY_PI_COWBOY_LOG: log }, fetch });
  pi.emit("tool_execution_start", { toolName: "cowboy_agent", args: { agents: [{ task_name: "secret task name", agent_type: "explore" }] } });
  pi.emit("tool_execution_end", { toolName: "cowboy_agent", isError: false, result: { content: [{ type: "text", text: "private result" }], details: { agents: [{ type: "explore", description: "secret task name", agentId: "7K3M9QX2", status: "spawned" }] } } });
  pi.emit("message_end", { message: { role: "assistant", content: "private reply" } });
  await dispose();

  const raw = read(log, "utf8");
  for (const leak of ["secret task name", "private result", "private reply", "test-token"]) {
    assert.equal(raw.includes(leak), false, `${leak} leaked into the trace`);
  }
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  // Events are logged as they arrive; posts land after, in send order.
  assert.deepEqual(rows.filter((r) => r.plugin || r.event).map((r) => r.plugin ?? r.event), [
    "loaded", "tool_execution_start", "tool_execution_end", "message_end", "disposed",
  ]);
  const end = rows.find((r) => r.event === "tool_execution_end");
  assert.deepEqual(end.result, { keys: ["content", "details"], detailsKeys: ["agents"], agentStatuses: ["spawned"] });
  assert.equal(end.lines, 1);
  const msg = rows.find((r) => r.event === "message_end");
  assert.deepEqual(msg.message, { role: "assistant", customType: null });
  assert.equal(msg.lines, 0);
  assert.equal(rows.filter((r) => r.post === "failed").length, 2);
  assert.ok(rows.every((r) => typeof r.pid === "number"));
});

test("a relative COMMONLY_PI_COWBOY_LOG is ignored", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pcc-rel-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const pi = fakePi();
    createPlugin({ pi }, { env: { ...ENV, COMMONLY_PI_COWBOY_LOG: "trace.jsonl" }, fetch: fakeFetch() });
    pi.emit("tool_execution_start", { toolName: "cowboy_agent", args: { agents: [{ task_name: "a" }] } });
    await settle();
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("headless (no UI): a failing post warns once on stderr", async () => {
  const pi = fakePi();
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    createPlugin({ pi }, { env: ENV, fetch: fakeFetch({ status: 429 }) });
    const ctx = { hasUI: false, ui: { notify: () => { throw new Error("must not be used headless"); } } };
    pi.emit("tool_execution_start", { toolName: "cowboy_agent", args: { agents: [{ task_name: "a" }, { task_name: "b" }] } }, ctx);
    await settle();
  } finally {
    process.stderr.write = orig;
  }
  const ours = writes.filter((w) => w.includes("pi-cowboy-commonly"));
  assert.equal(ours.length, 1);
  assert.match(ours[0], /HTTP 429/);
});

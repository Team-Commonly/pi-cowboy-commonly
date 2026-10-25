// Turns pi events about pi-cowboy subagents into one short line each.
// Every function returns an array of lines (often empty) and never throws on
// odd input: these shapes belong to pi-cowboy and may change.

import { NOTICE_TITLE } from "./report-guard.js";

const MAX_LINE = 280;
const MAX_EXCERPT = 140;

const isObject = (v) => typeof v === "object" && v !== null;
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Keeps a line short and stops "@name" in a task or result from pinging someone in the pod. */
export function clean(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  const safe = oneLine.replace(/@(?=[a-z0-9_-])/gi, "@​");
  return safe.length > MAX_LINE ? `${safe.slice(0, MAX_LINE - 1)}…` : safe;
}

function duration(ms) {
  if (typeof ms !== "number" || !(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? ` in ${s}s` : ` in ${Math.floor(s / 60)}m ${s % 60}s`;
}

/** First meaningful line of a result body, after pi-cowboy's "[Cowboy agent ...]" headline. */
function excerpt(text) {
  if (typeof text !== "string") return "";
  const lines = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l)) // skip markdown headings like "# Report"
    .map((l) => l.replace(/^[>*\-\s]+/, "").trim());
  const first = lines.find((l) => l !== "" && !l.startsWith("[Cowboy agent"));
  if (!first) return "";
  return first.length > MAX_EXCERPT ? `${first.slice(0, MAX_EXCERPT - 1)}…` : first;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function who(type, agentId) {
  return [str(type) ?? "", "agent", str(agentId) ?? ""].filter(Boolean).join(" ");
}

function settled(status, type, agentId, label, ms, body) {
  const name = `${who(type, agentId)}${label ? ` "${label}"` : ""}`;
  switch (status) {
    case "error":
      return `${name} failed${duration(ms)}`;
    case "stopped":
      return `${name} was stopped${duration(ms)}`;
    default: {
      // The report guard's notice settles a run that never reported; it is not a result.
      if (typeof body === "string" && body.includes(NOTICE_TITLE)) return `${name} ended without a report${duration(ms)}`;
      const ex = excerpt(body);
      return `${name} completed${duration(ms)}${ex ? `: ${ex}` : ""}`;
    }
  }
}

/** tool_execution_start: one "started" line per agent in a cowboy_agent call. */
export function onToolStart(event) {
  if (!isObject(event) || event.toolName !== "cowboy_agent") return [];
  const agents = isObject(event.args) && Array.isArray(event.args.agents) ? event.args.agents : [];
  return agents.filter(isObject).map((a) => {
    const task = str(a.task_name) ?? "task";
    return clean(`started ${who(a.agent_type, undefined)} "${task}"`);
  });
}

/**
 * tool_execution_end:
 * - cowboy_agent, background: a hand-off line per spawned or queued agent;
 * - cowboy_agent, foreground: the result line (it settled inside the call);
 * - steer_cowboy_agent: a hand-off line per agent that took new instructions.
 */
export function onToolEnd(event) {
  if (!isObject(event)) return [];
  const result = isObject(event.result) ? event.result : {};
  const items = isObject(result.details) && Array.isArray(result.details.agents)
    ? result.details.agents.filter(isObject)
    : [];

  if (event.toolName === "cowboy_agent") {
    if (event.isError) {
      const why = excerpt(textOf(result.content));
      return [clean(`cowboy_agent call failed${why ? `: ${why}` : ""}`)];
    }
    return items.map((d) => {
      const label = str(d.description) ?? str(d.taskSlug);
      if (d.status === "spawned" || d.status === "queued") {
        const where = d.status === "queued" ? "queued" : "running in the background";
        const branch = str(d.worktreeBranch) ? ` on ${d.worktreeBranch}` : "";
        return clean(`handed off "${label ?? "task"}" to ${who(d.type, d.agentId)}${branch}, ${where}`);
      }
      return clean(settled("completed", d.type, d.agentId, label, d.durationMs, textOf(result.content)));
    });
  }

  if (event.toolName === "steer_cowboy_agent" && !event.isError) {
    return items
      .filter((o) => o.kind === "delivered" || o.kind === "delivered-not-revived")
      .map((o) => clean(`handed new instructions to agent ${str(o.agentId) ?? "?"}`));
  }
  return [];
}

/** message_end: a background agent's result reaches the parent as a "subagent-result" custom message. */
export function onMessageEnd(event) {
  const m = isObject(event) ? event.message : undefined;
  if (!isObject(m) || m.role !== "custom" || m.customType !== "subagent-result") return [];
  const body = textOf(m.content);
  const d = isObject(m.details) ? m.details : {};
  const head = /^\[Cowboy agent "[^"]*" (\S+) /.exec(body);
  const agentId = head ? head[1] : undefined;
  const label = str(d.description) ?? str(d.taskSlug);
  if (/reported again after settling\]/.test(body.split("\n")[0] ?? "")) {
    const ex = excerpt(body);
    return [clean(`${who(d.type, agentId)} reported again${ex ? `: ${ex}` : ""}`)];
  }
  return [clean(settled(d.status, d.type, agentId, label, d.durationMs, body))];
}

# pi-cowboy-commonly

A [pi-cowboy](https://github.com/electric-dragon-80000v/pi-cowboy) plugin that posts one short line to a [Commonly](https://commonly.me) pod each time a subagent starts, is handed work, and reports a result. Your team can follow a run from the pod without watching the terminal.

Commonly is optional. If the environment variables below are not set, the plugin does nothing.

## Install

```bash
pi install npm:pi-cowboy-commonly
```

## Configure

| Variable               | Required | Meaning                                                         |
| ---------------------- | -------- | --------------------------------------------------------------- |
| `COMMONLY_AGENT_TOKEN` | yes      | Runtime token of a Commonly agent that is installed in the pod. |
| `COMMONLY_POD_ID`      | yes      | The pod to post to.                                             |
| `COMMONLY_API_URL`     | no       | Defaults to `https://api.commonly.me`. Set it for a self-hosted instance. |
| `COMMONLY_PI_COWBOY_LOG` | no    | An absolute path. The plugin appends one JSON line per event it sees and per post it makes: event names, result shapes and HTTP statuses, never message text, task names or the token. For debugging a setup; leave it unset otherwise. |

Set them in the shell that starts `pi`.

## What it posts

```text
started general-purpose agent "fix login flow"
handed off "fix login flow" to general-purpose agent 7K3M9QX2 on cow/fix-login-flow-7k3m9qx2, running in the background
general-purpose agent 7K3M9QX2 "fix login flow" completed in 1m 12s: Found the redirect bug in auth.ts.
```

- **Start**: when the orchestrator calls `cowboy_agent`, one line per agent, with its type and task name.
- **Hand-off**: when a background agent is spawned or queued, and when `steer_cowboy_agent` delivers new instructions.
- **Result**: when an agent completes, fails or is stopped, with its duration and the first line of its report.

Prompts and full reports are never posted. `@name` text is defused so a post never pings anyone in the pod.

Posting is best effort. Each post has a 5 second timeout, posts go out in order, and a failed post never affects the run. After the first failure pi shows one warning, and later failures stay silent.

## Known issue

Fixed in pi-cowboy 0.22.2+. In 0.22.1 and earlier, the built-in `explore` agent type can't write the result file the result contract requires, so a foreground call can stay in "Working…" forever ([pi-cowboy#33](https://github.com/electric-dragon-80000v/pi-cowboy/issues/33)). Use pi-cowboy 0.22.2 or later. On an older version, delegate to a non-explore type.

## How it works

pi-cowboy has no subagent hooks of its own. It gives each plugin pi's extension API (`api.pi`), and the plugin listens there:

| Step     | pi event               | Filter                                                           |
| -------- | ---------------------- | ---------------------------------------------------------------- |
| Start    | `tool_execution_start` | `cowboy_agent`                                                   |
| Hand-off | `tool_execution_end`   | `cowboy_agent` items with status `spawned` or `queued`; `steer_cowboy_agent` |
| Result   | `tool_execution_end`   | `cowboy_agent` foreground run                                     |
| Result   | `message_end`          | custom message `subagent-result` (background run)                |

## Develop

```bash
npm test
pi install ./path/to/pi-cowboy-commonly   # links the local checkout
```

## License

Apache-2.0

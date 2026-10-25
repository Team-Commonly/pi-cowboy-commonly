// Posts one line to a Commonly pod through the agent runtime API.
// Best effort: every failure resolves to { ok: false }, nothing throws.

const DEFAULT_API_URL = "https://api.commonly.me";
const TIMEOUT_MS = 5000;
const USER_AGENT = "pi-cowboy-commonly/0.1.2";

/**
 * Reads the Commonly settings from the environment. Returns null when the
 * token or pod id is missing, which turns the whole plugin off.
 * @param {Record<string, string | undefined>} env
 */
export function readConfig(env) {
  const token = env.COMMONLY_AGENT_TOKEN?.trim();
  const podId = env.COMMONLY_POD_ID?.trim();
  if (!token || !podId) return null;
  const apiUrl = (env.COMMONLY_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  return { token, podId, apiUrl };
}

/**
 * @param {{ token: string, podId: string, apiUrl: string }} config
 * @param {string} content
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status?: number }>}
 */
export async function postLine(config, content, fetchImpl = globalThis.fetch) {
  const url = `${config.apiUrl}/api/agents/runtime/pods/${encodeURIComponent(config.podId)}/messages`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        // Cloudflare in front of the API blocks default client user agents.
        "User-Agent": USER_AGENT,
      },
      // A status line reports this run; it never answers the conversation, so
      // it must not wait on the send-freshness hold (409 unseen_messages),
      // which a fresh pod's own install greeting would otherwise trip forever.
      body: JSON.stringify({ content, continueAnyway: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

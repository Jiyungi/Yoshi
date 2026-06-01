/**
 * rover.js  (imported by background.js)
 *
 * Rover integration via the Agent-to-Web (A2W) cloud API:
 *   POST https://agent.rtrvr.ai/v1/a2w/runs   { url, prompt }
 *   then poll the returned run link until terminal.
 *
 * This is the reliable headless path (confirmed against rtrvr.ai/openapi/
 * a2w.yaml): it runs in Rover's cloud and returns a structured result, with
 * no in-page widget bridge to reverse-engineer.
 *
 * Auth: Bearer <ROVER_API token> (roverApiToken in config).
 *
 * Note: cloud runs use a fresh logged-out browser, so we pass the post text
 * IN the prompt for classification rather than relying on Rover to read the
 * user's authenticated feed. Page actions (Not interested) stay local.
 */

const ROVER_DEFAULTS = {
  roverEnabled: false,
  roverApiToken: "",
  roverApiBase: "https://agent.rtrvr.ai"
};

function getRoverCfg() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(ROVER_DEFAULTS, (s) =>
      resolve({ ...ROVER_DEFAULTS, ...s })
    );
  });
}

export function isRoverConfigured(cfg) {
  return Boolean(cfg && cfg.roverEnabled && cfg.roverApiToken);
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

/**
 * Runs a Rover A2W cloud task and returns the parsed result.
 * @param {string} prompt natural-language instruction (include the data inline)
 * @param {string} url    a target URL for context (defaults to linkedin.com)
 * @returns {Promise<{ok:boolean, status:string, json?:object, summary?:string, error?:string}>}
 */
export async function roverCloudRun(prompt, url = "https://www.linkedin.com/feed/") {
  const cfg = await getRoverCfg();
  if (!isRoverConfigured(cfg)) return { ok: false, status: "not-configured" };

  const base = cfg.roverApiBase || "https://agent.rtrvr.ai";
  const auth = { Authorization: `Bearer ${cfg.roverApiToken}` };

  let createResp;
  try {
    createResp = await fetch(`${base}/v1/a2w/runs`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Prefer: "execution=cloud, wait=20"
      },
      body: JSON.stringify({ url, prompt, execution: { preference: "cloud" } })
    });
  } catch (e) {
    return { ok: false, status: "network-error", error: String(e && e.message) };
  }

  if (!createResp.ok && createResp.status !== 202 && createResp.status !== 200) {
    return { ok: false, status: `http-${createResp.status}` };
  }

  const created = await createResp.json().catch(() => null);
  if (!created) return { ok: false, status: "bad-response" };

  // If it already finished within the wait window, use it.
  let run = created;
  const pollHref =
    (created.links && created.links.poll && created.links.poll.href) ||
    (created.links && created.links.self && created.links.self.href) ||
    created.run;

  // Poll until terminal (cap ~5 tries x ~10s server-side wait).
  for (let i = 0; i < 5 && run && !TERMINAL.has(run.status); i++) {
    if (!pollHref) break;
    try {
      const r = await fetch(pollHref, {
        headers: { ...auth, Accept: "application/json", Prefer: "wait=10" }
      });
      run = await r.json();
    } catch (e) {
      break;
    }
  }

  const result = run && run.result;
  return {
    ok: Boolean(run && run.status === "completed"),
    status: (run && run.status) || "unknown",
    json: result && result.json,
    summary: result && result.summary,
    error: (run && run.error) || (result && result.error)
  };
}

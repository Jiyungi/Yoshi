/**
 * background.js  (service worker, module)
 *
 * Responsibilities:
 *  1. Optional LLM classification of borderline posts via an OpenAI-compatible
 *     provider (Nebius AI Cloud, NEAR AI, or OpenAI). OFF by default.
 *  2. Agent memory via InsForge: log decisions, track muted authors so their
 *     future posts auto-hide. Falls back to local storage if not configured.
 *
 * With LLM disabled and InsForge unconfigured, the extension is fully local
 * and makes zero network requests.
 */

import {
  logDecision,
  getDecisions,
  getMutedAuthors,
  muteAuthor
} from "./src/insforge.js";
import { roverCloudRun } from "./src/rover.js";

console.log("[FeedDeclutter] background service worker started");

const DEFAULTS = {
  useLlm: false,
  provider: "nebius", // "nebius" | "near" | "openai"
  apiKey: "",
  model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
  apiBaseOverride: "",
  dailyCallCap: 500 // hard ceiling on LLM calls per day; cost safety
};

// --- Auto-load packaged config.json into storage ------------------
// config.json is gitignored and optional. When present, its values seed
// chrome.storage so the user never has to type keys into the popup.
// Loaded once on install and on browser startup. The popup can still
// override these live afterwards.

async function seedConfigFromFile() {
  let cfg;
  try {
    const url = chrome.runtime.getURL("src/config.json");
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log("[FeedDeclutter] no config.json (HTTP", resp.status + ")");
      return;
    }
    cfg = await resp.json();
  } catch (e) {
    console.log("[FeedDeclutter] config.json load failed:", e.message);
    return; // missing or invalid — fall back to popup/defaults
  }
  if (!cfg || typeof cfg !== "object") return;

  // Only seed keys we recognize; don't clobber with undefined.
  const allowed = [
    "useLlm", "provider", "apiKey", "model", "apiBaseOverride",
    "dailyCallCap", "insforgeUrl", "insforgeKey",
    "enabled", "threshold", "action",
    "roverEnabled", "roverApiToken", "roverApiBase"
  ];
  const toSet = {};
  for (const k of allowed) {
    if (cfg[k] !== undefined) toSet[k] = cfg[k];
  }
  if (Object.keys(toSet).length) {
    await new Promise((resolve) =>
      chrome.storage.sync.set(toSet, () => resolve())
    );
    console.log("[FeedDeclutter] seeded config keys:", Object.keys(toSet).join(", "));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[FeedDeclutter] onInstalled");
  seedConfigFromFile();
});
chrome.runtime.onStartup.addListener(() => seedConfigFromFile());
// Also seed immediately when the worker first spins up, so a manual
// reload of the worker (without reinstall) still picks up config.
seedConfigFromFile();

// --- Daily LLM call budget ----------------------------------------
// Tracked in chrome.storage.local so a runaway loop can never run up the
// Nebius bill. At ~0.02-0.03 cents/call, 500/day stays well under $1/day.

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function getBudget() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ fd_llm_budget: { date: "", count: 0 } }, (s) =>
      resolve(s.fd_llm_budget)
    );
  });
}

function setBudget(budget) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ fd_llm_budget: budget }, () => resolve());
  });
}

// Returns true if a call is allowed and reserves one; false if cap reached.
async function reserveCall(cap) {
  const today = todayKey();
  const budget = await getBudget();
  const current = budget.date === today ? budget.count : 0;
  if (current >= cap) return false;
  await setBudget({ date: today, count: current + 1 });
  return true;
}

// OpenAI-compatible base URLs per provider.
const PROVIDER_BASES = {
  nebius: "https://api.studio.nebius.ai/v1",
  near: "https://api.near.ai/v1",
  openai: "https://api.openai.com/v1"
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (stored) =>
      resolve({ ...DEFAULTS, ...stored })
    );
  });
}

const SYSTEM_PROMPT =
  "You score LinkedIn posts for how strongly they read as AI-generated, " +
  "humblebrag/self-congratulatory, or low-signal engagement-bait. " +
  "Reply with ONLY a number from 0 to 1 (e.g. 0.82). " +
  "1 = textbook AI/humblebrag/bait, 0 = a genuine substantive post.";

async function scoreWithLlm(text) {
  const s = await getSettings();
  if (!s.useLlm || !s.apiKey) return null;

  // Cost safety: never exceed the daily call cap.
  const allowed = await reserveCall(s.dailyCallCap || DEFAULTS.dailyCallCap);
  if (!allowed) return null;

  const base = s.apiBaseOverride || PROVIDER_BASES[s.provider] || PROVIDER_BASES.nebius;

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.apiKey}`
    },
    body: JSON.stringify({
      model: s.model,
      temperature: 0,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text }
      ]
    })
  });

  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content ?? "";
  const num = parseFloat(String(raw).match(/[0-1](?:\.\d+)?/)?.[0] ?? "");
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : null;
}

// Structured deep classification via the LLM (Nebius). Returns a parsed
// object: { category, isLowSignal, confidence, summary, redFlags }.
// This powers the "Why?" panel reliably (the in-page Rover agent is blocked
// by LinkedIn's CSP, so we use the same LLM that scores posts).
const CLASSIFY_SYSTEM =
  "You analyze a LinkedIn post and classify it. Reply with ONLY compact JSON, " +
  "no prose, no code fences. Keys: " +
  'category (one of: humblebrag, job-announcement, award, graduation, ' +
  "engagement-bait, ad, ai-generated, genuine), isLowSignal (boolean), " +
  "confidence (0..1), summary (max 8 words), redFlags (array of short strings).";

async function classifyDeep(text) {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: "no-api-key" };
  const allowed = await reserveCall(s.dailyCallCap || DEFAULTS.dailyCallCap);
  if (!allowed) return { ok: false, error: "daily-cap" };

  const base = s.apiBaseOverride || PROVIDER_BASES[s.provider] || PROVIDER_BASES.nebius;
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: String(text || "").slice(0, 2000) }
        ]
      })
    });
  } catch (e) {
    return { ok: false, error: "network" };
  }
  if (!resp.ok) return { ok: false, error: `http-${resp.status}` };
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content ?? "";
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "no-json" };
  try {
    return { ok: true, status: "completed", json: JSON.parse(m[0]) };
  } catch (e) {
    return { ok: false, error: "bad-json" };
  }
}

// --- Message router ------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "fd-llm-score":
      scoreWithLlm(msg.text)
        .then((score) => sendResponse({ ok: score !== null, score }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "fd-log-decision":
      logDecision(msg.entry)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "fd-get-muted":
      getMutedAuthors()
        .then((authors) => sendResponse({ ok: true, authors }))
        .catch(() => sendResponse({ ok: true, authors: [] }));
      return true;

    case "fd-mute-author":
      // Persist the mute. The "act on LinkedIn" step (Not interested) is
      // driven by the content script via the Rover bridge after booting.
      muteAuthor(msg.author)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case "fd-boot-rover":
      // Deprecated widget-boot path replaced by the A2W cloud API.
      sendResponse({ ok: false, reason: "use-cloud-run" });
      return true;

    case "fd-rover-run":
      // Run a Rover A2W cloud task (classification / triage) and return the
      // parsed result to the content script.
      roverCloudRun(msg.prompt, msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, status: "error", error: String(e && e.message) }));
      return true;

    case "fd-deep-classify":
      // Structured "Why?" classification. Tries Rover cloud first; if Rover is
      // unavailable/blocked, falls back to the LLM (Nebius) for the same JSON.
      (async () => {
        try {
          const rover = await roverCloudRun(msg.prompt, msg.url);
          if (rover && rover.ok && rover.json) {
            sendResponse({ ok: true, source: "rover", json: rover.json });
            return;
          }
        } catch (e) { /* fall through */ }
        const llm = await classifyDeep(msg.text);
        sendResponse(
          llm && llm.ok
            ? { ok: true, source: "nebius", json: llm.json }
            : { ok: false, error: (llm && llm.error) || "failed" }
        );
      })();
      return true;

    case "fd-get-digest":
      getDecisions(msg.limit || 50)
        .then((rows) => sendResponse({ ok: true, rows }))
        .catch(() => sendResponse({ ok: true, rows: [] }));
      return true;

    default:
      return;
  }
});

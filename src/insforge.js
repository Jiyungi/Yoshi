/**
 * insforge.js  (imported by background.js)
 *
 * Thin client for an InsForge backend (PostgREST-style REST API):
 *   {projectUrl}/api/database/records/{table}
 *
 * This is the "agent memory" layer:
 *   - decisions: an audit log of every filter decision (for the demo digest)
 *   - muted_authors: authors the user muted; their future posts auto-hide
 *
 * Degrades gracefully: if InsForge isn't configured, everything falls back
 * to chrome.storage.local so the demo always works, on stage, offline.
 *
 * One-time setup the user does in the popup:
 *   projectUrl  e.g. https://<appkey>.<region>.insforge.app
 *   apiKey      the project access key (kept in background only)
 *
 * Tables to create once in the InsForge dashboard (or via CLI):
 *   decisions(author text, text text, score float8, action text, reasons text, created_at timestamptz default now())
 *   muted_authors(author text, created_at timestamptz default now())
 */

const LOCAL_MUTED_KEY = "fd_local_muted_authors";
const LOCAL_DECISIONS_KEY = "fd_local_decisions";

function getCfg() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { insforgeUrl: "", insforgeKey: "" },
      (s) => resolve(s)
    );
  });
}

function isConfigured(cfg) {
  return Boolean(cfg.insforgeUrl && cfg.insforgeKey);
}

function recordsUrl(cfg, table) {
  return `${cfg.insforgeUrl.replace(/\/$/, "")}/api/database/records/${table}`;
}

function headers(cfg) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.insforgeKey}`
  };
}

// --- Decisions log -------------------------------------------------

export async function logDecision(entry) {
  const cfg = await getCfg();
  if (!isConfigured(cfg)) {
    return appendLocal(LOCAL_DECISIONS_KEY, entry, 200);
  }
  try {
    await fetch(recordsUrl(cfg, "decisions"), {
      method: "POST",
      headers: headers(cfg),
      // PostgREST accepts an array of rows
      body: JSON.stringify([entry])
    });
  } catch (e) {
    await appendLocal(LOCAL_DECISIONS_KEY, entry, 200);
  }
}

export async function getDecisions(limit = 50) {
  const cfg = await getCfg();
  if (!isConfigured(cfg)) {
    const all = await readLocal(LOCAL_DECISIONS_KEY, []);
    return all.slice(-limit).reverse();
  }
  try {
    const url = `${recordsUrl(cfg, "decisions")}?order=created_at.desc&limit=${limit}`;
    const r = await fetch(url, { headers: headers(cfg) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const all = await readLocal(LOCAL_DECISIONS_KEY, []);
    return all.slice(-limit).reverse();
  }
}

// --- Muted authors -------------------------------------------------

export async function getMutedAuthors() {
  const cfg = await getCfg();
  if (!isConfigured(cfg)) {
    return readLocal(LOCAL_MUTED_KEY, []);
  }
  try {
    const r = await fetch(recordsUrl(cfg, "muted_authors"), {
      headers: headers(cfg)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    return rows.map((row) => row.author).filter(Boolean);
  } catch (e) {
    return readLocal(LOCAL_MUTED_KEY, []);
  }
}

export async function muteAuthor(author) {
  if (!author) return;
  const cfg = await getCfg();
  if (!isConfigured(cfg)) {
    const list = await readLocal(LOCAL_MUTED_KEY, []);
    if (!list.includes(author)) {
      list.push(author);
      await writeLocal(LOCAL_MUTED_KEY, list);
    }
    return;
  }
  try {
    await fetch(recordsUrl(cfg, "muted_authors"), {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify([{ author }])
    });
  } catch (e) {
    const list = await readLocal(LOCAL_MUTED_KEY, []);
    if (!list.includes(author)) {
      list.push(author);
      await writeLocal(LOCAL_MUTED_KEY, list);
    }
  }
}

// --- chrome.storage.local fallback helpers -------------------------

function readLocal(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [key]: fallback }, (s) => resolve(s[key]));
  });
}

function writeLocal(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

async function appendLocal(key, entry, cap) {
  const list = await readLocal(key, []);
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
  await writeLocal(key, list);
}

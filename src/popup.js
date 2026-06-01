/* popup.js — reads/writes settings to chrome.storage.sync and shows the digest */

const DEFAULTS = {
  enabled: true,
  threshold: 0.6,
  action: "blur",
  useLlm: false,
  provider: "nebius",
  apiKey: "",
  model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
  apiBaseOverride: "",
  dailyCallCap: 500,
  insforgeUrl: "",
  insforgeKey: "",
  roverEnabled: false,
  roverSiteId: "",
  roverPublicKey: "",
  roverSiteKeyId: "",
  roverApiBase: "https://agent.rtrvr.ai"
};

const ids = [
  "enabled",
  "threshold",
  "action",
  "useLlm",
  "provider",
  "apiKey",
  "model",
  "apiBaseOverride",
  "dailyCallCap",
  "insforgeUrl",
  "insforgeKey",
  "roverEnabled",
  "roverSiteId",
  "roverPublicKey",
  "roverSiteKeyId"
];

const els = {};
ids.forEach((id) => (els[id] = document.getElementById(id)));
els.thresholdOut = document.getElementById("thresholdOut");
els.llmFields = document.getElementById("llmFields");
els.roverFields = document.getElementById("roverFields");
els.status = document.getElementById("status");
els.digestBtn = document.getElementById("digestBtn");
els.digest = document.getElementById("digest");
els.budgetReadout = document.getElementById("budgetReadout");

let statusTimer = null;
function flash(msg) {
  els.status.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (els.status.textContent = ""), 1200);
}

function render(s) {
  els.enabled.checked = s.enabled;
  els.threshold.value = s.threshold;
  els.thresholdOut.textContent = Number(s.threshold).toFixed(2);
  els.action.value = s.action;
  els.useLlm.checked = s.useLlm;
  els.provider.value = s.provider;
  els.apiKey.value = s.apiKey;
  els.model.value = s.model;
  els.apiBaseOverride.value = s.apiBaseOverride;
  els.dailyCallCap.value = s.dailyCallCap;
  els.insforgeUrl.value = s.insforgeUrl;
  els.insforgeKey.value = s.insforgeKey;
  els.roverEnabled.checked = s.roverEnabled;
  els.roverSiteId.value = s.roverSiteId;
  els.roverPublicKey.value = s.roverPublicKey;
  els.roverSiteKeyId.value = s.roverSiteKeyId;
  els.llmFields.hidden = !s.useLlm;
  els.roverFields.hidden = !s.roverEnabled;
  showBudget(s.dailyCallCap);
}

function showBudget(cap) {
  chrome.storage.local.get({ fd_llm_budget: { date: "", count: 0 } }, (st) => {
    const today = new Date().toISOString().slice(0, 10);
    const used = st.fd_llm_budget.date === today ? st.fd_llm_budget.count : 0;
    els.budgetReadout.textContent = `AI calls today: ${used} / ${cap}`;
  });
}

function collect() {
  return {
    enabled: els.enabled.checked,
    threshold: parseFloat(els.threshold.value),
    action: els.action.value,
    useLlm: els.useLlm.checked,
    provider: els.provider.value,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || DEFAULTS.model,
    apiBaseOverride: els.apiBaseOverride.value.trim(),
    dailyCallCap: parseInt(els.dailyCallCap.value, 10) || 0,
    insforgeUrl: els.insforgeUrl.value.trim(),
    insforgeKey: els.insforgeKey.value.trim(),
    roverEnabled: els.roverEnabled.checked,
    roverSiteId: els.roverSiteId.value.trim(),
    roverPublicKey: els.roverPublicKey.value.trim(),
    roverSiteKeyId: els.roverSiteKeyId.value.trim()
  };
}

function save() {
  const s = collect();
  els.thresholdOut.textContent = Number(s.threshold).toFixed(2);
  els.llmFields.hidden = !s.useLlm;
  els.roverFields.hidden = !s.roverEnabled;
  chrome.storage.sync.set(s, () => flash("Saved"));
}

chrome.storage.sync.get(DEFAULTS, (stored) => render({ ...DEFAULTS, ...stored }));

ids.forEach((id) => {
  const el = els[id];
  el.addEventListener("change", save);
});
els.threshold.addEventListener("input", () => {
  els.thresholdOut.textContent = Number(els.threshold.value).toFixed(2);
});

// --- Digest ---------------------------------------------------------

els.digestBtn.addEventListener("click", () => {
  els.digest.textContent = "Loading…";
  chrome.runtime.sendMessage({ type: "fd-get-digest", limit: 50 }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      els.digest.textContent = "No digest available.";
      return;
    }
    renderDigest(resp.rows || []);
  });
});

function renderDigest(rows) {
  if (!rows.length) {
    els.digest.textContent = "Nothing filtered yet. Scroll your feed first.";
    return;
  }
  const byTag = {};
  const authors = {};
  rows.forEach((r) => {
    (r.reasons || "")
      .split("|")
      .filter(Boolean)
      .forEach((t) => (byTag[t] = (byTag[t] || 0) + 1));
    if (r.author) authors[r.author] = (authors[r.author] || 0) + 1;
  });

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topAuthors = Object.entries(authors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  let html = `<div class="digest__head">${rows.length} posts filtered</div>`;
  if (topTags.length) {
    html += `<div class="digest__section">Top reasons</div><ul>`;
    topTags.forEach(([t, n]) => (html += `<li>${t} <b>${n}</b></li>`));
    html += `</ul>`;
  }
  if (topAuthors.length) {
    html += `<div class="digest__section">Most filtered authors</div><ul>`;
    topAuthors.forEach(([a, n]) => (html += `<li>${a} <b>${n}</b></li>`));
    html += `</ul>`;
  }
  els.digest.innerHTML = html;
}

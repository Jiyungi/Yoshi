/* Verifies the daily-cap reserve logic in isolation. Run: node scripts/test-budget.js */

// Minimal fake chrome.storage.local
const store = {};
global.chrome = {
  storage: {
    local: {
      get(defaults, cb) {
        const out = {};
        for (const k of Object.keys(defaults)) {
          out[k] = k in store ? store[k] : defaults[k];
        }
        cb(out);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        cb && cb();
      }
    }
  }
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
async function reserveCall(cap) {
  const today = todayKey();
  const budget = await getBudget();
  const current = budget.date === today ? budget.count : 0;
  if (current >= cap) return false;
  await setBudget({ date: today, count: current + 1 });
  return true;
}

(async () => {
  const cap = 3;
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await reserveCall(cap));
  console.log("cap=3, 5 attempts ->", results.join(","));
  const ok = results.filter(Boolean).length === 3 && results[3] === false;

  // Simulate a new day -> should reset.
  store.fd_llm_budget = { date: "2000-01-01", count: 99 };
  const afterReset = await reserveCall(cap);
  console.log("new day first call allowed ->", afterReset);

  console.log(ok && afterReset ? "PASS" : "FAIL");
  process.exit(ok && afterReset ? 0 : 1);
})();

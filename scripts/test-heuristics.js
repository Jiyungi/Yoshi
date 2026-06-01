/* Quick offline sanity check for the heuristic scorer. Run: node scripts/test-heuristics.js */
const fs = require("fs");
const path = require("path");

// Load heuristics.js into a fake window.
const code = fs.readFileSync(path.join(__dirname, "..", "src", "heuristics.js"), "utf8");
const window = {};
new Function("window", code)(window);
const { score } = window.FeedDeclutterHeuristics;

const samples = [
  {
    label: "humblebrag announcement",
    text:
      "I'm beyond thrilled and humbled to announce that I got into my dream program! 🎉🚀\n" +
      "This journey has been incredible.\nHere's why it matters 👇\n🚀 Hard work pays off\n✅ Never give up\n🔥 Dreams come true\n#blessed #grateful #journey #success #motivation #career"
  },
  {
    label: "engagement bait",
    text: "Unpopular opinion: most meetings are useless.\n\nAgree?\n\nComment 'YES' below and repost if this resonates."
  },
  {
    label: "AI-tell generic",
    text:
      "In today's fast-paced digital world, it is important to understand the value of networking. " +
      "In conclusion, building relationships is essential for success."
  },
  {
    label: "genuine substantive post",
    text:
      "We shipped a change to our caching layer that cut p99 latency from 340ms to 90ms. " +
      "The key was moving from per-request DB lookups to a read-through cache with a 30s TTL. " +
      "Happy to share the config details if useful."
  },
  {
    label: "short normal post",
    text: "Great talk by the team today on observability. Learned a lot about tracing."
  }
];

for (const s of samples) {
  const r = score(s.text);
  console.log(
    `${r.score.toFixed(2)}  [${s.label}]  tags=${r.tags.join("|") || "-"}`
  );
}

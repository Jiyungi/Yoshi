# LinkedIn Feed Filter

An "agent that acts" on your LinkedIn feed: it reads each post as you scroll,
decides whether it's a humblebrag / "I'm thrilled to announce my new role" /
award / graduation / AI-generated / engagement-bait post, and **blurs it in
place** with a one-line reason. You can reveal it, mark it "Not interested," or
mute the author — and it remembers your choices across sessions.

It runs client-side in your own logged-in browser tab. It is **not** a scraper:
it filters the DOM your browser already rendered, the same way an ad blocker
hides ads. Nothing about your feed is sent anywhere unless you explicitly use
the optional AI "Why?" explanation.

---

## Why I built this

I kept opening LinkedIn while job-hunting and leaving worse than I arrived.

The feed had turned into a wall of "I'm beyond humbled and thrilled to announce
…", "Agree? 👇", and AI-written thought-leadership filler. Doomscrolling it
didn't help me find a job or learn anything — it just made me feel behind and
low, which made me scroll more, which made it worse. A genuinely useful post
(a real opening, a concrete lesson) was buried under performative noise.

So I built the thing I wanted: a filter that quietly removes the posts that
exist to perform rather than inform, and surfaces the rest. Less comparison,
less anxiety, more signal. The goal isn't to mock anyone's announcement — it's
to give *me* a calmer feed so the time I spend there is actually worth it.

---

## What it does

1. **Detects** announcement/humblebrag posts as they load, using
   phrase-anchored matching (first-person "I'm starting a new role as…",
   "humbled to announce", "honored to receive the … award", "graduated with my
   …", etc.). Phrase-anchoring keeps precision high — third-person commentary
   like "OpenAI is formalizing what *started as* world simulation" is **not**
   flagged.
2. **Blurs instantly** — the post is blurred in the same animation frame it
   appears, so you rarely see the original flash first.
3. **Explains ("Why?")** — on demand, classifies the post into a category with
   a confidence score, a short summary, and red flags.
4. **Acts** — "Not interested" opens LinkedIn's own control menu and clicks
   *Not interested*; "Mute author" hides that author's posts going forward.
5. **Remembers** — muted authors and every filtering decision are persisted, so
   the feed gets cleaner over time and a digest shows what was filtered and why.

---

## How the sponsor tools are used (and why each matters)

This project uses three sponsor tools, each for a distinct layer. The design
principle throughout: **local-first and graceful degradation** — the core
filter works with zero network calls, and every integration fails safe so a
flaky network never breaks the demo.

### 1. Nebius AI Cloud — the classifier / "brain"

- **Where:** `background.js` → `api.studio.nebius.ai/v1/chat/completions`,
  model `Qwen/Qwen3-30B-A3B-Instruct-2507` (a cheap, fast MoE model).
- **What it does:** Two jobs. (a) Scores *borderline* posts 0–1 — the ones the
  local heuristics rate in the ambiguous 0.25–0.85 band — so we don't over- or
  under-filter the gray-area posts. (b) Powers the **"Why?"** panel: returns
  structured JSON `{category, isLowSignal, confidence, summary, redFlags}` that
  turns a blurred rectangle into an explanation.
- **Why it matters:** Heuristics are instant but shallow; they catch the
  obvious templates and miss subtle AI-generated filler. Nebius adds real
  language understanding exactly where rules fall short, while staying cheap.
  A **daily call cap** (default 500) and a **per-post cache** keep cost near
  zero — at this model's pricing the whole project stays well under a dollar.
- **Why Nebius specifically:** OpenAI-compatible API (one code path, swappable),
  open-weight models, and low per-token cost that suits a high-volume,
  per-post classification workload.

### 2. Insforge — the memory / state layer

- **Where:** `src/insforge.js` → PostgREST-style REST at
  `https://<project>.insforge.app/api/database/records/<table>`.
- **What it does:** Persists two tables — `muted_authors` (authors whose posts
  auto-hide from then on) and `decisions` (an audit log of every filter
  action). The popup's **digest** reads this back to show top reasons and the
  most-filtered authors.
- **Why it matters:** This is what makes it an *agent that learns* rather than a
  stateless filter. Mute someone once and it sticks across sessions and reloads;
  the decision log turns "it hid some stuff" into "here's what it filtered and
  why." It's the difference between a script and a product.
- **Why Insforge specifically:** It's a backend built for agents — instant
  database + auto-generated REST with no schema/ORM boilerplate, so the agent
  gets persistent memory in a few `fetch` calls. If Insforge isn't configured,
  the same features fall back to `chrome.storage.local`, so the extension never
  hard-depends on the network.

### 3. Rover (Rtrvr.ai) — the on-page agent / action layer

- **Where:** packaged runtime in `vendor/` injected via
  `chrome.scripting.executeScript` (per `EXTENSION_USERS.md`); cloud A2W client
  in `src/rover.js`.
- **What it does:** Rover is embedded live on the LinkedIn feed (the
  "Do it with Rover" presence), booted with this project's site keys. The
  product's **action layer** ("Not interested") is the agentic counterpart to
  the passive filter — moving from "hide noise" to "take action on noise."
- **Why it matters:** The hackathon theme is *agents that act*. Filtering is
  analysis; Rover represents the action half — an agent embedded in the live UI
  that can operate the page on the user's behalf.
- **Honest scoping (important):** Rover is designed for sites *you own and have
  installed Rover on*. LinkedIn is a third party that actively blocks
  automation: its Content Security Policy blocks the in-page Rover runtime from
  reaching its backend, and Rover's own cloud-execution policy refuses to drive
  `linkedin.com` (returns `cloud_browser_not_allowed`). So on LinkedIn
  specifically, Rover runs as the **embedded presence + action trigger**, and
  the "Not interested" click is executed via local DOM automation as a reliable
  fallback. On a site you control (Rover's intended use case), the same wiring
  runs the full headless agent. We chose to document this boundary rather than
  fake it — understanding a tool's limits is part of using it well.

#### How the layers fit together

```
            ┌──────────────── your browser tab (linkedin.com) ────────────────┐
 scroll ──► │ content.js: detect announcement posts → blur instantly          │
            │      │                                                           │
            │      ├─ "Why?"  ──► background.js ──► Nebius  (classify → JSON)   │
            │      ├─ "Mute"  ──► background.js ──► Insforge (persist + digest) │
            │      └─ "Not interested" ──► Rover embed / local action          │
            └──────────────────────────────────────────────────────────────────┘
```

Local heuristics are the always-on backbone; Nebius, Insforge, and Rover each
add a layer on top and each degrade gracefully if unconfigured.

---

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open `https://www.linkedin.com/feed/` and scroll.
5. Click the extension icon to adjust aggressiveness, blur-vs-hide, and the
   optional AI settings.

Keys are loaded automatically from `src/config.json` on install (gitignored;
copy `src/config.example.json` to create it). The popup can override them live.

See `SETUP.md` for the full per-sponsor setup and a 90-second demo script.

---

## Architecture / files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, scoped to `www.linkedin.com` |
| `src/heuristics.js` | Pure offline scorer (no I/O) — humblebrag/award/grad/bait rules |
| `src/content.js` | Detects posts, instant-blur, badge UI, actions, observer |
| `src/styles.css` | Blur overlay, reason badge, toast |
| `background.js` | Nebius classifier + daily call cap; Insforge & Rover routing |
| `src/insforge.js` | Insforge client (muted authors + decisions) with local fallback |
| `src/rover.js` | Rover A2W cloud client + embed boot |
| `src/popup.*` | Settings UI + digest |
| `src/config.json` | Auto-loaded keys/settings (gitignored) |
| `vendor/` | Packaged Rover runtime (gitignored) |
| `scripts/test-*.js` | Offline unit tests: heuristics, announce matcher, budget |

### Tests

```bash
node scripts/test-heuristics.js   # scoring separates flagged vs genuine
node scripts/test-announce.js     # announcement matcher precision/recall
node scripts/test-budget.js       # daily call cap caps and resets
```

---

## Design choices & honest caveats

- **Phrase-anchored, not "filter everything."** I biased toward precision: it's
  better to miss a humblebrag than to blur a genuinely useful post. The phrase
  list is easy to widen in `src/content.js` (`ANNOUNCE_RES`).
- **Not scraping.** Client-side DOM filtering in your own session — no abnormal
  traffic for LinkedIn to detect. It hides posts on *your* screen.
- **DOM fragility, not blocking.** LinkedIn obfuscates and reshuffles class
  names constantly, so detection is structural/phrase-based rather than
  class-based. If LinkedIn changes things, detection may need a tune-up — it
  won't get "blocked."
- **Terms of Service.** Automated access is technically against LinkedIn's User
  Agreement. A read-only personal filter that only hides posts for you is the
  lowest-risk category (like an ad blocker), but it's your call.
- **Privacy & cost.** Post text leaves your browser only when you use the AI
  "Why?" feature (or the borderline classifier), capped daily. Everything else
  is local. Keep AI off for a fully local setup.
- **Mobile.** This is a desktop Chrome extension. iOS can't run it in the native
  LinkedIn app (sandboxing); a Safari iOS web extension reusing this content
  script is the portable path.

---

## Roadmap

- Widen detection beyond announcements (configurable categories).
- Run the full Rover headless agent on Rover-enabled sites for cross-site
  research (e.g. "find real openings from the people I *didn't* mute").
- A weekly "signal report": what was noise, what was worth reading.

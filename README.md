# Feed Declutter for LinkedIn

A Manifest V3 Chrome extension that **locally** hides or blurs AI-generated,
humblebrag ("humbled and thrilled to announce I got into…"), and low-signal
engagement-bait posts in your LinkedIn feed.

By default it runs **entirely in your browser**. Nothing is scraped, and nothing
leaves your machine — it reads the DOM your browser already rendered and hides
posts on your own screen, the same way an ad blocker works.

## How it works

1. A content script (`src/content.js`) finds feed posts as you scroll.
2. Each post's text is scored 0–1 by an offline heuristic engine
   (`src/heuristics.js`): humblebrag phrases, engagement bait, emoji-bullet
   formatting, hashtag clusters, AI "tells", etc.
3. Posts at or above your threshold get blurred (with a reason badge) or hidden.
4. A `MutationObserver` re-runs scoring as new posts load.

### Optional LLM classifier (off by default)

For borderline posts (heuristic score 0.25–0.85) you can enable an LLM pass in
the popup. When **on**, that post's text is sent to the API you configure
(OpenAI-compatible) through the background worker, which keeps your API key out
of the page. When **off**, no network requests are made at all.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open `https://www.linkedin.com/feed/` and scroll.
5. Click the extension icon to adjust aggressiveness, blur-vs-hide, and the
   optional LLM settings.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, scoped to `www.linkedin.com` |
| `src/heuristics.js` | Pure offline scorer (no I/O) |
| `src/content.js` | Finds posts, scores, hides/blurs, observes feed |
| `src/styles.css` | Blur + reason-badge styling |
| `background.js` | Optional LLM proxy (off unless you enable it) |
| `src/popup.*` | Settings UI |
| `scripts/test-heuristics.js` | `node scripts/test-heuristics.js` to sanity-check scoring |

## Tuning

- **Aggressiveness slider** = the threshold. Lower filters more; higher only
  catches the obvious posts.
- Edit `PHRASE_RULES` and weights in `src/heuristics.js` to match the patterns
  you personally find annoying.

## Notes & caveats

- **Not scraping.** This is client-side DOM filtering in your own logged-in
  session, so there is no abnormal traffic for LinkedIn to detect or block.
- **DOM fragility.** LinkedIn changes its markup often. If posts stop being
  caught, update the selectors in `POST_SELECTORS` / `extractText` in
  `src/content.js`. The extension won't be "blocked" — selectors just go stale.
- **Terms of Service.** Automated access is technically against LinkedIn's User
  Agreement. A read-only personal filter that only hides posts for you is the
  lowest-risk category (like an ad blocker), but it is still your call.
- **Privacy.** Keep the LLM classifier off for a fully local setup. With it on,
  borderline post text is sent to your configured API — review that provider's
  data policy.

## About Rover

The `rover-preview-helper` docs describe injecting Rover (an action-taking AI
agent) into pages. This extension deliberately does **not** use Rover: filtering
the feed is local classification, not agent actions. If you later want Rover to
*act* on the feed, follow `EXTENSION_USERS.md` and add its boot bridge in a
`world: "MAIN"` injection from `background.js`, keeping this filtering logic in
the isolated content script as recommended.

# Demo Setup (one-time, ~10 min)

The extension works fully local with zero setup. The steps below light up the
sponsor integrations for the demo. Each is independent and degrades gracefully —
skip any one and the rest still work.

## 0. Load the extension (always do this)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open `https://www.linkedin.com/feed/` and scroll. Filtering works immediately
   (local heuristics, no keys needed).

## 1. Nebius AI Cloud — the classifier (sponsor)

Catches the borderline "AI-flavored" posts the heuristics rate ~0.4.

1. Get an API key from Nebius AI Studio.
2. Extension popup → **AI classifier** ON → Provider **Nebius AI Cloud**.
3. Paste the key. Model default is `Qwen/Qwen3-30B-A3B-Instruct-2507`
   (any chat model on Nebius works).
4. Base URL is handled automatically (`https://api.studio.nebius.ai/v1`,
   OpenAI-compatible). Override only if your account uses Token Factory
   (`https://api.tokenfactory.nebius.com/v1`).

To use **NEAR AI** instead, pick that provider and paste a NEAR AI key — same
OpenAI-compatible path.

## 2. InsForge — the agent memory (sponsor)

Makes it an agent that *learns*: muted authors and the decision log persist
server-side and drive auto-hiding + the digest.

1. Sign in at https://insforge.dev and create a project (auto agent-signup is
   currently disabled, so do it in the dashboard).
2. Create two tables (dashboard SQL or the table UI):

   **decisions**
   | column | type |
   | --- | --- |
   | author | string (text) |
   | text | string (text) |
   | score | float8 |
   | action | string (text) |
   | reasons | string (text) |
   | created_at | timestamptz, default `now()` |

   **muted_authors**
   | column | type |
   | --- | --- |
   | author | string (text) |
   | created_at | timestamptz, default `now()` |

   Turn RLS **off** on both for the demo (simplest).
3. Copy the **Project URL** (`https://<appkey>.<region>.insforge.app`) and the
   project **access key**.
4. Extension popup → **Memory (InsForge)** → paste both. Done.

Leave these blank and the same features run on `chrome.storage.local` instead —
good as a fallback if the network is flaky on stage.

## 3. Rover (Rtrvr.ai) — optional, for heavy actions

Local hide/blur/mute needs no agent. Use Rover only if you want the agent to
*take site actions* (e.g. actually unfollow a repeat offender). See
`ROVER.md` for the boot-bridge wiring from `EXTENSION_USERS.md`.

## Demo script (90 seconds)

1. Open the feed with the extension off → show the humblebrag/bait noise.
2. Turn it on → posts blur with reasons ("humblebrag", "engagement-bait").
3. Click **Mute author** on one → it vanishes; mention it's stored in InsForge.
4. Turn on the **Nebius** classifier → reload → a subtle AI post now gets caught.
5. Open the popup → **Show today's digest** → top reasons + most-filtered authors.
6. One line: "local-first, AI for hard cases, server memory so it learns —
   an agent that triages your feed and acts."

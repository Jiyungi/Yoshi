/**
 * content.js  (isolated world)
 *
 * Triages the LinkedIn feed:
 *   - scores each post locally (heuristics.js), optionally escalates
 *     borderline posts to an LLM (Nebius / NEAR AI / OpenAI) via background;
 *   - hides/blurs posts over your threshold;
 *   - auto-hides posts from authors you've muted (memory via InsForge);
 *   - logs every decision for the digest;
 *   - lets you mute an author straight from the blur badge.
 *
 * Per EXTENSION_USERS guidance, all of this stays in the isolated content
 * script. Rover (world: "MAIN") is only needed for heavy actions like
 * unfollow, which is left as an optional extension point.
 */
(function () {
  "use strict";

  const DEBUG = true; // set false once filtering is confirmed working
  const log = (...a) => DEBUG && console.log("[FeedDeclutter]", ...a);

  const PROCESSED_ATTR = "data-fd-processed";
  const SCORE_ATTR = "data-fd-score";

  const DEFAULTS = {
    enabled: true,
    threshold: 0.6,
    action: "blur", // "blur" | "hide"
    useLlm: false
  };

  let settings = { ...DEFAULTS };
  let mutedAuthors = new Set();
  // Per-post classification cache (text hash -> result). Prevents repeat
  // LLM calls on re-scan; cost safety + speed.
  const classifyCache = new Map();

  function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  const POST_SELECTORS = [
    'div.feed-shared-update-v2[data-urn]',
    'div[data-urn^="urn:li:activity"]',
    'div[data-id^="urn:li:activity"]',
    "div.feed-shared-update-v2",
    "div.fie-impression-container",
    "div.update-components-update-v2"
  ];

  // Marks an element we've identified as a post container, so re-scans and
  // mute-by-author can find them again regardless of obfuscated classes.
  const POST_FLAG = "data-fd-post";

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (stored) =>
          resolve({ ...DEFAULTS, ...stored })
        );
      } catch (e) {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function loadMutedAuthors() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "fd-get-muted" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            resolve();
            return;
          }
          mutedAuthors = new Set(resp.authors || []);
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // --- Post detection (phrase-anchored) -------------------------------
  // LinkedIn's feed has no data-urn and uses obfuscated, randomized class
  // names, so structural "find every post" detection kept grabbing wrappers
  // (and blurred the whole feed / the Load more control). Instead we ONLY
  // target cards whose text contains a strong announcement/humblebrag phrase.
  // We find the phrase, then climb to that single post's card. Nothing
  // without such a phrase (like Load more) can ever be blurred.

  // Strong, high-precision phrases. These target the first-person "I got a
  // new role / humbled to announce / got into ..." family plus award and
  // graduation bragging. Loose verb rules are anchored to first-person
  // proximity so third-person sentences do NOT match.
  const ANNOUNCE_RES = [
    // Emotion + to announce/share  ("thrilled to announce", "happy to share")
    /\b(humbled|thrilled|excited|proud|honou?red|delighted|pleased|happy|grateful)\b[\s\S]{0,40}\bto (announce|share)\b/i,
    // First person + to announce/share
    /\b(i'?m|i am|im)\b[\s\S]{0,30}\bto (announce|share)\b/i,
    // First person + start/join/accept close to (new) role/position/job
    /\b(i'?m|i am|im|i'?ve|i have|i'?ll|i will|i)\b[\s\S]{0,25}\b(starting|started|joining|joined|accepted|begin|beginning)\b[\s\S]{0,30}\b(new )?(role|position|job|chapter|journey|gig|internship|fellowship)\b/i,
    // "starting/began a new chapter/position/role ..."
    /\b(starting|started|begin|beginning|began)\b[\s\S]{0,12}\ba new (chapter|journey|position|role|adventure|gig)\b/i,
    // First person + got into / accepted / offer
    /\b(i|i'?ve|i have|i'?m|im)\b[\s\S]{0,20}\b(got into|been accepted|accepted (in)?to|got an offer|got accepted|will be joining)\b/i,
    /\bcongratulations to me\b/i,
    /\b(my )?dream (job|school|role|company|internship)\b/i,

    // --- Award / recognition bragging ---
    /\b(humbled|honou?red|proud|thrilled|excited|grateful)\b[\s\S]{0,40}\b(to (receive|win|be (named|recognized|selected|awarded))|recipient of|to be the recipient)\b/i,
    /\b(i'?m|i am|im|i'?ve|i have|i)\b[\s\S]{0,30}\b(won|received|been awarded|was awarded|been named|was named|been recognized|been selected|earned)\b[\s\S]{0,30}\b(award|prize|honou?r|recognition|scholarship|fellowship|medal|title|champion|winner|top \d+|30 under 30|40 under 40)\b/i,
    /\b(awarded|named|recognized|selected as|voted)\b[\s\S]{0,20}\b(employee|student|player|leader|professional|rising star) of the (month|year|quarter)\b/i,
    /\b(winner|recipient|finalist)\b[\s\S]{0,20}\bof the\b/i,

    // --- Graduation bragging ---
    /\b(i'?m|i am|im|i'?ve|i have|i)\b[\s\S]{0,30}\b(graduated|am graduating|will graduate|completed my|earned my|received my|finished my)\b[\s\S]{0,30}\b(degree|diploma|bachelor'?s?|master'?s?|mba|ph\.?d|doctorate|undergrad|graduate)\b/i,
    /\b(proud|thrilled|excited|humbled|happy|grateful)\b[\s\S]{0,40}\b(to graduate|graduate|graduation|to have graduated|to share .{0,20}graduat)/i,
    /\bofficially a (graduate|college graduate|university graduate)\b/i,
    /\bclass of 20\d\d\b[\s\S]{0,30}\b(graduat|degree|proud|done|complete)/i
  ];

  function matchesAnnounce(text) {
    if (!text) return false;
    return ANNOUNCE_RES.some((re) => re.test(text));
  }

  function findPostsBySelector(scope) {
    const found = new Set();
    for (const sel of POST_SELECTORS) {
      scope.querySelectorAll(sel).forEach((el) => found.add(el));
    }
    scope
      .querySelectorAll('[data-urn*="urn:li:activity"], [data-id*="urn:li:activity"]')
      .forEach((el) => found.add(el));
    return Array.from(found);
  }

  // From a matching text element, climb to the post "card": the largest
  // ancestor that still fits within ~1.6 viewports and references an author.
  // This bounds the blurred region to a single post.
  function climbToCard(startEl) {
    let node = startEl;
    let best = null;
    for (let i = 0; i < 14 && node && node !== document.body; i++) {
      const h = node.offsetHeight || 0;
      if (h > window.innerHeight * 1.6) break; // too big — stop before wrappers
      const hasAuthor = node.querySelector
        ? node.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/newsletters/"]')
        : null;
      if (hasAuthor && h >= 80) best = node;
      node = node.parentElement;
    }
    return best;
  }

  // Find cards by locating announcement phrases in text nodes, then climbing.
  function findPhraseAnchoredPosts(scope) {
    const root = scope && scope.nodeType ? scope : document;
    const main = root.querySelector ? (root.querySelector("main") || root) : document;
    if (!main || !main.ownerDocument) return [];

    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null);
    const cards = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      if (!v || v.length < 12 || v.length > 4000) continue;
      if (!matchesAnnounce(v)) continue;
      const card = climbToCard(node.parentElement);
      if (card) cards.add(card);
    }
    return dedupeInnermost(Array.from(cards));
  }

  function findPosts(root) {
    const scope = root && root.querySelectorAll ? root : document;

    // 1) Fast path: legacy/stable selectors (old layout). Still phrase-gated
    //    below in processPost, so safe.
    const bySelector = findPostsBySelector(scope);
    if (bySelector.length) return dedupeInnermost(bySelector);

    // 2) Phrase-anchored detection for the obfuscated redesign.
    return findPhraseAnchoredPosts(scope);
  }

  function dedupeInnermost(list) {
    return list.filter((el) => {
      for (const other of list) {
        if (other !== el && el.contains(other)) return false; // el is a wrapper
      }
      return true;
    });
  }

  // Strips LinkedIn's card boilerplate so heuristics/LLM see the real text.
  function cleanPostText(raw) {
    let s = raw.replace(/^\s*Feed post\s*/i, "");
    s = s.replace(/^\s*(Suggested|Promoted)\s*/i, "");
    return s.trim();
  }

  function extractText(postEl) {
    const body =
      postEl.querySelector(".update-components-text") ||
      postEl.querySelector(".feed-shared-update-v2__description") ||
      postEl.querySelector(".feed-shared-inline-show-more-text") ||
      postEl.querySelector('[data-test-id="main-feed-activity-card__commentary"]') ||
      postEl.querySelector(".update-components-update-v2__commentary");
    if (body) return (body.innerText || body.textContent || "").trim();
    // Structural layout: clean the whole card's text.
    return cleanPostText(postEl.innerText || postEl.textContent || "");
  }

  function extractAuthor(postEl) {
    // Try known classes first.
    const known =
      postEl.querySelector(".update-components-actor__title span[aria-hidden='true']") ||
      postEl.querySelector(".update-components-actor__name span[aria-hidden='true']") ||
      postEl.querySelector(".update-components-actor__title") ||
      postEl.querySelector(".update-components-actor__name") ||
      postEl.querySelector(".feed-shared-actor__name");
    if (known) {
      const t = (known.innerText || known.textContent || "").split("\n")[0].trim();
      if (t) return t;
    }

    // Structural fallback: parse the card header text.
    // Examples seen:
    //   "Feed postSuggestedShantanu Ladhwe• 2ndHead of AI..."
    //   "Feed postRadhika Bhatt likes thisMoye I.• 3rd+Dir..."
    //   "Feed postAlharith Hussin commentedPeter Walker• 2nd..."
    let s = (postEl.innerText || "").replace(/\s+/g, " ");
    s = s.replace(/^\s*Feed post\s*/i, "").replace(/^\s*(Suggested|Promoted)\s*/i, "");
    // Drop a leading social-context clause ("X likes this", "X commented", ...).
    s = s.replace(
      /^.*?(?:likes this|commented|reposted this|finds this \w+|loves this|celebrates this|follows this)\s*/i,
      ""
    );
    // Author name is the text before the connection-degree bullet.
    const m = s.match(/^(.{1,80}?)\s*•\s*(?:1st|2nd|3rd|Following)/i);
    if (m && m[1].trim()) return m[1].trim();

    // Last resort: first link to a profile/company with non-trivial text.
    const links = postEl.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]');
    for (const a of links) {
      const t = (a.innerText || a.textContent || "").split("\n")[0].trim();
      if (t && t.length > 1 && !/^feed post$/i.test(t)) return t;
    }
    return "";
  }

  function logDecision(entry) {
    try {
      chrome.runtime.sendMessage({ type: "fd-log-decision", entry }, () => {
        void chrome.runtime.lastError; // swallow
      });
    } catch (e) {
      /* fail open */
    }
  }

  function muteAuthor(author, postEl) {
    if (!author) return;
    mutedAuthors.add(author);
    try {
      chrome.runtime.sendMessage(
        { type: "fd-mute-author", author },
        (resp) => {
          void chrome.runtime.lastError;
          if (resp && resp.rover && resp.rover.ok) {
            log(`Rover acting on author "${author}" (unfollow)`);
            showToast(`Rover is unfollowing ${author}…`);
          }
        }
      );
    } catch (e) {
      /* fail open */
    }
    // Immediately hide this and any other visible posts by the author.
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
      if (extractAuthor(el) === author) {
        el.classList.remove("fd-blurred");
        const b = el.querySelector(":scope > .fd-badge");
        if (b) b.remove();
        el.classList.add("fd-hidden");
      }
    });
  }

  // Lightweight on-page toast so the Rover action is visible during demos.
  function showToast(text) {
    let toast = document.getElementById("fd-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "fd-toast";
      toast.className = "fd-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("fd-toast--show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("fd-toast--show"), 3500);
  }

  function applyDecision(postEl, result, author) {
    postEl.setAttribute(SCORE_ATTR, result.score.toFixed(2));
    postEl.classList.remove("fd-hidden", "fd-blurred");
    const oldBadge = postEl.querySelector(":scope > .fd-badge");
    if (oldBadge) oldBadge.remove();

    if (!settings.enabled) return;

    const isMuted = author && mutedAuthors.has(author);
    const overThreshold = result.score >= settings.threshold;

    if (!isMuted && !overThreshold) return;

    // Log what we acted on (powers the digest).
    logDecision({
      author: author || "",
      text: "",
      score: Number(result.score.toFixed(3)),
      action: isMuted ? "hide-muted" : settings.action,
      reasons: (result.tags || []).join("|") || (isMuted ? "muted-author" : "")
    });

    if (isMuted || settings.action === "hide") {
      postEl.classList.add("fd-hidden");
      return;
    }

    postEl.classList.add("fd-blurred");
    const badge = document.createElement("div");
    badge.className = "fd-badge";
    const reasonText = result.tags && result.tags.length
      ? result.tags.slice(0, 3).join(", ")
      : "low-signal";
    badge.innerHTML =
      `<span class="fd-badge__title">Filtered &middot; ${(result.score * 100) | 0}%</span>` +
      `<span class="fd-badge__reason">${reasonText}</span>` +
      `<div class="fd-badge__context" hidden></div>` +
      `<div class="fd-badge__actions">` +
      `<button class="fd-badge__show" type="button">Show anyway</button>` +
      `<button class="fd-badge__explain" type="button">Why?</button>` +
      `<button class="fd-badge__notinterested" type="button">Not interested</button>` +
      (author
        ? `<button class="fd-badge__mute" type="button">Mute author</button>`
        : "") +
      `</div>`;

    badge.querySelector(".fd-badge__show").addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      postEl.classList.remove("fd-blurred");
      badge.remove();
    });

    badge.querySelector(".fd-badge__explain").addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      explainPost(badge, author, extractText(postEl));
    });

    badge.querySelector(".fd-badge__notinterested").addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      markNotInterested(postEl, author);
    });

    const muteBtn = badge.querySelector(".fd-badge__mute");
    if (muteBtn) {
      muteBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        muteAuthor(author, postEl);
      });
    }
    postEl.appendChild(badge);
  }

  // "Why? (Rover)" — runs deep classification + author triage and renders
  // the richer context directly on the blur badge.
  async function explainPost(badge, author, postText) {
    const ctx = badge.querySelector(".fd-badge__context");
    const btn = badge.querySelector(".fd-badge__explain");
    if (!ctx) return;
    ctx.hidden = false;
    ctx.innerHTML = `<span class="fd-spin">Analyzing…</span>`;
    if (btn) btn.disabled = true;

    try {
      const deep = await roverDeepClassify(author, postText);

      const lines = [];
      let serial = false;
      if (deep && deep.data) {
        const d = deep.data;
        if (d.category) {
          lines.push(
            `<b>${escapeHtml(d.category)}</b>` +
              (d.confidence != null ? ` · ${Math.round(d.confidence * 100)}%` : "")
          );
        }
        if (d.summary) lines.push(escapeHtml(d.summary));
        if (Array.isArray(d.redFlags) && d.redFlags.length) {
          lines.push("⚑ " + d.redFlags.slice(0, 3).map(escapeHtml).join(", "));
        }
        // Infer serial-offender suggestion from a confident low-signal verdict.
        serial =
          author &&
          d.isLowSignal &&
          (d.confidence == null || d.confidence >= 0.7) &&
          /humblebrag|engagement-bait|ai-generated|ad/i.test(d.category || "");
      }
      if (serial) {
        lines.push(
          `🔁 Likely repeat low-signal poster ` +
            `<button class="fd-badge__automute" type="button">Mute ${escapeHtml(author)}</button>`
        );
      }

      if (!lines.length) {
        const reason = (deep && deep.status && deep.status !== "completed") ? deep.status : "no result";
        ctx.innerHTML = `<span class="fd-badge__ctxnote">Analysis unavailable (${escapeHtml(reason)}).</span>`;
      } else {
        ctx.innerHTML = lines.map((l) => `<div class="fd-ctxline">${l}</div>`).join("");
        const am = ctx.querySelector(".fd-badge__automute");
        if (am) {
          am.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            const post = badge.closest(`[${POST_FLAG}]`) || badge.parentElement;
            muteAuthor(author, post);
          });
        }
      }
    } catch (e) {
      ctx.innerHTML = `<span class="fd-badge__ctxnote">Analysis failed.</span>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Clicks LinkedIn's own "Not interested" on a post. Tries the Rover agent
  // first (genuine agentic action); falls back to a local DOM click so the
  // feature works even without Rover configured.
  async function markNotInterested(postEl, author) {
    logDecision({
      author: author || "",
      text: "",
      score: 1,
      action: "not-interested",
      reasons: "user-not-interested"
    });

    // 1) Try Rover (headless agent action).
    let roverOk = false;
    try {
      roverOk = await runRoverNotInterested(author);
    } catch (e) {
      roverOk = false;
    }

    // 2) Local fallback: open the post's "..." control menu and click the
    //    "Not interested" item directly.
    if (!roverOk) {
      const local = clickNotInterestedLocally(postEl);
      showToast(local ? "Marked “Not interested”" : "Hid post (menu not found)");
    } else {
      showToast(`Rover: marking “Not interested”${author ? " · " + author : ""}…`);
    }

    // Either way, hide it from view immediately.
    postEl.classList.add("fd-hidden");
  }

  // Best-effort local click of LinkedIn's Not interested control.
  function clickNotInterestedLocally(postEl) {
    try {
      const menuBtn = postEl.querySelector(
        'button[aria-label*="control menu" i], button[aria-label*="more actions" i], button[aria-label*="Open control" i]'
      );
      if (!menuBtn) return false;
      menuBtn.click();
      // The menu renders asynchronously; poll briefly for the item.
      let tries = 0;
      const tick = () => {
        tries++;
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"], .artdeco-dropdown__item, button, span')
        );
        const target = items.find((el) =>
          /not interested/i.test((el.innerText || el.textContent || "").trim())
        );
        if (target) {
          target.click();
          return;
        }
        if (tries < 12) setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Rover A2W cloud task runner ------------------------------------
  // Sends a prompt to the background, which runs it via the Rover A2W cloud
  // API and returns the parsed result { ok, status, json, summary, error }.
  function runRoverTask(prompt, url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fd-rover-run", prompt, url },
          (resp) => {
            if (chrome.runtime.lastError || !resp) {
              resolve({ ok: false, status: "unavailable" });
              return;
            }
            resolve(resp);
          }
        );
      } catch (e) {
        resolve({ ok: false, status: "error" });
      }
    });
  }

  function runRoverNotInterested() {
    // Page actions need the user's logged-in session, which the cloud agent
    // doesn't have. So "Not interested" always uses the local DOM path.
    return Promise.resolve(false);
  }

  // --- Deep classification ("Why?") ----------------------------------
  // Sends the post text to the background, which tries Rover's cloud agent
  // first and falls back to the LLM (Nebius) — the in-page Rover agent is
  // blocked by LinkedIn's CSP, so the LLM is the reliable engine here.
  function roverDeepClassify(author, postText) {
    const snippet = (postText || "").slice(0, 1800);
    const prompt =
      `Classify this LinkedIn post. Author: "${author || "unknown"}". ` +
      `Reply JSON only: {"category":"humblebrag|job-announcement|award|graduation|` +
      `engagement-bait|ad|ai-generated|genuine","isLowSignal":true|false,` +
      `"confidence":0.0-1.0,"summary":"<8 words","redFlags":["..."]}. ` +
      `Post:\n"""${snippet}"""`;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fd-deep-classify", text: snippet, prompt },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              resolve({ status: "failed", data: null });
              return;
            }
            resolve({ status: "completed", source: resp.source, data: resp.json });
          }
        );
      } catch (e) {
        resolve({ status: "error", data: null });
      }
    });
  }

  // Author triage is derived from the same classification result (a single
  // call), since we can't browse the author's history without a logged-in
  // agent. We infer serial-offender likelihood from category + confidence.
  function roverAuthorTriage() {
    return Promise.resolve({ status: "skipped", data: null });
  }

  async function classify(text) {
    const key = hashText(text);
    if (classifyCache.has(key)) {
      return classifyCache.get(key);
    }

    const local = window.FeedDeclutterHeuristics.score(text);
    let result = local;
    if (
      settings.useLlm &&
      local.score >= 0.25 &&
      local.score < 0.85
    ) {
      try {
        const llm = await llmScore(text);
        if (typeof llm === "number") {
          const blended = Math.max(local.score, llm);
          result = { ...local, score: blended, tags: [...local.tags, "llm"] };
        }
      } catch (e) {
        /* fail open: heuristics still stand */
      }
    }
    classifyCache.set(key, result);
    return result;
  }

  function llmScore(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "fd-llm-score", text: text.slice(0, 2000) },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            resolve(null);
            return;
          }
          resolve(resp.score);
        }
      );
    });
  }

  async function processPost(postEl) {
    if (postEl.getAttribute(PROCESSED_ATTR) === "1") return;

    // --- Wrapper guards (prevent blurring the whole feed / Load more) ---
    if (postEl.querySelector(`[${POST_FLAG}]`)) return; // wraps another post
    if (postEl.parentElement && postEl.parentElement.closest(`[${POST_FLAG}]`)) return; // nested
    const h = postEl.offsetHeight || 0;
    if (h > window.innerHeight * 1.6) {
      postEl.setAttribute(PROCESSED_ATTR, "1");
      return; // too tall to be a single post
    }

    postEl.setAttribute(PROCESSED_ATTR, "1");

    const text = extractText(postEl);
    if (!text) return;

    const author = extractAuthor(postEl);
    const isMuted = author && mutedAuthors.has(author);
    const isAnnounce = matchesAnnounce(text);

    // PRECISION GATE: only act on announcement/award/graduation posts (or
    // muted authors). Anything else (Load more, normal posts) is untouched.
    if (!isMuted && !isAnnounce) return;

    postEl.setAttribute(POST_FLAG, "1");

    // INSTANT BLUR: apply immediately and synchronously so the user never
    // sees the original content flash before it's hidden. We use a fast
    // local-only reason now, then refine the badge label asynchronously.
    const quick = window.FeedDeclutterHeuristics.score(text);
    const provisional = isMuted
      ? { score: 1, tags: ["muted-author"] }
      : {
          score: Math.max(quick.score, 0.9),
          tags: quick.tags && quick.tags.length ? quick.tags : ["new-role-announcement"]
        };
    log(`BLUR ${provisional.score.toFixed(2)} [${author || "?"}]`, provisional.tags, text.slice(0, 70));
    applyDecision(postEl, provisional, author);

    // ENRICH (non-blocking): let the LLM refine the reason tags, but the post
    // is already blurred so there's no flash. Skip for muted authors.
    if (!isMuted && settings.useLlm) {
      classify(text)
        .then((refined) => {
          if (refined && refined.tags && refined.tags.length) {
            const merged = {
              score: Math.max(provisional.score, refined.score),
              tags: Array.from(new Set([...(refined.tags || []), ...provisional.tags]))
            };
            // Only re-render the badge if still blurred (user didn't reveal).
            if (postEl.classList.contains("fd-blurred")) {
              applyDecision(postEl, merged, author);
            }
          }
        })
        .catch(() => {});
    }
  }

  function scan(root) {
    const posts = findPosts(root);
    log(`scan found ${posts.length} post container(s)`);
    if (posts.length === 0) dumpDiagnostics();
    posts.forEach((post) => processPost(post));
  }

  // Dumps the real DOM shape when we find no posts. Throttled to once
  // every 2.5s so it re-fires after the feed finishes loading (the first
  // scan happens before LinkedIn renders anything).
  let lastDump = 0;
  function dumpDiagnostics() {
    const now = Date.now();
    if (now - lastDump < 2500) return;
    lastDump = now;

    const urnEls = document.querySelectorAll("[data-urn]");
    const idEls = document.querySelectorAll("[data-id]");
    log("DIAG ====== empty scan dump ======");
    log("DIAG [data-urn] count:", urnEls.length);
    log("DIAG [data-id] count:", idEls.length);
    log(
      "DIAG sample data-urn:",
      Array.from(urnEls).slice(0, 6).map((e) => e.getAttribute("data-urn"))
    );
    log(
      "DIAG sample data-id:",
      Array.from(idEls).slice(0, 6).map((e) => e.getAttribute("data-id"))
    );

    // Every distinct class token that looks feed-related.
    const tokens = new Set();
    document.querySelectorAll("div[class]").forEach((e) => {
      if (typeof e.className !== "string") return;
      e.className.split(/\s+/).forEach((t) => {
        if (/update|feed|fie-|occludable|main-feed|activity/i.test(t)) tokens.add(t);
      });
    });
    log("DIAG feed-ish class tokens:", Array.from(tokens).slice(0, 30));

    // What's actually inside the main feed column.
    const main = document.querySelector("main");
    if (main) {
      log("DIAG main child count:", main.querySelectorAll(":scope > *").length);
      const deepDivs = main.querySelectorAll("div");
      log("DIAG total divs inside main:", deepDivs.length);
      // Find elements that contain a decent chunk of text (likely posts).
      const texty = Array.from(main.querySelectorAll("div")).filter((d) => {
        const t = (d.innerText || "").trim();
        return t.length > 80 && d.querySelectorAll("div").length < 40;
      });
      log("DIAG candidate text blocks in main:", texty.length);
      if (texty[0]) {
        log("DIAG first candidate className:", texty[0].className);
        log("DIAG first candidate attrs:",
          Array.from(texty[0].attributes).map((a) => `${a.name}="${a.value}"`).join(" ").slice(0, 200));
      }
    } else {
      log("DIAG no <main> element found");
    }
    log("DIAG iframe count:", document.querySelectorAll("iframe").length);
  }

  function reprocessAll() {
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
      el.removeAttribute(PROCESSED_ATTR);
    });
    scan(document);
  }

  let observer = null;
  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // Scan on the next animation frame — before the browser paints — so a
    // matching post is blurred in the same frame it appears. No visible flash.
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan(document);
    });
  }

  async function init() {
    log("content script loaded on", location.href);
    settings = await getSettings();
    log("settings:", settings);
    await loadMutedAuthors();
    log("muted authors:", Array.from(mutedAuthors));
    scan(document);

    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      getSettings().then((s) => {
        settings = s;
        classifyCache.clear();
        reprocessAll();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

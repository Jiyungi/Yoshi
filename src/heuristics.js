/**
 * heuristics.js
 *
 * Pure, offline, zero-cost scoring for LinkedIn feed posts.
 * No network calls. No data leaves the browser.
 *
 * The scorer returns a result in the range 0..1 plus the list of
 * rules that fired, so the UI can explain *why* a post was flagged.
 *
 * Exposed on window as `FeedDeclutterHeuristics` so the content
 * script (loaded after this file) can use it without bundling.
 */
(function () {
  "use strict";

  // --- Signal phrases commonly seen in humblebrag / AI-template posts.
  // Each pattern has a weight. These are intentionally conservative;
  // tune them from the popup-exposed threshold rather than here.
  const PHRASE_RULES = [
    { re: /\bhumbled (and|&) (excited|honored|thrilled)\b/i, w: 0.45, tag: "humblebrag" },
    { re: /\b(i am|i'm|im) (so |beyond |incredibly |truly )?(thrilled|excited|humbled|honored|proud) to (announce|share)\b/i, w: 0.45, tag: "announcement-template" },
    { re: /\bexcited to (announce|share)\b/i, w: 0.3, tag: "announcement-template" },
    { re: /\bdelighted to (announce|share)\b/i, w: 0.3, tag: "announcement-template" },
    { re: /\bcongratulations to me\b/i, w: 0.5, tag: "self-congrats" },
    { re: /\bi (got|just got) (into|accepted|an offer)\b/i, w: 0.3, tag: "self-congrats" },
    { re: /\b(humbled|honou?red|proud|thrilled)\b.{0,40}\bto (receive|win|be (named|awarded|recognized|selected))\b/i, w: 0.4, tag: "award-brag" },
    { re: /\b(won|received|awarded|named|recognized|selected)\b.{0,30}\b(award|prize|honou?r|scholarship|medal|30 under 30|40 under 40)\b/i, w: 0.35, tag: "award-brag" },
    { re: /\b(graduated|graduating|earned my|received my|completed my)\b.{0,30}\b(degree|diploma|bachelor|master|mba|ph\.?d|doctorate)\b/i, w: 0.35, tag: "graduation-brag" },
    { re: /\bofficially a (graduate|college graduate)\b/i, w: 0.35, tag: "graduation-brag" },
    { re: /\b(thoughts|agree)\?\s*$/im, w: 0.25, tag: "engagement-bait" },
    { re: /\bdouble[- ]?tap\b|\bsmash that\b|\bhit (the )?like\b/i, w: 0.4, tag: "engagement-bait" },
    { re: /\bcomment ['"]?\w+['"]? below\b/i, w: 0.4, tag: "engagement-bait" },
    { re: /\brepost (this|if)\b/i, w: 0.35, tag: "engagement-bait" },
    { re: /\bhere('s| is) (why|how|what)\b.*[:\u{1F447}]/iu, w: 0.2, tag: "listicle-hook" },
    { re: /\bunpopular opinion\b/i, w: 0.25, tag: "engagement-bait" },
    { re: /\blet that sink in\b/i, w: 0.3, tag: "filler" },
    { re: /\bgame[- ]?changer\b/i, w: 0.15, tag: "buzzword" },
    { re: /\bas an? (ai|language model)\b/i, w: 0.6, tag: "ai-tell" },
    { re: /\bin today('s| is) (fast[- ]?paced|digital) world\b/i, w: 0.4, tag: "ai-tell" },
    { re: /\bin conclusion\b/i, w: 0.2, tag: "ai-tell" },
    { re: /\bit('s| is) (important|crucial|essential) to (note|remember|understand)\b/i, w: 0.2, tag: "ai-tell" }
  ];

  // Emoji used as bullet markers at line starts (rocket, check, fire, etc.)
  const EMOJI_BULLET_RE = /^\s*(?:[\u2022\u2023\u25E6\u2043\u2219]|\uD83D[\uDE80-\uDEFF]|\u2705|\uD83D\uDD25|\uD83D\uDCA1|\uD83D\uDC49|\u2728|\uD83C\uDF89)\s+/u;

  // Generic emoji matcher for density scoring.
  const EMOJI_GLOBAL_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

  const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;

  function clamp01(n) {
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function countMatches(str, re) {
    const m = str.match(re);
    return m ? m.length : 0;
  }

  /**
   * Score a single post's text.
   * @param {string} text raw visible text of the post
   * @returns {{score:number, reasons:string[], tags:string[]}}
   */
  function score(text) {
    const reasons = [];
    const tags = new Set();
    let s = 0;

    if (!text || !text.trim()) {
      return { score: 0, reasons, tags: [] };
    }

    const trimmed = text.trim();
    const lines = trimmed.split(/\r?\n/);
    const words = trimmed.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // 1) Phrase rules
    for (const rule of PHRASE_RULES) {
      if (rule.re.test(trimmed)) {
        s += rule.w;
        tags.add(rule.tag);
        reasons.push(`matched "${rule.tag}"`);
      }
    }

    // 2) Emoji-bullet formatting (the classic LinkedIn list-post look)
    const emojiBulletLines = lines.filter((l) => EMOJI_BULLET_RE.test(l)).length;
    if (emojiBulletLines >= 3) {
      s += 0.3;
      tags.add("emoji-bullets");
      reasons.push(`${emojiBulletLines} emoji-bullet lines`);
    } else if (emojiBulletLines === 2) {
      s += 0.15;
      tags.add("emoji-bullets");
      reasons.push("2 emoji-bullet lines");
    }

    // 3) One-sentence-per-line cadence with many short lines (AI/template tell)
    const shortLines = lines.filter((l) => {
      const t = l.trim();
      return t.length > 0 && t.split(/\s+/).length <= 8;
    }).length;
    if (lines.length >= 6 && shortLines / lines.length > 0.7) {
      s += 0.2;
      tags.add("staccato-formatting");
      reasons.push("many one-line sentences");
    }

    // 4) Emoji density
    const emojiCount = countMatches(trimmed, EMOJI_GLOBAL_RE);
    if (wordCount > 0) {
      const density = emojiCount / wordCount;
      if (emojiCount >= 8 || density > 0.15) {
        s += 0.2;
        tags.add("emoji-spam");
        reasons.push(`${emojiCount} emoji`);
      }
    }

    // 5) Hashtag clusters
    const hashtagCount = countMatches(trimmed, HASHTAG_RE);
    if (hashtagCount >= 6) {
      s += 0.25;
      tags.add("hashtag-spam");
      reasons.push(`${hashtagCount} hashtags`);
    } else if (hashtagCount >= 4) {
      s += 0.12;
      tags.add("hashtag-spam");
      reasons.push(`${hashtagCount} hashtags`);
    }

    return { score: clamp01(s), reasons, tags: Array.from(tags) };
  }

  window.FeedDeclutterHeuristics = { score };
})();

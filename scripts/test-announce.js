/* Tests the announcement phrase matcher. Run: node scripts/test-announce.js */

const ANNOUNCE_RES = [
  /\b(humbled|thrilled|excited|proud|honou?red|delighted|pleased|happy|grateful)\b[\s\S]{0,40}\bto (announce|share)\b/i,
  /\b(i'?m|i am|im)\b[\s\S]{0,30}\bto (announce|share)\b/i,
  /\b(i'?m|i am|im|i'?ve|i have|i'?ll|i will|i)\b[\s\S]{0,25}\b(starting|started|joining|joined|accepted|begin|beginning)\b[\s\S]{0,30}\b(new )?(role|position|job|chapter|journey|gig|internship|fellowship)\b/i,
  /\b(starting|started|begin|beginning|began)\b[\s\S]{0,12}\ba new (chapter|journey|position|role|adventure|gig)\b/i,
  /\b(i|i'?ve|i have|i'?m|im)\b[\s\S]{0,20}\b(got into|been accepted|accepted (in)?to|got an offer|got accepted|will be joining)\b/i,
  /\bcongratulations to me\b/i,
  /\b(my )?dream (job|school|role|company|internship)\b/i,
  /\b(humbled|honou?red|proud|thrilled|excited|grateful)\b[\s\S]{0,40}\b(to (receive|win|be (named|recognized|selected|awarded))|recipient of|to be the recipient)\b/i,
  /\b(i'?m|i am|im|i'?ve|i have|i)\b[\s\S]{0,30}\b(won|received|been awarded|was awarded|been named|was named|been recognized|been selected|earned)\b[\s\S]{0,30}\b(award|prize|honou?r|recognition|scholarship|fellowship|medal|title|champion|winner|top \d+|30 under 30|40 under 40)\b/i,
  /\b(awarded|named|recognized|selected as|voted)\b[\s\S]{0,20}\b(employee|student|player|leader|professional|rising star) of the (month|year|quarter)\b/i,
  /\b(winner|recipient|finalist)\b[\s\S]{0,20}\bof the\b/i,
  /\b(i'?m|i am|im|i'?ve|i have|i)\b[\s\S]{0,30}\b(graduated|am graduating|will graduate|completed my|earned my|received my|finished my)\b[\s\S]{0,30}\b(degree|diploma|bachelor'?s?|master'?s?|mba|ph\.?d|doctorate|undergrad|graduate)\b/i,
  /\b(proud|thrilled|excited|humbled|happy|grateful)\b[\s\S]{0,40}\b(to graduate|graduate|graduation|to have graduated|to share .{0,20}graduat)/i,
  /\bofficially a (graduate|college graduate|university graduate)\b/i,
  /\bclass of 20\d\d\b[\s\S]{0,30}\b(graduat|degree|proud|done|complete)/i
];
const matchesAnnounce = (t) => !!t && ANNOUNCE_RES.some((re) => re.test(t));

const SHOULD_MATCH = [
  "I'm thrilled to announce that I've started a new role as Senior PM at Acme!",
  "Excited to share that I have accepted an offer from Google!",
  "Humbled and grateful to announce my new position at Meta.",
  "After months of hard work, I got into my dream school!",
  "I'm happy to share that I'm starting a new position as Investment Banking Summer Associate at Wells Fargo in their Real Estate, Gaming, Lodging & Leisure group.",
  "Starting a new chapter in my career journey 🚀",
  "Congratulations to me on this incredible milestone!",
  "I'm proud to announce I've joined the team at OpenAI.",
  "I'm honored to receive the Employee of the Year award!",
  "Thrilled to share that I won the Best Innovator prize at the conference.",
  "I'm humbled to be named to the Forbes 30 under 30 list.",
  "I'm excited to share that I graduated with my Master's degree from Stanford!",
  "Proud to officially be a college graduate. Class of 2026!",
  "I have earned my MBA after three years of hard work."
];

const SHOULD_NOT_MATCH = [
  "Load more",
  "Show more feed updates",
  "We shipped a caching change that cut p99 latency from 340ms to 90ms.",
  "Great talk by the team today on observability.",
  "Check out our new product launch — link in comments.",
  "Suggested  •  Promoted",
  "Recommended for you",
  "Sam Altman just made it official: OpenAI is building robots. I believe this is the logical endpoint. The labs serious about general intelligence are realizing the same thing: pure software hits a ceiling. OpenAI is now formalizing what started as world simulation. The race is on.",
  "Our company won several new clients this quarter thanks to the team.",
  "Congratulations to the graduating class — proud of all of you!"
];

let pass = true;
for (const s of SHOULD_MATCH) {
  const m = matchesAnnounce(s);
  if (!m) { pass = false; console.log("MISS (should match):", s); }
}
for (const s of SHOULD_NOT_MATCH) {
  const m = matchesAnnounce(s);
  if (m) { pass = false; console.log("FALSE POSITIVE (should NOT match):", s); }
}
console.log(pass ? "PASS — all cases correct" : "FAIL — see above");
process.exit(pass ? 0 : 1);

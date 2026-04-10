const { Client } = require('discord.js-selfbot-v13');
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold
} = require('@google/generative-ai');

function requireEnv(name) {
  const v = process.env[name];
  if (v == null || !String(v).trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

/** Discord user token (selfbot). Set in Railway Variables as DISCORD_TOKEN. */
const TOKEN = requireEnv('DISCORD_TOKEN');
/** Google AI Studio key. Set as GEMINI_API_KEY. */
const GEMINI_API_KEY = requireEnv('GEMINI_API_KEY');
/**
 * Optional incoming webhook URL — one URL for every Discord notification this bot sends:
 * chat samples, promotion started/stopped/resumed, user interest. Omit to skip all webhooks.
 */
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();

const PROD_GUILD_ID = '415246288779608064';
const PROD_CHANNEL_ID = '442709792839172099';

/**
 * Every advert is preceded by this much live sampling on PROD_CHANNEL_ID (Gemini + console; optional DISCORD_WEBHOOK_URL embed).
 */
const CHAT_WATCH_DURATION_MS = 5 * 60 * 1000;

/**
 * If the prod sample has at least this many messages in CHAT_WATCH_DURATION_MS, treat chat as "fast":
 * promos are capped at once per hour only (no 600-message shortcut).
 * ~75 msgs / 5 min ~= same bar as ~30 msgs / 2 min (~15 msgs/min).
 */
const CHAT_FAST_THRESHOLD_MESSAGES = 75;

/**
 * Normal tier: fewer than this many msgs in the 5-min sample ⇒ "slow" — message-volume promo rules apply.
 * Otherwise (still below fast tier) ⇒ hourly timer only; no prod message count shortcut.
 */
const CHAT_SLOW_THRESHOLD_MESSAGES = 25;

/** All promos (image + reply) post in PROD_CHANNEL_ID below. Promos pause while this user is online in PROD_GUILD_ID. */
const PROMO_GATE_USERNAME = (process.env.PROMO_GATE_USERNAME || 'johnwall.12').trim().toLowerCase();

const POLL_INTERVAL_MS = 30_000;

/** Minimum time between promos when using timer-only paths (fast tier, or normal non-slow). */
const ADVERT_INTERVAL_MS = 60 * 60 * 1000;
const ADVERT_MESSAGES_VOLUME = 600;
const ADVERT_MESSAGES_SLOW_MIN = 300;

/** Optional: Discord user id for promo gate — set if username lookup fails. */
const PROMO_GATE_USER_ID = (process.env.PROMO_GATE_USER_ID || '').trim();

/** Rotates independently each send (caption i, image i*2 mod len). */
const AD_PROMO_CAPTIONS = [
  'thoughts chat?',
  'w/l',
  'erm',
  'what we thinking',
  'chat idk wat to do'
];

const AD_PROMO_IMAGE_URLS = [
  'https://media.discordapp.net/attachments/1488271310281900194/1492006784720703538/image.png?ex=69d9c319&is=69d87199&hm=48c3e3c51dd5762669d459dfa03941ba7443aeaa78440e4b8fa371c55d2435de&=&format=webp&quality=lossless',
  'https://media.discordapp.net/attachments/1488271310281900194/1492006883320528937/image.png?ex=69d9c331&is=69d871b1&hm=2cd5f76d7d2aa7cf2a9a18511742fa8c8e4c315bb1537572aec61479b8b654ae&=&format=webp&quality=lossless',
  'https://media.discordapp.net/attachments/1488271310281900194/1492007196597162054/image.png?ex=69d9c37b&is=69d871fb&hm=347804db2bf45bcd2f87a8f8c9499e2a74cd3d0fe3423e5e8bf1c0ff6de6a973&=&format=webp&quality=lossless&width=1819&height=856',
  'https://media.discordapp.net/attachments/1488271310281900194/1492007409089253570/image.png?ex=69d9c3ae&is=69d8722e&hm=758e26ced29b06e040c7ace5cc8838d44d448e0d1af9f2d633f9b00f3f9b3613&=&format=webp&quality=lossless&width=550&height=247',
  'https://media.discordapp.net/attachments/1488271310281900194/1492007942684414032/image.png?ex=69d9c42d&is=69d872ad&hm=0c8d2c795548aecaf7ee0743359fc07ef6038f4d524950dbe55189c4df50475f&=&format=webp&quality=lossless'
];

/**
 * Canned robud nudges in prod between image adverts — only on messages with w/l-style text + trade image.
 * Uses same vision + min Value check as Prod W/L (PROD_ROBUD_MIN_VALUE). Disabled when ENABLE_PROD_WL_REPLIES is on.
 */
const ENABLE_PROD_CANNED_REPLY_PROMOS = true;
const REPLY_PROMO_QUOTA_PER_IMAGE_INTERVAL = 5;
const REPLY_PROMO_MIN_PROD_MESSAGES_BETWEEN = 100;
const CANNED_ROBUD_REPLIES = [
  'just get robud',
  'y dont u have robud',
  'get robud instead of sending w/ls',
  'js get robud',
  'just get robud instead of sending w/ls'
];

/** Casual one-liners when someone asks what the promo is — same energy as CANNED_ROBUD_REPLIES, then link on next line. */
const ROBUD_INTEREST_VAGUE_PROMO_LINES = [
  'its robud js a chrome ext for roblox trades / values n w l stuff',
  'oh thats robud browser extension for trading n values ingame',
  'robud lol its for roblox trading w l type stuff',
  'js robud — ext that helps w trades and values',
  'its called robud chrome ext for roblox trade stuff'
];

/**
 * Real server W/L trade-image nudges — off unless you enable.
 */
const ENABLE_PROD_WL_REPLIES = false;
const PROD_WL_USER_COOLDOWN_MS = 120_000;
const PROD_ROBUD_MIN_VALUE = 50_000;

/** If slowmode is off, wait this long before auto-replying on prod nudges (ms). */
const DEFAULT_REPLY_DELAY_MS = 5000;

/**
 * Gemini classifies interest and writes the in-channel reply (no fixed phrase matching).
 * Set ENABLE_PROD_INTEREST_INFO_REPLIES=0 to disable auto-replies (webhook can stay on).
 */
const ENABLE_PROD_INTEREST_INFO_REPLIES = process.env.ENABLE_PROD_INTEREST_INFO_REPLIES !== '0';
/** Min ms between our robud info replies to the same user (follow-ups allowed). */
const PROD_INTEREST_REPLY_COOLDOWN_MS = Number(process.env.PROD_INTEREST_REPLY_COOLDOWN_MS) || 20_000;
const ROBUD_INFO_URL = (
  process.env.ROBUD_INFO_URL ||
  'https://chromewebstore.google.com/detail/robud-roblox-trade-helper/plheomohlllkkidlhlebdaibdpkognop'
).trim();
/** How long we treat a user as “interested” for follow-up Gemini checks (ms). */
const ROBUD_INTEREST_USER_TTL_MS = Number(process.env.ROBUD_INTEREST_USER_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
/**
 * Style / facts the model must follow when generating replies (your “it’s called robud” rules).
 * Edit this list; it is injected into the Gemini prompt.
 */
const ROBUD_REPLY_STYLE_GUIDE = [
  'product is robud (lowercase) — chrome extension for roblox trading / values / w l',
  'match the voice of casual Discord: very short, messy, lowercase ok, "js" for just, "u" ok, no marketing sentences',
  'never sound like a bot, FAQ, or customer support — no em dashes, no "in-game" corporate phrasing, no "hope this helps"',
  `if they need the install link, end with the url on its own last line: ${ROBUD_INFO_URL}`,
  'one or two lines of body text max before the url line; do not list features like a product page'
];
/**
 * Optional: force one exact reply for vague promo questions (full message including url if you want).
 * If unset, a random line from ROBUD_INTEREST_VAGUE_PROMO_LINES + newline + store url.
 */
const ROBUD_INTEREST_CANONICAL_REPLY = (process.env.ROBUD_INTEREST_CANONICAL_REPLY || '').trim();
/** If Gemini fails entirely, random casual line + link (override full text with ROBUD_INTEREST_FALLBACK_REPLY). */
const ROBUD_INTEREST_FALLBACK_REPLY = (process.env.ROBUD_INTEREST_FALLBACK_REPLY || '').trim();

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const GEMINI_RETRIES = 3;
const GEMINI_RETRY_BASE_MS = 1500;

const GEMINI_SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH
  }
];

function getGeminiModel(modelName) {
  return genAI.getGenerativeModel({
    model: modelName,
    safetySettings: GEMINI_SAFETY_SETTINGS
  });
}

function extractTextFromGeminiResult(aiResult, modelLabel) {
  const response = aiResult?.response;
  if (!response) return '';

  let raw = '';
  try {
    raw = response.text();
  } catch (err) {
    const c0 = response.candidates?.[0];
    const parts = c0?.content?.parts;
    if (parts?.length) {
      raw = parts.map((p) => p.text).filter(Boolean).join('');
    }
    if (!raw) {
      const fr = c0?.finishReason;
      const pf = response.promptFeedback;
      console.warn(
        `[Gemini] No extractable text [${modelLabel}]: ${err.message} | finishReason=${fr}` +
          (pf ? ` | promptFeedback=${JSON.stringify(pf)}` : '')
      );
      return '';
    }
  }

  return typeof raw === 'string' ? raw.trim() : '';
}

function polishReplyText(s) {
  if (s == null) return '';
  let out = String(s).trim();
  out = out.replace(/^["']|["']$/g, '').trim();
  out = out.replace(/^[,;:\s]+/, '').trim();
  out = out.replace(/^(idk|i\s*dunno|dunno|not\s+sure)\s*,?\s*/i, '').trim();
  out = out.replace(/\s*[.!?]+$/g, '').trim();
  return out;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildVaguePromoInterestReply() {
  if (ROBUD_INTEREST_CANONICAL_REPLY) return ROBUD_INTEREST_CANONICAL_REPLY;
  return `${pickRandom(ROBUD_INTEREST_VAGUE_PROMO_LINES)}\n${ROBUD_INFO_URL}`;
}

function buildInterestFallbackReply() {
  if (ROBUD_INTEREST_FALLBACK_REPLY) return ROBUD_INTEREST_FALLBACK_REPLY;
  return `${pickRandom(ROBUD_INTEREST_VAGUE_PROMO_LINES)}\n${ROBUD_INFO_URL}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isGeminiRetryableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('service unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('try again later') ||
    msg.includes('resource exhausted') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed')
  );
}

// --- Chat watch (pre-promo, 5 min) ---

let chatWatchActive = false;
let chatWatchWindowStart = 0;
let chatWatchCutoff = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let chatWatchTimer = null;
/** @type {{ id: string, ts: number, author: string, snippet: string }[]} */
let chatWatchBuffer = [];

/** After the first sample completes; used so cadence checks have a tier baseline. */
let promotionTierReady = false;
/** From last sample: true = fast prod chat → hourly promos only. */
let promoProdIsFastChat = false;
/** From last sample: normal tier and "slow" 5-min window → volume + 1h+floor rules; false ⇒ timer only. */
let promoProdIsSlowChat = false;
let botReadyAt = 0;

let cachedAdvertChannel = null;
let cachedAdvertGuild = null;
let cachedPromoGateUserId = PROMO_GATE_USER_ID || null;
/** Updated in poll (and ready); used to skip reply promos without fetching every message. */
let promoGateIsOnline = false;
let pollRunning = false;
let lastAdvertSentAt = null;
/** Messages in PROD_CHANNEL_ID since last advert (drives normal-tier volume rule). */
let advertProdMessagesSinceSend = 0;

/** Monotonic count of human messages in prod (never reset) — spacing for canned reply promos. */
let prodChannelMessageSerial = 0;
let lastCannedReplyAtSerial = -1_000_000_000;
let cannedRepliesSentThisImageInterval = 0;
const cannedReplyNudgedUserIds = new Set();
let imageAdvertEverSent = false;

let promoCaptionRotate = 0;
let promoImageRotate = 0;

/** `undefined` until first observation; then used to avoid duplicate gate webhooks. */
let lastWebhookPromoGateOnline = undefined;

const interestWebhookHandledIds = new Set();
/** Last time we sent an in-channel robud info reply per user (interest flow). */
const prodInterestLastReplyByUserId = new Map();
/** userId -> last time Gemini marked them interested (for follow-up questions). */
const robudInterestedUserLastSeen = new Map();

/** Recent image promo message IDs (this session) — used to detect replies. */
const RECENT_PROMO_MESSAGE_IDS_CAP = 15;
const recentPromoMessageIds = [];

function rememberPromoMessageId(id) {
  if (!id) return;
  recentPromoMessageIds.push(id);
  while (recentPromoMessageIds.length > RECENT_PROMO_MESSAGE_IDS_CAP) {
    recentPromoMessageIds.shift();
  }
}

function formatIso(ms) {
  return new Date(ms).toISOString();
}

function gapBucketLabel(gapMs) {
  if (gapMs < 1000) return '<1s';
  if (gapMs < 5000) return '1-5s';
  if (gapMs < 10000) return '5-10s';
  if (gapMs < 30000) return '10-30s';
  if (gapMs < 60000) return '30-60s';
  if (gapMs < 300000) return '1-5m';
  return '>5m';
}

function computeGapStats(timestampsMs) {
  if (timestampsMs.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < timestampsMs.length; i++) {
    gaps.push(timestampsMs[i] - timestampsMs[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);
  const avg = sum / gaps.length;
  const med = gaps[Math.floor(gaps.length / 2)];
  const min = gaps[0];
  const max = gaps[gaps.length - 1];
  const bucketCounts = {};
  for (const g of gaps) {
    const b = gapBucketLabel(g);
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
  }
  return { avg, med, min, max, bucketCounts, gapCount: gaps.length };
}

function stringifyBucketCounts(bc) {
  return Object.entries(bc)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

function appendChatWatchSample(message) {
  if (!chatWatchActive) return;
  if (message.channel?.id !== PROD_CHANNEL_ID || message.guild?.id !== PROD_GUILD_ID) return;
  if (message.author?.bot) return;
  if (message.author?.id === message.client?.user?.id) return;
  if (message.createdTimestamp < chatWatchWindowStart) return;
  if (Date.now() > chatWatchCutoff) return;

  const snippet =
    (message.content || '').replace(/\s+/g, ' ').trim().slice(0, 160) ||
    (message.attachments?.size ? `[${message.attachments.size} attachment(s)]` : '(no text)');

  chatWatchBuffer.push({
    id: message.id,
    ts: message.createdTimestamp,
    author: message.author?.tag || 'unknown',
    snippet
  });
}

async function summarizeChatActivityWithGemini(report) {
  const prompt = `You are summarizing Discord channel activity from a short observation window.

Below is JSON computed by a script (message timestamps, counts, gaps between consecutive messages in seconds, and a histogram of how often gaps fall into buckets like <1s, 5-10s, 30-60s, 1-5m, etc.).

${JSON.stringify(report, null, 2)}

Write 2-5 short sentences:
1) Overall how active was chat (dead / quiet / moderate / busy / very fast) using the message count and the ${report.windowSeconds}s window.
2) Typical pacing — e.g. messages roughly every second, few seconds, tens of seconds, around a minute, etc. Use median and average gap when helpful; mention if gaps are very uneven (bursts vs long pauses) using min vs max.
3) One short sentence: if promoTier is "fast", hourly-only promos; if "normal" and promoChatSlow is true, volume-or-time rules; if "normal" and not slow, hourly timer only (no message threshold).
4) Keep it factual; no need to invent reasons.

Plain text only, no markdown.`;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGeminiModel(modelName);
      const result = await model.generateContent(prompt);
      const t = extractTextFromGeminiResult(result, `chat-activity-${modelName}`);
      if (t) return t;
    } catch (e) {
      console.warn(`[Chat watch] Gemini error [${modelName}]:`, e.message || e);
    }
  }
  return 'Gemini summary unavailable.';
}

async function postDiscordWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn('[Webhook] HTTP', res.status, res.statusText);
    }
  } catch (e) {
    console.warn('[Webhook] Error:', e.message || e);
  }
}

function getPromoGateDisplayLabel(member) {
  if (!member) return PROMO_GATE_USERNAME;
  const d = member.displayName && String(member.displayName).trim();
  if (d) return d;
  return member.user?.username || PROMO_GATE_USERNAME;
}

/**
 * Ping webhook when promo gate goes online (stop promos) or offline (resume promos).
 * First observed state does not ping (baseline).
 */
async function emitPromoGateStateWebhookIfChanged(gateOnline, gateMember) {
  if (!DISCORD_WEBHOOK_URL) return;
  if (lastWebhookPromoGateOnline === undefined) {
    lastWebhookPromoGateOnline = gateOnline;
    return;
  }
  if (lastWebhookPromoGateOnline === gateOnline) return;
  lastWebhookPromoGateOnline = gateOnline;
  const label = getPromoGateDisplayLabel(gateMember);
  if (gateOnline) {
    await postDiscordWebhook({
      embeds: [
        {
          title: 'Promotion stopped',
          description: `${label} is online — pausing promos until they go offline.`,
          color: 0xe74c3c,
          timestamp: new Date().toISOString()
        }
      ]
    });
    console.log(`[Webhook] Promotion stopped — ${label} online`);
  } else {
    await postDiscordWebhook({
      embeds: [
        {
          title: 'Promotion resumed',
          description: `${label} is offline — promos are allowed (cadence + sampling still apply).`,
          color: 0x2ecc71,
          timestamp: new Date().toISOString()
        }
      ]
    });
    console.log(`[Webhook] Promotion resumed — ${label} offline`);
  }
}

async function emitPromotionStartedWebhook(sentMessage) {
  if (!DISCORD_WEBHOOK_URL || !sentMessage?.id) return;
  const jump = `https://discord.com/channels/${PROD_GUILD_ID}/${PROD_CHANNEL_ID}/${sentMessage.id}`;
  const caption = (sentMessage.content || '').trim() || '—';
  await postDiscordWebhook({
    embeds: [
      {
        title: 'Promotion started',
        description: `Image promo posted in <#${PROD_CHANNEL_ID}>.`,
        url: jump,
        color: 0xf1c40f,
        fields: [
          { name: 'Caption', value: caption.slice(0, 900), inline: false },
          { name: 'Jump', value: `[Open promo message](${jump})`, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  });
  console.log('[Webhook] Promotion started — image sent');
}

function pruneRobudInterestedUsers() {
  const now = Date.now();
  for (const [uid, t] of robudInterestedUserLastSeen) {
    if (now - t > ROBUD_INTEREST_USER_TTL_MS) robudInterestedUserLastSeen.delete(uid);
  }
}

function userIsRobudInterested(uid) {
  const t = robudInterestedUserLastSeen.get(uid);
  if (t == null) return false;
  if (Date.now() - t > ROBUD_INTEREST_USER_TTL_MS) {
    robudInterestedUserLastSeen.delete(uid);
    return false;
  }
  return true;
}

/**
 * Loose pre-filter so we do not call Gemini on every prod line — Gemini still decides real interest.
 */
/** Short vague identity questions on a promo thread → casual fixed reply (same vibe as CANNED_ROBUD_REPLIES), not Gemini paraphrase. */
function isVaguePromoIdentityQuestion(raw) {
  const t = (raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 100) return false;
  if (/\bwhat\s+is\s+(this|that|it)\b/.test(t)) return true;
  if (/\bwhat('?s| is)\s+that\b/.test(t)) return true;
  if (/\bwhat\s+are\s+you\s+(showing|posting)\b/.test(t)) return true;
  if (/\bwhat\s+extension\b/.test(t) && t.length < 80) return true;
  return false;
}

function messageMaybeRobudRelatedColdScan(raw) {
  const t = (raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  if (/\b(what|how|where|which|who|why)\b/.test(t)) return true;
  if (
    /\b(extension|plugin|addon|browser|chrome|install|download|website|link|url)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(get|grab)\s+(it|that|this)\b/.test(t)) return true;
  if (/\brobud\b/.test(t)) return true;
  return false;
}

function parseInterestGeminiJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    const interested = Boolean(o.interested);
    const replyText =
      o.replyText != null && String(o.replyText).trim() ? String(o.replyText).trim() : '';
    const contextNote =
      o.contextNote != null && String(o.contextNote).trim()
        ? String(o.contextNote).trim().slice(0, 120)
        : '';
    return { interested, replyText, contextNote };
  } catch {
    return null;
  }
}

async function classifyAndReplyRobudInterestWithGemini(message, { replyToPromo, alreadyInterested }) {
  const styleBlock = ROBUD_REPLY_STYLE_GUIDE.map((line, i) => `${i + 1}. ${line}`).join('\n');

  const contextLines = [];
  if (replyToPromo) {
    contextLines.push(
      'This message is a REPLY to our recent image promo in the same channel (screenshot ad).'
    );
  }
  if (alreadyInterested) {
    contextLines.push(
      'This user was already marked interested in robud recently — they may be asking a follow-up (what it is, how to get it, what it does).'
    );
  }
  const contextBlock =
    contextLines.length > 0 ? `${contextLines.join('\n')}\n\n` : '';

  const msgText = (message.content || '').trim() || '(no text — attachments only or empty)';

  const prompt = `You are helping a Discord selfbot decide if a human is genuinely asking about a promoted product called "robud" (Roblox trade helper browser extension).

${contextBlock}User message:
---
${msgText.slice(0, 1800)}
---

Decide if they are interested in learning about robud / the extension / how to get it / what it does — including informal or vague wording, typos, or hostility mixed with a real question. If they are clearly only trash-talking with NO genuine question about the product, not interested.

Style rules for your reply (when you do reply):
${styleBlock}

Respond with JSON ONLY, no markdown, no extra keys:
{"interested": true or false, "replyText": "string — empty if not interested", "contextNote": "brief label for logs e.g. promo_reply_question"}

If interested is false, replyText must be "".
If interested is true, replyText must be under 400 characters, 1-2 short lines of messy casual text, then if they need the link add a newline and the chrome web store url alone on the last line. Sound like a normal user typing fast, not a product description.

Good voice examples (do not repeat verbatim): "js robud chrome ext for trades n values" / "its robud lol helps w w l stuff" / "oh thats robud u can grab it here" + url`;

  for (let attempt = 0; attempt < GEMINI_RETRIES; attempt++) {
    for (const modelName of GEMINI_MODELS) {
      try {
        const model = getGeminiModel(modelName);
        const result = await model.generateContent(prompt);
        const text = extractTextFromGeminiResult(result, `interest-${modelName}`);
        const parsed = parseInterestGeminiJson(text);
        if (parsed) return parsed;
      } catch (e) {
        if (isGeminiRetryableError(e) && attempt < GEMINI_RETRIES - 1) {
          await sleep(GEMINI_RETRY_BASE_MS * 2 ** attempt);
        } else {
          console.warn(`[Interest] Gemini error [${modelName}]:`, e.message || e);
        }
      }
    }
  }
  return null;
}

async function trySendProdGeminiInterestReply(message, replyBody) {
  if (!ENABLE_PROD_INTEREST_INFO_REPLIES) return;
  if (promoGateIsOnline) return;

  const uid = message.author.id;
  const last = prodInterestLastReplyByUserId.get(uid) || 0;
  if (Date.now() - last < PROD_INTEREST_REPLY_COOLDOWN_MS) return;

  const ch = await message.client.channels
    .fetch(PROD_CHANNEL_ID, { force: true })
    .catch(() => null);
  const delay = ch ? replyDelayMs(ch) : DEFAULT_REPLY_DELAY_MS;
  await sleep(delay);

  let safe = (replyBody || '').trim().slice(0, 1990);
  if (!safe) safe = buildInterestFallbackReply().slice(0, 1990);

  try {
    await message.reply(safe);
    prodInterestLastReplyByUserId.set(uid, Date.now());
    console.log(`[Interest reply] → ${message.author.tag}`);
  } catch (e) {
    console.warn('[Interest reply] Failed:', e.message || e);
  }
}

async function messageIsReplyToOurPromo(message) {
  if (message.channel?.id !== PROD_CHANNEL_ID || message.guild?.id !== PROD_GUILD_ID) return false;
  const refId = message.reference?.messageId;
  if (!refId) return false;
  if (recentPromoMessageIds.includes(refId)) return true;
  try {
    const ref = await message.fetchReference().catch(() => null);
    if (!ref || ref.author?.id !== message.client.user?.id) return false;
    return Boolean(ref.attachments?.size);
  } catch {
    return false;
  }
}

async function tryHandleProdUserInterest(message) {
  if (message.channel?.id !== PROD_CHANNEL_ID || message.guild?.id !== PROD_GUILD_ID) return;
  if (!message.author?.id || message.author.bot || message.author.id === message.client.user.id) return;
  if (cachedPromoGateUserId && message.author.id === cachedPromoGateUserId) return;
  if (interestWebhookHandledIds.has(message.id)) return;

  const replyToPromo = await messageIsReplyToOurPromo(message);
  const alreadyInterested = userIsRobudInterested(message.author.id);
  const coldOk = messageMaybeRobudRelatedColdScan(message.content);

  if (!replyToPromo && !alreadyInterested && !coldOk) return;

  interestWebhookHandledIds.add(message.id);
  if (interestWebhookHandledIds.size > 5000) interestWebhookHandledIds.clear();

  pruneRobudInterestedUsers();

  const gemini = await classifyAndReplyRobudInterestWithGemini(message, {
    replyToPromo,
    alreadyInterested
  });

  if (!gemini?.interested) {
    if (gemini === null) {
      console.warn('[Interest] Gemini returned no parseable result — skip webhook/reply');
    }
    return;
  }

  robudInterestedUserLastSeen.set(message.author.id, Date.now());

  const useCasualVaguePromoReply =
    replyToPromo && isVaguePromoIdentityQuestion(message.content);

  if (DISCORD_WEBHOOK_URL) {
    const jump = `https://discord.com/channels/${PROD_GUILD_ID}/${PROD_CHANNEL_ID}/${message.id}`;
    let avatar = '';
    try {
      avatar =
        typeof message.author.displayAvatarURL === 'function'
          ? message.author.displayAvatarURL({ dynamic: true, size: 256 })
          : '';
    } catch {
      avatar = '';
    }

    const contextParts = [];
    if (replyToPromo) contextParts.push('Reply to image promo');
    if (alreadyInterested) contextParts.push('Follow-up (known interested)');
    if (useCasualVaguePromoReply) contextParts.push('Casual fixed (vague promo question)');
    if (gemini.contextNote) contextParts.push(gemini.contextNote);
    const contextLine = contextParts.length ? contextParts.join(' · ') : 'Gemini: interested';

    const embed = {
      title: 'User interested',
      url: jump,
      color: 0x57f287,
      author: {
        name: message.author.tag,
        ...(avatar ? { icon_url: avatar } : {})
      },
      ...(avatar ? { thumbnail: { url: avatar } } : {}),
      fields: [
        {
          name: 'Username',
          value: message.author.tag,
          inline: true
        },
        {
          name: 'Context',
          value: contextLine.slice(0, 256),
          inline: true
        },
        {
          name: 'Message',
          value: (message.content || '(no text)').slice(0, 900) || '—',
          inline: false
        },
        {
          name: 'Jump',
          value: `[Open message](${jump})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString()
    };

    try {
      await postDiscordWebhook({ embeds: [embed] });
      console.log(`[Webhook] Interest ping — ${message.author.tag}`);
    } catch (e) {
      console.warn('[Webhook] Interest ping failed:', e.message || e);
    }
  }

  const replyBody = useCasualVaguePromoReply ? buildVaguePromoInterestReply() : gemini.replyText;
  await trySendProdGeminiInterestReply(message, replyBody);
}

async function postOptionalChatWatchWebhook({
  geminiSummary,
  report,
  promoCadenceBlurb,
  gapLine,
  isFastTier
}) {
  const embed = {
    title: `Chat activity sample — channel ${PROD_CHANNEL_ID}`,
    description: geminiSummary.slice(0, 4096),
    color: 0x3498db,
    fields: [
      { name: 'Messages (window)', value: String(report.messageCount), inline: true },
      { name: 'Tier', value: isFastTier ? 'fast' : 'normal', inline: true },
      { name: 'Gaps', value: gapLine.slice(0, 1024), inline: false },
      { name: 'Cadence', value: promoCadenceBlurb.slice(0, 1024), inline: false }
    ],
    timestamp: new Date().toISOString()
  };
  await postDiscordWebhook({ embeds: [embed] });
  console.log('[Chat watch] Webhook posted (sample).');
}

function startPrePromoSample() {
  if (chatWatchActive) {
    console.warn('[Chat watch] Sample already in progress — skip duplicate start.');
    return;
  }
  if (chatWatchTimer) {
    clearTimeout(chatWatchTimer);
    chatWatchTimer = null;
  }
  chatWatchWindowStart = Date.now();
  chatWatchCutoff = chatWatchWindowStart + CHAT_WATCH_DURATION_MS;
  chatWatchBuffer = [];
  chatWatchActive = true;
  console.log(
    `[Chat watch] ${CHAT_WATCH_DURATION_MS / 60000} min pre-promo sample started — <#${PROD_CHANNEL_ID}>`
  );
  chatWatchTimer = setTimeout(() => {
    chatWatchTimer = null;
    runChatWatchReport().catch((e) => console.error('[Chat watch] Report failed:', e.message || e));
  }, CHAT_WATCH_DURATION_MS);
}

async function runChatWatchReport() {
  chatWatchActive = false;

  const first = chatWatchBuffer[0] || null;
  const last = chatWatchBuffer.length ? chatWatchBuffer[chatWatchBuffer.length - 1] : null;
  const timestamps = chatWatchBuffer.map((e) => e.ts);
  const gapStats = computeGapStats(timestamps);

  const report = {
    channelId: PROD_CHANNEL_ID,
    guildId: PROD_GUILD_ID,
    windowSeconds: CHAT_WATCH_DURATION_MS / 1000,
    windowStartedAt: formatIso(chatWatchWindowStart),
    windowEndedAt: formatIso(Date.now()),
    messageCount: chatWatchBuffer.length,
    firstMessage: first
      ? { id: first.id, at: formatIso(first.ts), author: first.author, snippet: first.snippet }
      : null,
    lastMessage: last
      ? { id: last.id, at: formatIso(last.ts), author: last.author, snippet: last.snippet }
      : null,
    deltaFromFirstToLastMs:
      first && last && last.ts >= first.ts ? last.ts - first.ts : null,
    gapsBetweenConsecutiveMessages: gapStats
      ? {
          count: gapStats.gapCount,
          averageSec: Math.round((gapStats.avg / 1000) * 10) / 10,
          medianSec: Math.round((gapStats.med / 1000) * 10) / 10,
          minSec: Math.round((gapStats.min / 1000) * 10) / 10,
          maxSec: Math.round((gapStats.max / 1000) * 10) / 10,
          buckets: gapStats.bucketCounts
        }
      : null
  };

  const isFastTier = report.messageCount >= CHAT_FAST_THRESHOLD_MESSAGES;
  const isSlowCadence = !isFastTier && report.messageCount < CHAT_SLOW_THRESHOLD_MESSAGES;
  report.promoTier = isFastTier ? 'fast' : 'normal';
  report.promoChatSlow = isSlowCadence;
  report.promoTierExplanation = isFastTier
    ? `Fast prod chat (>=${CHAT_FAST_THRESHOLD_MESSAGES} msgs in ${report.windowSeconds}s): image promos capped at once per ${ADVERT_INTERVAL_MS / 3600000} hour only.`
    : isSlowCadence
      ? `Normal prod chat (slow: <${CHAT_SLOW_THRESHOLD_MESSAGES} msgs / ${report.windowSeconds}s): next promo after ${ADVERT_MESSAGES_VOLUME} prod msgs since last, OR ${ADVERT_INTERVAL_MS / 3600000}h + ≥${ADVERT_MESSAGES_SLOW_MIN} msgs.`
      : `Normal prod chat (not slow): image promos on a ${ADVERT_INTERVAL_MS / 3600000}h timer only — no message-count shortcut.`;

  console.log('[Chat watch] Computed report:', JSON.stringify(report, null, 2));

  const geminiSummary = await summarizeChatActivityWithGemini(report);

  const promoCadenceBlurb = isFastTier
    ? `Fast prod chat (${report.messageCount} ≥ ${CHAT_FAST_THRESHOLD_MESSAGES} in ${report.windowSeconds}s) → image promos in ${PROD_CHANNEL_ID} only every ${ADVERT_INTERVAL_MS / 3600000}h (no ${ADVERT_MESSAGES_VOLUME}-message shortcut).`
    : isSlowCadence
      ? `Normal slow (${report.messageCount} < ${CHAT_SLOW_THRESHOLD_MESSAGES} in ${report.windowSeconds}s) → ${ADVERT_MESSAGES_VOLUME} prod msgs since last OR ${ADVERT_INTERVAL_MS / 3600000}h + ≥${ADVERT_MESSAGES_SLOW_MIN} msgs.`
      : `Normal active (${report.messageCount} ≥ ${CHAT_SLOW_THRESHOLD_MESSAGES}, <${CHAT_FAST_THRESHOLD_MESSAGES}) → promos every ${ADVERT_INTERVAL_MS / 3600000}h only.`;

  const gapLine = gapStats
    ? `avg ${(gapStats.avg / 1000).toFixed(1)}s · med ${(gapStats.med / 1000).toFixed(1)}s · min ${(gapStats.min / 1000).toFixed(1)}s · max ${(gapStats.max / 1000).toFixed(1)}s`
    : '(fewer than 2 messages — no gaps)';

  console.log('[Chat watch] Gemini summary:\n', geminiSummary);
  console.log('[Chat watch] Gap summary:', gapLine);
  console.log('[Chat watch] Cadence:', promoCadenceBlurb);
  if (first) {
    console.log(
      `[Chat watch] First: ${first.author} @ ${formatIso(first.ts)} — ${first.snippet.slice(0, 120)}`
    );
  }
  if (last) {
    console.log(
      `[Chat watch] Last:  ${last.author} @ ${formatIso(last.ts)} — ${last.snippet.slice(0, 120)}`
    );
  }
  if (gapStats) {
    console.log('[Chat watch] Gap buckets:', stringifyBucketCounts(gapStats.bucketCounts));
  }

  await postOptionalChatWatchWebhook({
    geminiSummary,
    report,
    promoCadenceBlurb,
    gapLine,
    isFastTier
  });

  promoProdIsFastChat = isFastTier;
  promoProdIsSlowChat = isSlowCadence;
  promotionTierReady = true;
  console.log(
    `[Promo] Prod sample done — ${report.messageCount} msgs / ${report.windowSeconds}s → ` +
      (promoProdIsFastChat
        ? `FAST tier (promos: ${ADVERT_INTERVAL_MS / 3600000}h only)`
        : promoProdIsSlowChat
          ? `NORMAL SLOW (${ADVERT_MESSAGES_VOLUME} msgs or ${ADVERT_INTERVAL_MS / 3600000}h + ${ADVERT_MESSAGES_SLOW_MIN})`
          : `NORMAL ACTIVE (${ADVERT_INTERVAL_MS / 3600000}h timer only)`)
  );

  await trySendAdvertAfterSample();
}

async function trySendAdvertAfterSample() {
  if (!cachedAdvertGuild || !cachedAdvertChannel) return;

  const gate = await getPromoGateMember(cachedAdvertGuild);
  if (!gate) {
    console.warn(`[Advert] Promo gate user unresolved (${PROMO_GATE_USERNAME}) — not sending.`);
    return;
  }
  promoGateIsOnline = isEffectivelyOnline(gate);
  await emitPromoGateStateWebhookIfChanged(promoGateIsOnline, gate);
  if (promoGateIsOnline) {
    console.log(`[Advert] Promo gate online (${PROMO_GATE_USERNAME}) — not sending.`);
    return;
  }

  const cadence = canSendAdvertByCadence();
  if (!cadence.ok) {
    console.log(`[Advert] After sample — hold: ${cadence.reason}`);
    return;
  }

  console.log(`[Advert] Sending after pre-promo sample — ${cadence.reason}`);
  try {
    await sendAdvert(cachedAdvertChannel);
    noteAdvertSent();
  } catch (e) {
    console.error('[Advert] Send failed:', e.message || e);
  }
}

function canSendAdvertByCadence() {
  if (!promotionTierReady) {
    return { ok: false, reason: 'waiting for first prod chat sample' };
  }

  if (lastAdvertSentAt == null) {
    if (promoProdIsFastChat) {
      const since = Date.now() - botReadyAt;
      if (since < ADVERT_INTERVAL_MS) {
        return {
          ok: false,
          reason: `fast prod chat: first promo in ${Math.ceil((ADVERT_INTERVAL_MS - since) / 60000)} min`
        };
      }
      return { ok: true, reason: 'fast prod chat: first promo (1h since bot ready)' };
    }
    if (!promoProdIsSlowChat) {
      const since = Date.now() - botReadyAt;
      if (since < ADVERT_INTERVAL_MS) {
        return {
          ok: false,
          reason: `normal active chat: first promo in ${Math.ceil((ADVERT_INTERVAL_MS - since) / 60000)} min`
        };
      }
      return { ok: true, reason: 'normal active chat: first promo (1h since bot ready)' };
    }
    return { ok: true, reason: 'normal slow chat: first promo' };
  }

  const msgs = advertProdMessagesSinceSend;

  if (promoProdIsFastChat) {
    const elapsed = Date.now() - lastAdvertSentAt;
    if (elapsed < ADVERT_INTERVAL_MS) {
      return {
        ok: false,
        reason: `fast prod chat: next promo in ${Math.ceil((ADVERT_INTERVAL_MS - elapsed) / 60000)} min`
      };
    }
    return { ok: true, reason: 'fast prod chat: 1h since last promo' };
  }

  if (!promoProdIsSlowChat) {
    const elapsed = Date.now() - lastAdvertSentAt;
    if (elapsed < ADVERT_INTERVAL_MS) {
      return {
        ok: false,
        reason: `normal active chat: next promo in ${Math.ceil((ADVERT_INTERVAL_MS - elapsed) / 60000)} min`
      };
    }
    return { ok: true, reason: 'normal active chat: 1h since last promo' };
  }

  if (msgs >= ADVERT_MESSAGES_VOLUME) {
    return { ok: true, reason: `normal slow chat: ${ADVERT_MESSAGES_VOLUME}+ msgs since last promo` };
  }

  const elapsed = Date.now() - lastAdvertSentAt;
  if (elapsed < ADVERT_INTERVAL_MS) {
    return {
      ok: false,
      reason: `normal slow chat: wait ${Math.ceil((ADVERT_INTERVAL_MS - elapsed) / 60000)} min or ${ADVERT_MESSAGES_VOLUME - msgs} more prod msgs`
    };
  }

  if (msgs < ADVERT_MESSAGES_SLOW_MIN) {
    return {
      ok: false,
      reason: `normal slow chat: hour up but still too quiet (${msgs}/${ADVERT_MESSAGES_SLOW_MIN} msgs since last promo)`
    };
  }

  return { ok: true, reason: `normal slow chat: ${ADVERT_INTERVAL_MS / 3600000}h + ${msgs} prod msgs` };
}

function noteAdvertSent() {
  lastAdvertSentAt = Date.now();
  advertProdMessagesSinceSend = 0;
  imageAdvertEverSent = true;
  cannedRepliesSentThisImageInterval = 0;
  cannedReplyNudgedUserIds.clear();
  lastCannedReplyAtSerial = prodChannelMessageSerial;
}

/** Discord CDN: use user token when needed (works on Railway the same as locally if TOKEN is set). */
async function downloadImage(url) {
  let res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) {
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function extensionForPromoAttachment(url, buffer) {
  const u = url.toLowerCase();
  if (u.includes('format=webp') || u.includes('.webp')) return 'webp';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
  return 'png';
}

/** Caption looks like inventory/flip ask, not a pending two-sided trade w/l. */
function prodCaptionLooksLikeNonWlAsk(text) {
  const t = (text || '').toLowerCase().replace(/\s+/g, ' ');
  if (!t) return false;
  if (/what\s+yall\s+think.*\bcan\b.*\bget\b/.test(t)) return true;
  if (/\bwhat\b.*\b(these|this|they|it)\b.*\bcan\b.*\bget\b/.test(t)) return true;
  if (/\b(best|good)\s+flip\b/.test(t)) return true;
  if (/\b(showing|show)\s+(off\s+)?(a\s+)?(good\s+)?(trade|flip)\b/.test(t)) return true;
  return false;
}

function messageContentLooksLikeWlAsk(text) {
  const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/\bw\/?\s*l\b/.test(t)) return true;
  if (/\bwin\s*[/]\s*loss\b/.test(t)) return true;
  if (/\bwin\s+or\s+loss\b/.test(t)) return true;
  return false;
}

async function tryHandleProdCannedReplyPromo(message) {
  if (!ENABLE_PROD_CANNED_REPLY_PROMOS) return false;
  if (ENABLE_PROD_WL_REPLIES) return false;
  if (!imageAdvertEverSent) return false;
  if (message.channel?.id !== PROD_CHANNEL_ID || message.guild?.id !== PROD_GUILD_ID) return false;
  if (!message.author?.id || message.author.bot || message.author.id === message.client.user.id) {
    return false;
  }
  if (cachedPromoGateUserId && message.author.id === cachedPromoGateUserId) return false;

  if (promoGateIsOnline) return false;

  if (cannedRepliesSentThisImageInterval >= REPLY_PROMO_QUOTA_PER_IMAGE_INTERVAL) return false;
  if (cannedReplyNudgedUserIds.has(message.author.id)) return false;
  if (prodChannelMessageSerial - lastCannedReplyAtSerial < REPLY_PROMO_MIN_PROD_MESSAGES_BETWEEN) {
    return false;
  }

  const text = (message.content || '').trim();
  if (!messageContentLooksLikeWlAsk(text)) return false;
  if (prodCaptionLooksLikeNonWlAsk(text)) return false;

  const imagePart = await getFirstInlineImageFromMessage(message);
  if (!imagePart) return false;

  let evaluation;
  try {
    evaluation = await evaluateRobudTradeScreenshot(imagePart, text);
  } catch (e) {
    console.warn('[Reply promo] Vision evaluate failed:', e.message || e);
    return false;
  }

  const decision = robudWorthyFromEvaluation(evaluation);
  if (!decision.worthy) {
    if (decision.reasonKey === 'below_min_value') {
      console.log(
        `[Reply promo] Skip — max Value ${decision.maxValue} < ${PROD_ROBUD_MIN_VALUE} (${message.author.tag})`
      );
    } else if (decision.reasonKey === 'not_wl_trade') {
      console.log(`[Reply promo] Skip — not a pending w/l trade UI (${message.author.tag})`);
    } else if (decision.reasonKey === 'value_unknown') {
      console.log(`[Reply promo] Skip — could not read Value (${message.author.tag})`);
    }
    return false;
  }

  const line = pickRandom(CANNED_ROBUD_REPLIES);
  try {
    await message.reply(line);
    cannedRepliesSentThisImageInterval++;
    lastCannedReplyAtSerial = prodChannelMessageSerial;
    cannedReplyNudgedUserIds.add(message.author.id);
    console.log(
      `[Reply promo] ${cannedRepliesSentThisImageInterval}/${REPLY_PROMO_QUOTA_PER_IMAGE_INTERVAL} → ${message.author.tag} (max Value ${decision.maxValue})`
    );
    return true;
  } catch (e) {
    console.warn('[Reply promo] Failed:', e.message || e);
    return false;
  }
}

function isEffectivelyOnline(member) {
  const s = member?.presence?.status;
  return s === 'online' || s === 'idle' || s === 'dnd';
}

function nameMatches(member, name) {
  const n = name.toLowerCase();
  if (member.user.username.toLowerCase() === n) return true;
  if (member.displayName && member.displayName.toLowerCase() === n) return true;
  if (member.nickname && member.nickname.toLowerCase() === n) return true;
  return false;
}

async function resolveMember(guild, searchQuery, explicitId) {
  if (explicitId) {
    try {
      return await guild.members.fetch(explicitId);
    } catch {
      return null;
    }
  }
  const fetched = await guild.members.fetch({ query: searchQuery, limit: 100 });
  return fetched.find((m) => nameMatches(m, PROMO_GATE_USERNAME)) || null;
}

async function getPromoGateMember(guild) {
  if (!guild || guild.id !== PROD_GUILD_ID) return null;
  if (cachedPromoGateUserId) {
    try {
      return await guild.members.fetch({ user: cachedPromoGateUserId, force: true });
    } catch {
      return null;
    }
  }
  const queryHint = PROMO_GATE_USERNAME.includes('.')
    ? PROMO_GATE_USERNAME.split('.')[0]
    : PROMO_GATE_USERNAME.slice(0, 32);
  const m = await resolveMember(guild, queryHint, PROMO_GATE_USER_ID || undefined);
  if (m) cachedPromoGateUserId = m.id;
  return m;
}

async function sendAdvert(channel) {
  const capN = AD_PROMO_CAPTIONS.length;
  const imgN = AD_PROMO_IMAGE_URLS.length;
  const caption = AD_PROMO_CAPTIONS[promoCaptionRotate % capN];
  const imageUrl = AD_PROMO_IMAGE_URLS[promoImageRotate % imgN];
  promoCaptionRotate++;
  promoImageRotate = (promoImageRotate + 2) % imgN;

  const imageBuffer = await downloadImage(imageUrl);
  const ext = extensionForPromoAttachment(imageUrl, imageBuffer);
  const sent = await channel.send({
    content: caption,
    files: [{ attachment: imageBuffer, name: `promo.${ext}` }]
  });
  rememberPromoMessageId(sent.id);
  console.log(`[Send] Trade image advert — caption: ${JSON.stringify(caption)}`);
  await emitPromotionStartedWebhook(sent);
}

async function pollAdvert() {
  if (pollRunning) return;
  pollRunning = true;

  try {
    if (!cachedAdvertChannel || !cachedAdvertGuild) {
      console.error('[Poll] Advert channel/guild not ready.');
      return;
    }

    if (chatWatchActive) {
      return;
    }

    const guild = cachedAdvertGuild;

    const gate = await getPromoGateMember(guild);
    if (!gate) {
      console.warn(`[Poll] Promo gate unresolved (${PROMO_GATE_USERNAME}) — skip advert tick.`);
      return;
    }
    promoGateIsOnline = isEffectivelyOnline(gate);
    await emitPromoGateStateWebhookIfChanged(promoGateIsOnline, gate);
    if (promoGateIsOnline) {
      console.log(
        `[Poll] Promo gate online (${PROMO_GATE_USERNAME}) — no promos (${new Date().toISOString()})`
      );
      return;
    }

    const cadence = canSendAdvertByCadence();
    if (!cadence.ok) {
      console.log(`[Poll] Advert hold — ${cadence.reason} (prod msgs since send: ${advertProdMessagesSinceSend})`);
      return;
    }

    console.log(`[Poll] Cadence OK — starting ${CHAT_WATCH_DURATION_MS / 60000}m pre-promo sample — ${cadence.reason}`);
    startPrePromoSample();
  } catch (err) {
    console.error('[Poll] Advert error:', err.message || err);
  } finally {
    pollRunning = false;
  }
}

// --- Prod W/L (optional) ---

const prodWlHandledMessageIds = new Set();
const prodWlLastNudgeByUserId = new Map();

async function fetchUrlToImageBuffer(url) {
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) {
    console.warn('[Prod W/L] Image too large, skipping.');
    return null;
  }
  let mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  if (!mime.startsWith('image/')) mime = 'image/png';
  return { buffer: buf, mime };
}

async function fetchUrlToImageInlineData(url) {
  const got = await fetchUrlToImageBuffer(url);
  if (!got) return null;
  return { inlineData: { data: got.buffer.toString('base64'), mimeType: got.mime } };
}

function mimeToSafeFilename(mime, fallback = 'trade.png') {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return 'trade.png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'trade.jpg';
  if (m.includes('gif')) return 'trade.gif';
  if (m.includes('webp')) return 'trade.webp';
  return fallback;
}

async function getFirstInlineImageFromMessage(message) {
  for (const att of message.attachments.values()) {
    const ct = (att.contentType || '').toLowerCase();
    if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(att.name || '')) {
      const part = await fetchUrlToImageInlineData(att.url);
      if (part) return part;
    }
  }
  for (const em of message.embeds) {
    const u = em.image?.url || em.thumbnail?.url;
    if (u) {
      const part = await fetchUrlToImageInlineData(u);
      if (part) return part;
    }
  }
  return null;
}

function parseRobudTradeEvaluation(text) {
  const raw = (text || '').trim();
  let isPendingWlTrade = false;
  let maxValue = null;

  const tradeLine = raw.match(/^\s*TRADE:\s*(YES|NO)\s*$/im);
  if (tradeLine) {
    isPendingWlTrade = tradeLine[1].toUpperCase() === 'YES';
  } else {
    const tradeLoose = raw.match(/\bTRADE:\s*(YES|NO)\b/i);
    if (tradeLoose) isPendingWlTrade = tradeLoose[1].toUpperCase() === 'YES';
  }

  const maxLine = raw.match(/^\s*MAX:\s*(.+)\s*$/im);
  let maxToken = maxLine ? maxLine[1].trim() : null;
  if (!maxToken) {
    const maxLoose = raw.match(/\bMAX:\s*([^\n]+)/i);
    maxToken = maxLoose ? maxLoose[1].trim() : null;
  }
  if (maxToken) {
    const u = maxToken.toUpperCase().replace(/,/g, '');
    if (u === 'UNKNOWN' || u === 'N/A' || u === 'NONE') {
      maxValue = null;
    } else {
      const km = u.match(/^([\d.]+)\s*([KMB])\s*$/);
      if (km) {
        const n = parseFloat(km[1]);
        const suf = km[2];
        if (Number.isFinite(n)) {
          const mult = suf === 'K' ? 1e3 : suf === 'M' ? 1e6 : 1e9;
          maxValue = Math.round(n * mult);
        }
      } else {
        const digits = u.replace(/[^\d]/g, '');
        if (digits.length) maxValue = parseInt(digits, 10);
      }
    }
  }

  if (maxValue !== null && (!Number.isFinite(maxValue) || maxValue < 0)) maxValue = null;

  return { isPendingWlTrade, maxValue };
}

async function evaluateRobudTradeScreenshot(inlineImagePart, messageText) {
  const textHint = (messageText || '').trim().slice(0, 240);
  const prompt = `You are analyzing ONE Discord image for a Roblox trading server.

PART A — TRADE (same rules for both lines)
We ONLY want TRADE: YES when the poster is basically asking for an OPINION on whether a TRADE is a win or loss / worth taking — a live or proposed two-sided trade they want judged (screenshot + "w/l" meaning "should I take this?").

TRADE: YES only if ALL of these fit:
- The UI compares BOTH sides of one trade ("Items you will give" AND "Items you will receive" in future tense, or equivalent two-column give vs get).
- It looks like a decision screen (e.g. Accept/Counter/Decline, or clear two-sided trade review).

TRADE: NO when ANY of these are true:
- Completed trade recap: "Items you gave" / "Items you received", post-trade brag, flip showcase.
- Only one side / "what can I get" inventory value check, not a full two-sided trade.
- Not a trade UI (meme, unrelated, etc.).
- Caption asks what items can get / best flip — treat as NO unless the image is unmistakably a two-sided pending trade review.

Trust image labels (gave/received vs will give/will receive) over a misleading caption.

PART B — MAX VALUE (numeric, for high-value robud nudges only)
Find every number that is explicitly the Rolimons-style **Value** for this trade UI (often a column labeled Value with a distinct icon; also **per-side totals** like total Value under "Items you will give" and "Items you will receive").

You MUST include:
- Each line-item Value shown next to items.
- Each **total / summary Value** for a side if shown (e.g. if "Items you will give" shows total Value 22,000 and two items each show 11,000 Value, all of these count).

You MUST NOT use for MAX:
- RAP or "Total Value (RAP)" or Recent Average Price.
- Demand scores (e.g. 5.0/5.0).
- Percentage or difference bubbles (-18%, etc.).
- Random IDs or unrelated numbers.

The answer for MAX is the **single largest** Value number among the allowed values (compare totals and per-item; pick the maximum). Example: if one side totals 22,000 Value and the other 18,000 Value, MAX is 22000.

Output format — exactly two lines, no markdown, no extra text:
TRADE: YES
MAX: 22000

If Values cannot be read, use:
TRADE: YES or NO (still required)
MAX: UNKNOWN

Discord caption (may be empty): ${JSON.stringify(textHint)}`;

  const parts = [{ text: prompt }, inlineImagePart];

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGeminiModel(modelName);
      const result = await model.generateContent(parts);
      const t = extractTextFromGeminiResult(result, `vision-${modelName}`);
      if (!t || !/\bTRADE:\s*(YES|NO)\b/i.test(t) || !/\bMAX:\s*\S+/i.test(t)) continue;
      return parseRobudTradeEvaluation(t);
    } catch (e) {
      console.warn(`[Prod W/L] Vision evaluate error [${modelName}]:`, e.message || e);
    }
  }
  return { isPendingWlTrade: false, maxValue: null };
}

function robudWorthyFromEvaluation(ev) {
  if (!ev.isPendingWlTrade) {
    return { worthy: false, reasonKey: 'not_wl_trade', maxValue: ev.maxValue };
  }
  if (ev.maxValue == null) {
    return { worthy: false, reasonKey: 'value_unknown', maxValue: null };
  }
  if (ev.maxValue < PROD_ROBUD_MIN_VALUE) {
    return { worthy: false, reasonKey: 'below_min_value', maxValue: ev.maxValue };
  }
  return { worthy: true, reasonKey: 'ok', maxValue: ev.maxValue };
}

async function generateWlRobudNudgeReply() {
  const prompt = `You are zang, 15, on Discord. Someone posted asking the chat to judge a pending roblox trade (w/l style).

Write ONE very short reply (under 12 words) telling them to use the robud browser extension instead of posting trade screenshots here for w/l opinions. lowercase. no period at end. can use "js" to mean "just". can use one emoji if it fits.

Output ONLY the reply text, no quotes.`;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGeminiModel(modelName);
      const result = await model.generateContent(prompt);
      const out = polishReplyText(extractTextFromGeminiResult(result, `wl-nudge-${modelName}`));
      if (out) return out;
    } catch (e) {
      console.warn(`[Prod W/L] Nudge gen error:`, e.message || e);
    }
  }

  return pickRandom([
    'just get robud instead of sending w/ls',
    'js get robud',
    'y dont u have robud its easier than js sending w/ls',
    'just get robud dawg \u{1F62D}'
  ]);
}

function replyDelayMs(channel) {
  const s = channel.rateLimitPerUser ?? 0;
  return s > 0 ? s * 1000 : DEFAULT_REPLY_DELAY_MS;
}

async function tryHandleProdWlChannel(message) {
  if (!ENABLE_PROD_WL_REPLIES) return false;
  const guildId = message.guild?.id;
  const channelId = message.channel?.id;
  if (guildId !== PROD_GUILD_ID || channelId !== PROD_CHANNEL_ID) return false;
  if (message.author.id === message.client.user.id || message.author.bot) return false;
  if (promoGateIsOnline) return false;

  if (prodWlHandledMessageIds.has(message.id)) return true;
  prodWlHandledMessageIds.add(message.id);
  if (prodWlHandledMessageIds.size > 5000) {
    prodWlHandledMessageIds.clear();
  }

  const imagePart = await getFirstInlineImageFromMessage(message);
  if (!imagePart) return true;

  if (prodCaptionLooksLikeNonWlAsk(message.content)) {
    return true;
  }

  let evaluation;
  try {
    evaluation = await evaluateRobudTradeScreenshot(imagePart, message.content);
  } catch (e) {
    console.warn('[Prod W/L] evaluate failed:', e.message || e);
    return true;
  }

  const decision = robudWorthyFromEvaluation(evaluation);
  if (!decision.worthy) {
    if (decision.reasonKey === 'below_min_value') {
      console.log(
        `[Prod W/L] Skip nudge — max Value ${decision.maxValue} < ${PROD_ROBUD_MIN_VALUE}.`
      );
    } else if (decision.reasonKey === 'value_unknown') {
      console.log('[Prod W/L] Skip nudge — could not read Value from screenshot.');
    }
    return true;
  }

  const last = prodWlLastNudgeByUserId.get(message.author.id) || 0;
  if (Date.now() - last < PROD_WL_USER_COOLDOWN_MS) {
    console.log('[Prod W/L] User cooldown, skip nudge.');
    return true;
  }
  prodWlLastNudgeByUserId.set(message.author.id, Date.now());

  const ch = await message.client.channels.fetch(PROD_CHANNEL_ID, { force: true }).catch(() => null);
  const delay = ch ? replyDelayMs(ch) : DEFAULT_REPLY_DELAY_MS;
  await sleep(delay);

  let line;
  try {
    line = await generateWlRobudNudgeReply();
  } catch (e) {
    line = pickRandom([
      'just get robud instead of sending w/ls',
      'js get robud',
      'y dont u have robud its easier than js sending w/ls',
      'just get robud dawg \u{1F62D}'
    ]);
  }

  const safe = polishReplyText(line);
  if (!safe) return true;

  try {
    await message.reply(safe);
    console.log(`[Prod W/L] Nudge sent (${safe.length} chars)`);
  } catch (e) {
    console.warn('[Prod W/L] Reply failed:', e.message || e);
  }
  return true;
}

// --- Client ---

const client = new Client({ checkUpdate: false });

client.on('presenceUpdate', async (oldPresence, newPresence) => {
  try {
    const guild = newPresence?.guild;
    if (!guild || guild.id !== PROD_GUILD_ID) return;
    if (!cachedPromoGateUserId || newPresence.userId !== cachedPromoGateUserId) return;
    const st = newPresence.status;
    const isOn = st === 'online' || st === 'idle' || st === 'dnd';
    promoGateIsOnline = isOn;
    let mem = guild.members.cache.get(newPresence.userId);
    if (!mem) {
      mem = await guild.members.fetch(newPresence.userId, { force: true }).catch(() => null);
    }
    await emitPromoGateStateWebhookIfChanged(isOn, mem);
  } catch (e) {
    console.warn('[presenceUpdate]', e?.message || e);
  }
});

client.on('messageCreate', async (message) => {
  try {
    appendChatWatchSample(message);

    if (
      message.channel?.id === PROD_CHANNEL_ID &&
      message.guild?.id === PROD_GUILD_ID &&
      message.author?.id &&
      message.author.id !== message.client.user.id &&
      !message.author.bot
    ) {
      advertProdMessagesSinceSend++;
      prodChannelMessageSerial++;
    }

    await tryHandleProdUserInterest(message);

    if (await tryHandleProdCannedReplyPromo(message)) return;
    if (await tryHandleProdWlChannel(message)) return;
  } catch (e) {
    console.error('[messageCreate] Unhandled:', e?.message || e);
  }
});

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  botReadyAt = Date.now();
  console.log(
    `[Chat watch] Initial ${CHAT_WATCH_DURATION_MS / 60000}m sample on <#${PROD_CHANNEL_ID}> — then each promo is preceded by another ${CHAT_WATCH_DURATION_MS / 60000}m sample when cadence allows.`
  );
  console.log(
    `[Advert] Image + reply promos in guild ${PROD_GUILD_ID} channel <#${PROD_CHANNEL_ID}> — paused while ${PROMO_GATE_USERNAME} is online.`
  );
  if (ENABLE_PROD_CANNED_REPLY_PROMOS) {
    console.log(
      `[Reply promo] Up to ${REPLY_PROMO_QUOTA_PER_IMAGE_INTERVAL} canned robud replies per image interval in ${PROD_CHANNEL_ID} (≥${REPLY_PROMO_MIN_PROD_MESSAGES_BETWEEN} prod msgs apart, one per user).`
    );
  }
  if (ENABLE_PROD_WL_REPLIES) {
    console.log(`[Prod W/L] ENABLED — trade image nudges in ${PROD_CHANNEL_ID}`);
  }
  if (ENABLE_PROD_INTEREST_INFO_REPLIES) {
    console.log(
      `[Interest reply] Gemini classifies interest in ${PROD_CHANNEL_ID} — generated replies follow ROBUD_REPLY_STYLE_GUIDE; cooldown ${PROD_INTEREST_REPLY_COOLDOWN_MS / 1000}s per user; follow-ups for ${Math.round(ROBUD_INTEREST_USER_TTL_MS / 86400000)}d after first interest.`
    );
  }

  cachedAdvertChannel = await client.channels.fetch(PROD_CHANNEL_ID);
  cachedAdvertGuild = cachedAdvertChannel.guild;
  if (!cachedAdvertGuild) {
    console.error('Promo channel is not in a server.');
    process.exit(1);
  }
  if (cachedAdvertGuild.id !== PROD_GUILD_ID) {
    console.error(
      `Channel ${PROD_CHANNEL_ID} must be in guild ${PROD_GUILD_ID} (got guild ${cachedAdvertGuild.id}).`
    );
    process.exit(1);
  }

  const gateMember = await getPromoGateMember(cachedAdvertGuild);
  if (gateMember) {
    console.log(`[Promo gate] Watching ${gateMember.user.tag} (${gateMember.id}) — promos pause while online.`);
  } else {
    console.warn(
      `[Promo gate] Could not resolve "${PROMO_GATE_USERNAME}" in guild ${PROD_GUILD_ID}. Set PROMO_GATE_USER_ID in env.`
    );
  }

  promoGateIsOnline = Boolean(gateMember && isEffectivelyOnline(gateMember));
  await emitPromoGateStateWebhookIfChanged(promoGateIsOnline, gateMember);

  startPrePromoSample();

  await pollAdvert();
  setInterval(pollAdvert, POLL_INTERVAL_MS);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  client.destroy();
  process.exit(0);
});

client.on('error', (err) => {
  console.error('[Discord client error]', err?.message || err);
});

client.login(TOKEN).catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});

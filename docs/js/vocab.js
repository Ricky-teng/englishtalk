/**
 * vocab.js — 單字本與間隔重複複習
 *
 * 複習排程用 SM-2（Anki 的前身演算法）：答對就把下次複習推遠，答錯就拉回來。
 * 每個單字帶 tag，所以可以照學校課程分組（例如 "B1U3"），複習時只挑那一組。
 *
 * 最關鍵的一點：到期的單字會被塞進對話的系統提示，AI 會在聊天中自然用出來。
 * 「看過 → 在對話裡遇到 → 自己講出來」這個循環，比單純刷卡有效得多。
 */

import { load, save, vocab, uid, todayKey, dayKeyOffset, bumpDaily,
         cacheGet, cacheSet, cacheDrop } from "./store.js";
import { complete, parseJSON } from "./llm.js";

/* ---------- 建立 ---------- */

function blankCard(word, extra = {}) {
  return {
    id: uid(),
    word: word.trim(),
    phonetic: "",
    pos: "",
    zh: "",
    example: "",
    exampleZh: "",
    synonyms: [],     // 近義詞（英文）
    antonyms: [],     // 反義詞（英文）
    tags: [],
    created: Date.now(),
    // --- SM-2 欄位 ---
    ef: 2.5,          // 難易度係數
    interval: 0,      // 目前間隔（天）
    reps: 0,          // 連續答對次數
    lapses: 0,        // 忘記次數
    due: todayKey(),  // 下次複習日期
    lastReview: 0,
    // --- 產出紀錄（跟 SM-2 完全分開的第二條線）---
    // reps 代表「認得」（看卡片答得出來）；produced 代表「說得出來」（對話中自己用出來）。
    // 後者才是真正的學習目標，但它不影響複習排程，只做為另一項指標。
    produced: 0,      // 你在對話中主動說出這個字的次數
    lastProduced: 0,
    heard: 0,         // AI 在對話中用出這個字的次數
    ...extra,
  };
}

export function find(word) {
  const w = String(word || "").trim().toLowerCase();
  return vocab().find(v => v.word.toLowerCase() === w) || null;
}

/** 新增；已存在就回傳既有那張卡（不重複建立） */
export function add(word, extra = {}) {
  const exists = find(word);
  if (exists) {
    // 補上原本沒有的欄位（例如原本手動加的沒有中文）
    for (const [k, val] of Object.entries(extra)) {
      if (val && !exists[k]) exists[k] = val;
    }
    if (extra.tags) exists.tags = [...new Set([...(exists.tags || []), ...extra.tags])];
    save();
    return { card: exists, isNew: false };
  }
  const card = blankCard(word, extra);
  vocab().push(card);
  save();
  return { card, isNew: true };
}

export function remove(id) {
  const list = vocab();
  const i = list.findIndex(v => v.id === id);
  if (i >= 0) { list.splice(i, 1); save(); }
}

export function update(id, patch) {
  const card = vocab().find(v => v.id === id);
  if (!card) return null;
  Object.assign(card, patch);
  save();
  return card;
}

/* ---------- 查詢單字（用使用者自己的 LLM 金鑰） ---------- */

const LOOKUP_PROMPT = (word, context) => `You are a bilingual dictionary for a Traditional \
Chinese speaker learning English. Look up the word "${word}".
${context ? `It appeared in this sentence: "${context}"\nExplain the sense used THERE.` : ""}

Return ONLY a JSON object, no markdown fence, with exactly these keys:
{
  "word": "the base/dictionary form of the word",
  "phonetic": "IPA in slashes, e.g. /prəˈnaʊns/",
  "pos": "part of speech in English, e.g. verb",
  "zh": "the meaning in Traditional Chinese, 15 characters or fewer",
  "example": "one short natural English example sentence using the word",
  "exampleZh": "Traditional Chinese translation of that example",
  "synonyms": [{"w": "an English near-synonym", "zh": "其繁體中文意思(10字內)"}],
  "antonyms": [{"w": "an English antonym", "zh": "其繁體中文意思(10字內)"}]
}

Rules for synonyms and antonyms:
- Give AT MOST 3 synonyms and AT MOST 3 antonyms, ordered most useful first.
- They must match the SAME part of speech and the SAME sense as above.
- Prefer words a learner would actually meet, not rare or literary ones.
- If the word genuinely has no antonym (most nouns), return an empty array. Never invent one.

Use Traditional Chinese characters only (not Simplified). Keep every field short.`;

/**
 * 查一個單字，回傳可直接存進單字本的物件。
 *
 * 查過的字會永久快取，所以同一個字一輩子只呼叫一次 API。
 * 代價是遇到多義字時，快取可能給的是別的語意 —— 彈窗提供「重查」可以強制更新。
 *
 * @param {boolean} force  true 表示忽略快取重新查詢
 */
export async function lookup(word, context = "", force = false) {
  const key = String(word || "").trim();
  if (!force) {
    // 1. 單字本裡已經有完整資料就直接用，連快取都不用碰
    const card = find(key);
    if (card && card.zh) {
      return {
        word: card.word, phonetic: card.phonetic, pos: card.pos, zh: card.zh,
        example: card.example, exampleZh: card.exampleZh,
        synonyms: card.synonyms || [], antonyms: card.antonyms || [],
      };
    }
    // 2. 再看查詢快取
    const hit = cacheGet(key);
    if (hit && hit.zh) {
      return {
        word: hit.word, phonetic: hit.phonetic, pos: hit.pos, zh: hit.zh,
        example: hit.example, exampleZh: hit.exampleZh,
        synonyms: hit.synonyms || [], antonyms: hit.antonyms || [],
      };
    }
  }

  const raw = await complete(LOOKUP_PROMPT(word, context), { json: true, maxTokens: 800 });
  const d = parseJSON(raw);
  const result = {
    word: (d.word || word).trim(),
    phonetic: (d.phonetic || "").trim(),
    pos: (d.pos || "").trim(),
    zh: (d.zh || "").trim(),
    example: (d.example || "").trim(),
    exampleZh: (d.exampleZh || "").trim(),
    synonyms: normRelated(d.synonyms),
    antonyms: normRelated(d.antonyms),
  };
  cacheSet(result.word, result);
  if (result.word.toLowerCase() !== key.toLowerCase()) cacheSet(key, result);  // 變化形也記
  return result;
}

/** 讓使用者強制重查（多義字用錯語意時） */
export function forgetLookup(word) { cacheDrop(word); }

/**
 * 把模型回的近義／反義詞正規化成 [{w, zh}]。
 * 模型有時會回純字串陣列、有時回物件，兩種都要吃得下。
 */
export function normRelated(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr.slice(0, 3)) {
    if (typeof item === "string") {
      const w = item.trim();
      if (w) out.push({ w, zh: "" });
    } else if (item && typeof item === "object") {
      const w = String(item.w || item.word || "").trim();
      if (w) out.push({ w, zh: String(item.zh || item.meaning || "").trim() });
    }
  }
  return out;
}

/**
 * 批次查詢（貼一整課單字表用）。
 * 已經在快取或單字本裡的字會先被扣掉，只有真正沒查過的才送出去。
 * @returns {Object} { byWord: {小寫單字: 資料}, asked: 實際呼叫了幾個字 }
 */
export async function lookupBatchCached(words) {
  const byWord = {};
  const need = [];
  for (const w of words) {
    const k = w.trim().toLowerCase();
    if (!k || byWord[k]) continue;
    const card = find(k);
    if (card && card.zh) { byWord[k] = card; continue; }
    const hit = cacheGet(k);
    if (hit && hit.zh) { byWord[k] = hit; continue; }
    need.push(w);
  }
  if (!need.length) return { byWord, asked: 0 };

  const arr = await lookupBatch(need);
  need.forEach((w, i) => {
    const d = arr[i];
    if (!d) return;
    const norm = {
      word: (d.word || w).trim(),
      phonetic: (d.phonetic || "").trim(),
      pos: (d.pos || "").trim(),
      zh: (d.zh || "").trim(),
      example: (d.example || "").trim(),
      exampleZh: (d.exampleZh || "").trim(),
      synonyms: normRelated(d.synonyms),
      antonyms: normRelated(d.antonyms),
    };
    byWord[w.trim().toLowerCase()] = norm;
    cacheSet(w, norm);
  });
  return { byWord, asked: need.length };
}

/** 批次查詢（貼一整課單字表用），一次最多 20 個，避免超過回應長度 */
export async function lookupBatch(words) {
  const list = words.slice(0, 20);
  const prompt = `You are a bilingual dictionary for a Traditional Chinese speaker learning \
English. Look up each of these words: ${list.map(w => `"${w}"`).join(", ")}.

Return ONLY a JSON array, no markdown fence. Each element:
{"word":"base form","phonetic":"/IPA/","pos":"verb","zh":"繁體中文意思(15字以內)",\
"example":"one short English sentence","exampleZh":"該例句的繁體中文翻譯",\
"synonyms":[{"w":"near-synonym","zh":"中文"}],"antonyms":[{"w":"antonym","zh":"中文"}]}

At most 2 synonyms and 2 antonyms each, same part of speech and sense; empty array if none \
exists (never invent an antonym). Return exactly ${list.length} elements, in the same order. \
Traditional Chinese only.`;
  const raw = await complete(prompt, { json: false, maxTokens: 4000 });
  const arr = parseJSON(raw);
  if (!Array.isArray(arr)) throw new Error("模型沒有回傳陣列");
  return arr;
}

/**
 * 解析貼上的單字表，每行一筆，並保留使用者自己打的中文。
 * 支援：
 *   negotiate
 *   negotiate 談判
 *   negotiate,談判
 *   negotiate<tab>談判
 *   negotiate (v.) 談判、協商
 * 回傳 [{word, zh}]，zh 可能是空字串。
 */
const POS_WORDS = "n|v|vi|vt|adj|adv|prep|conj|pron|int|art|aux";

/** 去掉常見的詞性標記與音標，留下真正的中文意思 */
function cleanMeaning(s) {
  return String(s || "")
    .replace(/^[\s,;:\t，、．.\-–—|]+/, "")
    .replace(new RegExp(`^\\((?:${POS_WORDS})\\.?\\)\\s*`, "i"), "")  // (v.) (adj.)
    .replace(new RegExp(`^(?:${POS_WORDS})\\.\\s*`, "i"), "")         // v. adj.
    .replace(/^\[[^\]]*\]\s*/, "")                                    // [ˈ…] 音標
    .replace(/^\/[^/]*\/\s*/, "")                                     // /ˈ…/ 音標
    .trim();
}

export function parseWordLines(text) {
  const out = [];
  const seen = new Set();

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // 先用明確的分隔符切開（tab、逗號、分號、兩個以上空白），
    // 這樣 "reluctant<tab>adj. 不情願的" 不會把 adj 誤當成片語的一部分。
    const parts = line.split(/\t+|\s*[,;，；]\s*|\s{2,}/);
    let head = parts[0].trim();
    let rest = parts.slice(1).join(" ").trim();

    // 沒有分隔符時（例如 "negotiate 談判"），從英文結束的位置切
    if (!rest) {
      const m = head.match(/^[A-Za-z][A-Za-z'’-]*(?:[ ][A-Za-z'’-]+){0,2}/);
      if (!m) continue;
      rest = head.slice(m[0].length);
      head = m[0];
    }

    // head 可能還帶著詞性，例如 "negotiate v."
    head = head
      .replace(new RegExp(`\\s+(?:${POS_WORDS})\\.?$`, "i"), "")
      .replace(/[.,;:]+$/, "")
      .trim();

    // 確認 head 真的是英文
    if (!/^[A-Za-z][A-Za-z'’\- ]*$/.test(head)) continue;
    const word = head.replace(/\s+/g, " ").trim();
    const key = word.toLowerCase();
    if (key.length < 2 || seen.has(key)) continue;

    seen.add(key);
    out.push({ word, zh: cleanMeaning(rest) });
  }
  return out;
}

/** 只要單字清單（相容舊呼叫） */
export function parseWordList(text) {
  return parseWordLines(text).map(r => r.word.toLowerCase());
}

/* ---------- SM-2 間隔重複 ---------- */

/** 今天該複習的卡（到期日 <= 今天），新卡優先 */
export function due(tag = "") {
  const today = todayKey();
  return vocab()
    .filter(v => (!tag || (v.tags || []).includes(tag)) && v.due <= today)
    .sort((a, b) => {
      if (a.reps !== b.reps) return a.reps - b.reps;   // 新卡先
      return a.due < b.due ? -1 : 1;                   // 逾期久的先
    });
}

export function counts(tag = "") {
  const all = tag ? vocab().filter(v => (v.tags || []).includes(tag)) : vocab();
  const today = todayKey();
  return {
    total: all.length,
    due: all.filter(v => v.due <= today).length,
    fresh: all.filter(v => v.reps === 0).length,
    learning: all.filter(v => v.reps > 0 && v.interval < 21).length,
    mastered: all.filter(v => v.interval >= 21).length,
    // 「說得出來」是另一條線：在對話中自己用出來過的字
    spoken: all.filter(v => (v.produced || 0) > 0).length,
    spokenOften: all.filter(v => (v.produced || 0) >= 3).length,
  };
}

/**
 * 記錄一次複習結果。
 * @param {string} id
 * @param {number} quality 0=忘記 3=困難 4=普通 5=簡單
 */
export function grade(id, quality) {
  const card = vocab().find(v => v.id === id);
  if (!card) return null;

  if (quality < 3) {
    card.reps = 0;
    card.interval = 0;              // 0 表示今天稍後再出現一次
    card.lapses = (card.lapses || 0) + 1;
    card.due = todayKey();
  } else {
    card.reps = (card.reps || 0) + 1;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 6;
    else card.interval = Math.round((card.interval || 1) * (card.ef || 2.5));
    card.due = dayKeyOffset(card.interval);
  }

  // 更新難易度係數（SM-2 原公式，下限 1.3）
  const q = quality;
  card.ef = Math.max(1.3, (card.ef || 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  card.lastReview = Date.now();
  save();
  bumpDaily({ reviews: 1 });
  return card;
}

/* =========================================================================
   產出偵測：你在對話中「自己說出來」才是真正的學習事件
   ========================================================================= */

/**
 * 極輕量的英文詞幹化，只為了讓 negotiate / negotiated / negotiating 對得起來。
 * 不追求語言學正確，追求的是「同一個字的各種變化都算數」。
 */
function stem(w) {
  w = w.toLowerCase();
  if (w.length <= 3) return w;
  const undouble = (s) => (/([^aeiou])\1$/.test(s) ? s.slice(0, -1) : s);

  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";     // studies → study
  else if (w.endsWith("ied") && w.length > 4) w = w.slice(0, -3) + "y"; // carried → carry
  else if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);

  // 再去掉字尾的 e，讓 negotiate 跟 negotiat（來自 negotiating）對得上
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function stemTokens(text) {
  return String(text || "").toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/).filter(Boolean)
    .map(stem);
}

/**
 * 找出這段文字裡出現了哪些單字本的字（支援詞形變化與片語）。
 * @returns {Array} 命中的卡片
 */
export function matchWords(text) {
  const toks = stemTokens(text);
  if (!toks.length) return [];
  const single = new Set(toks);
  const joined = " " + toks.join(" ") + " ";
  const hits = [];
  for (const v of vocab()) {
    const parts = stemTokens(v.word);
    if (!parts.length) continue;
    const ok = parts.length === 1
      ? single.has(parts[0])
      : joined.includes(" " + parts.join(" ") + " ");
    if (ok) hits.push(v);
  }
  return hits;
}

/** 記錄「你說出來了」。同一回合同一個字只算一次。 */
export function markProduced(cards) {
  if (!cards || !cards.length) return [];
  const now = Date.now();
  for (const c of cards) {
    c.produced = (c.produced || 0) + 1;
    c.lastProduced = now;
  }
  save();
  return cards;
}

/** 記錄「AI 用出來了」，純粹當作曝光次數，不影響任何排程。 */
export function markHeard(cards) {
  if (!cards || !cards.length) return;
  for (const c of cards) c.heard = (c.heard || 0) + 1;
  save();
}

/* =========================================================================
   聽得懂但講不出來：AI 用了、你卻沒接的字
   ========================================================================= */

/**
 * 把「這場對話裡 AI 用過、但你一次都沒用出來」的字提前到明天複習。
 * 純前端邏輯，不呼叫任何 API。
 *
 * 這個訊號比卡片複習準得多：你聽到了、聽懂了、也有機會用，卻沒用 ——
 * 代表它停留在被動詞彙，正是最該被推一把的那批。
 *
 * @param {string[]} heardWords    這場對話 AI 用過的字
 * @param {string[]} producedWords 這場對話你自己說出來的字
 * @returns {Array} 被提前的卡片
 */
export function promoteHeardNotProduced(heardWords, producedWords) {
  const said = new Set((producedWords || []).map(w => w.toLowerCase()));
  const tomorrow = dayKeyOffset(1);
  const moved = [];

  for (const w of new Set((heardWords || []).map(x => x.toLowerCase()))) {
    if (said.has(w)) continue;
    const card = find(w);
    if (!card) continue;
    if (card.due <= tomorrow) continue;      // 本來就快到期了，不用動
    card.due = tomorrow;
    card.passive = (card.passive || 0) + 1;  // 記錄「聽過但沒用出來」的次數
    moved.push(card);
  }
  if (moved.length) save();
  return moved;
}

/* =========================================================================
   想講但講不出來：從逐字稿裡挖出你缺的字
   ========================================================================= */

/**
 * 讓模型看整份逐字稿，找出你用很繞的說法表達的地方，建議對應的單字。
 * 一整場對話只呼叫一次 API。
 *
 * @param {Array} messages [{role, content}]
 * @param {string} level   CEFR 程度，決定建議的字難不難
 * @returns {Array} [{said, suggest, zh, better}]
 */
export async function findGaps(messages, level = "B1") {
  const lines = (messages || [])
    .filter(m => m.content && (m.role === "user" || m.role === "assistant"))
    .slice(-30)
    .map(m => (m.role === "user" ? "LEARNER: " : "PARTNER: ") + m.content)
    .join("\n");
  if (!lines) return [];

  const prompt = `Below is a transcript of a spoken English conversation. LEARNER is a Traditional Chinese speaker at roughly CEFR ${level}. PARTNER is a fluent speaker.

Find up to 4 moments where the LEARNER clearly struggled to say something: a long roundabout description, a vague filler word (thing, stuff, do, very good), visible groping ("how do you say", "um", repetition), or an awkward/incorrect word choice — where ONE specific English word or short phrase would have been the natural thing to say.

Return ONLY a JSON array, no markdown fence:
[{"said":"the learner's own words, quoted, at most 12 words","suggest":"the single English word or short phrase they needed","zh":"該字的繁體中文意思，15字以內","better":"one short sentence showing how the learner could have said it"}]

Rules:
- Look ONLY at LEARNER turns. Never base a suggestion on what PARTNER said.
- The suggested word must be usable by a ${level} learner. No rare or literary words.
- Do not suggest a word the learner already used correctly somewhere in the transcript.
- Speech-recognition noise is not a mistake. Ignore garbled or cut-off words.
- If the learner expressed everything fine, return an empty array []. Do not invent problems.
- Traditional Chinese only (not Simplified).

TRANSCRIPT:
${lines}`;

  const raw = await complete(prompt, { json: false, maxTokens: 1200 });
  const arr = parseJSON(raw);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => ({
      said: String(x.said || "").trim(),
      suggest: String(x.suggest || "").trim(),
      zh: String(x.zh || "").trim(),
      better: String(x.better || "").trim(),
    }))
    .filter(x => x.suggest && /^[A-Za-z]/.test(x.suggest))
    .slice(0, 4);
}

/* ---------- 給對話用：提供候選字池，由 AI 自己挑話題搭得上的 ---------- */

/**
 * 回傳候選字池（到期與新字優先）。
 * 不指定「一定要用哪個」，而是讓模型從池子裡挑跟當下話題搭得起來的，
 * 避免為了塞單字把對話講得很生硬。
 */
export function wordsForChat(limit = 8) {
  const today = todayKey();
  const all = vocab();
  if (!all.length) return [];

  const score = (v) => {
    let s = 0;
    if (v.due <= today) s += 100;                       // 到期的最優先
    if (v.reps === 0) s += 40;                          // 沒複習過的新字次之
    if (!v.produced) s += 30;                           // 還沒說出口過的更該練
    s += Math.min(40, (v.passive || 0) * 20);           // 聽過卻沒接話的最該再遇到一次
    s -= Math.min(20, (v.produced || 0) * 5);           // 已經很會用的往後排
    return s + Math.random() * 25;                      // 加點隨機，免得每次同一批
  };

  return all.slice().sort((a, b) => score(b) - score(a))
    .slice(0, limit).map(v => v.word);
}

/* ---------- 標籤 ---------- */

export function allTags() {
  const set = new Set();
  vocab().forEach(v => (v.tags || []).forEach(t => set.add(t)));
  return [...set].sort();
}

/* ---------- CSV 匯出（給 Anki / Excel 用） ---------- */

export function toCSV() {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const head = ["word", "phonetic", "pos", "zh", "example", "exampleZh",
                "synonyms", "antonyms", "tags", "due", "interval", "produced"];
  const rel = (a) => (a || []).map(x => x.w + (x.zh ? "(" + x.zh + ")" : "")).join("; ");
  const rows = vocab().map(v => [
    v.word, v.phonetic, v.pos, v.zh, v.example, v.exampleZh,
    rel(v.synonyms), rel(v.antonyms),
    (v.tags || []).join(" "), v.due, v.interval, v.produced || 0,
  ].map(esc).join(","));
  return "﻿" + head.join(",") + "\n" + rows.join("\n");   // BOM 讓 Excel 認得 UTF-8
}

/**
 * vocab.js — 單字本與間隔重複複習
 *
 * 複習排程用 SM-2（Anki 的前身演算法）：答對就把下次複習推遠，答錯就拉回來。
 * 每個單字帶 tag，所以可以照學校課程分組（例如 "B1U3"），複習時只挑那一組。
 *
 * 最關鍵的一點：到期的單字會被塞進對話的系統提示，AI 會在聊天中自然用出來。
 * 「看過 → 在對話裡遇到 → 自己講出來」這個循環，比單純刷卡有效得多。
 */

import { load, save, vocab, uid, todayKey, dayKeyOffset, bumpDaily } from "./store.js";
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
    tags: [],
    created: Date.now(),
    // --- SM-2 欄位 ---
    ef: 2.5,          // 難易度係數
    interval: 0,      // 目前間隔（天）
    reps: 0,          // 連續答對次數
    lapses: 0,        // 忘記次數
    due: todayKey(),  // 下次複習日期
    lastReview: 0,
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
  "exampleZh": "Traditional Chinese translation of that example"
}
Use Traditional Chinese characters only (not Simplified). Keep it short.`;

/** 查一個單字，回傳可直接存進單字本的物件 */
export async function lookup(word, context = "") {
  const raw = await complete(LOOKUP_PROMPT(word, context), { json: true, maxTokens: 400 });
  const d = parseJSON(raw);
  return {
    word: (d.word || word).trim(),
    phonetic: (d.phonetic || "").trim(),
    pos: (d.pos || "").trim(),
    zh: (d.zh || "").trim(),
    example: (d.example || "").trim(),
    exampleZh: (d.exampleZh || "").trim(),
  };
}

/** 批次查詢（貼一整課單字表用），一次最多 20 個，避免超過回應長度 */
export async function lookupBatch(words) {
  const list = words.slice(0, 20);
  const prompt = `You are a bilingual dictionary for a Traditional Chinese speaker learning \
English. Look up each of these words: ${list.map(w => `"${w}"`).join(", ")}.

Return ONLY a JSON array, no markdown fence. Each element:
{"word":"base form","phonetic":"/IPA/","pos":"verb","zh":"繁體中文意思(15字以內)",\
"example":"one short English sentence","exampleZh":"該例句的繁體中文翻譯"}

Return exactly ${list.length} elements, in the same order. Traditional Chinese only.`;
  const raw = await complete(prompt, { json: false, maxTokens: 2400 });
  const arr = parseJSON(raw);
  if (!Array.isArray(arr)) throw new Error("模型沒有回傳陣列");
  return arr;
}

/** 從貼上的文字抓出英文單字（支援逗號、換行、tab、"word 中文" 混排） */
export function parseWordList(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split(/[\n,;]+/)) {
    const m = line.trim().match(/^[a-zA-Z][a-zA-Z'-]*(\s+[a-zA-Z'-]+){0,2}/);
    if (!m) continue;
    const w = m[0].trim().toLowerCase();
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
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

/* ---------- 給對話用：挑幾個單字讓 AI 自然用出來 ---------- */

export function wordsForChat(limit = 6) {
  const today = todayKey();
  const pool = vocab().filter(v => v.due <= today || v.reps === 0);
  const src = pool.length ? pool : vocab();
  // 隨機挑，避免每次都同一批
  const shuffled = src.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit).map(v => v.word);
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
  const head = ["word", "phonetic", "pos", "zh", "example", "exampleZh", "tags", "due", "interval"];
  const rows = vocab().map(v => [
    v.word, v.phonetic, v.pos, v.zh, v.example, v.exampleZh,
    (v.tags || []).join(" "), v.due, v.interval,
  ].map(esc).join(","));
  return "﻿" + head.join(",") + "\n" + rows.join("\n");   // BOM 讓 Excel 認得 UTF-8
}

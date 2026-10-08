/**
 * vocab.js — 單字本與間隔重複複習
 *
 * 複習排程預設用 FSRS（Anki 現行演算法，見 fsrs.js），也可以在設定切回 SM-2。
 * 兩套狀態每次都同時更新，所以隨時切換都不會讓排程亂掉。
 * 每個單字帶 tag，所以可以照學校課程分組（例如 "B1U3"），複習時只挑那一組。
 *
 * 最關鍵的一點：到期的單字會被塞進對話的系統提示，AI 會在聊天中自然用出來。
 * 「看過 → 在對話裡遇到 → 自己講出來」這個循環，比單純刷卡有效得多。
 */

import { load, save, vocab, uid, todayKey, dayKeyOffset, bumpDaily,
         cacheGet, cacheSet, cacheDrop } from "./store.js";
import { complete, parseJSON } from "./llm.js";
import * as FSRS from "./fsrs.js";

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
    // 詞形與詞性變化；undefined 表示還沒查過，[] 表示查過但沒有
    // forms：同一個字的變化形 [{k:"past", w:"decided"}]
    // family：同字根、不同詞性的字 [{w:"decision", pos:"n.", zh:"決定"}]
    tags: [],
    created: Date.now(),
    // --- SM-2 欄位 ---
    ef: 2.5,          // 難易度係數
    interval: 0,      // 目前間隔（天）
    reps: 0,          // 連續答對次數
    lapses: 0,        // 忘記次數
    due: todayKey(),  // 下次複習日期
    lastReview: 0,
    smIvl: 0,         // SM-2 自己的間隔（切換演算法時用）
    // --- FSRS 欄位（第一次複習後才有）---
    // fs：穩定度（天），fd：難度 1–10
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

/** 詞形／詞性變化的規則（單字查詢、批次查詢、補查共用） */
const FORMS_RULES = `Rules for "forms" (inflections of THIS word, same part of speech):
- verb: past, pp (past participle), ing, s3 (third person singular)
- countable noun: plural (omit for uncountable nouns)
- adjective/adverb: comp, sup ONLY if it has -er/-est or irregular forms (never "more x")
- other parts of speech: empty array
- "k" must be one of: past, pp, ing, s3, plural, comp, sup

Rules for "family" (word family: other COMMON words from the same root with a DIFFERENT part of speech):
- at most 4, e.g. decide → decision (n.), decisive (adj.), decisively (adv.)
- "pos" is one of: n. v. adj. adv.
- only real, common words a learner would meet; never invent a word; empty array if none
- do not repeat the word itself or its inflections`;

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
  "antonyms": [{"w": "an English antonym", "zh": "其繁體中文意思(10字內)"}],
  "forms": [{"k": "past", "w": "decided"}],
  "family": [{"w": "decision", "pos": "n.", "zh": "決定"}]
}

Rules for synonyms and antonyms:
- Give AT MOST 3 synonyms and AT MOST 3 antonyms, ordered most useful first.
- They must match the SAME part of speech and the SAME sense as above.
- Prefer words a learner would actually meet, not rare or literary ones.
- If the word genuinely has no antonym (most nouns), return an empty array. Never invent one.

${FORMS_RULES}

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
      const hit = cacheGet(key);
      return {
        word: card.word, phonetic: card.phonetic, pos: card.pos, zh: card.zh,
        example: card.example, exampleZh: card.exampleZh,
        synonyms: card.synonyms || [], antonyms: card.antonyms || [],
        forms: card.forms || (hit && hit.forms), family: card.family || (hit && hit.family),
      };
    }
    // 2. 再看查詢快取
    const hit = cacheGet(key);
    if (hit && hit.zh) {
      return {
        word: hit.word, phonetic: hit.phonetic, pos: hit.pos, zh: hit.zh,
        example: hit.example, exampleZh: hit.exampleZh,
        synonyms: hit.synonyms || [], antonyms: hit.antonyms || [],
        forms: hit.forms, family: hit.family,
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
    forms: normForms(d.forms, d.word || word),
    family: normFamily(d.family, d.word || word),
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

/* ---------- 詞形與詞性變化 ---------- */

export const FORM_LABELS = { past: "過去式", pp: "過去分詞", ing: "現在分詞", s3: "第三人稱",
                             plural: "複數", comp: "比較級", sup: "最高級" };
const FORM_ORDER = Object.keys(FORM_LABELS);

/** 正規化成 [{k, w}]，照固定順序；跟原字一樣的（例如 cut 的過去式）也保留，那本身就是重點 */
export function normForms(arr, base = "") {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const k = String(x && x.k || "").trim();
    const w = String(x && x.w || "").trim();
    if (!FORM_LABELS[k] || !/^[A-Za-z][A-Za-z' -]*$/.test(w) || /^more |^most /i.test(w)) continue;
    if (!out.some(o => o.k === k)) out.push({ k, w });
  }
  return out.sort((a, b) => FORM_ORDER.indexOf(a.k) - FORM_ORDER.indexOf(b.k));
}

const POS_SHORT = { noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.",
                    n: "n.", v: "v.", adj: "adj.", adv: "adv." };

/** 正規化成 [{w, pos, zh}]，最多 4 個，去掉原字本身 */
export function normFamily(arr, base = "") {
  if (!Array.isArray(arr)) return [];
  const b = String(base).toLowerCase();
  const out = [];
  for (const x of arr.slice(0, 6)) {
    const w = String(x && (x.w || x.word) || "").trim();
    if (!w || w.toLowerCase() === b || !/^[A-Za-z][A-Za-z' -]*$/.test(w)) continue;
    if (out.some(o => o.w.toLowerCase() === w.toLowerCase())) continue;
    const p = String(x.pos || "").toLowerCase().replace(/\.$/, "").trim();
    out.push({ w, pos: POS_SHORT[p] || (p ? p + "." : ""), zh: String(x.zh || "").trim().slice(0, 12) });
  }
  return out.slice(0, 4);
}

/** 詞性縮寫（顯示用）：verb → v. */
export function posShort(pos) {
  const p = String(pos || "").toLowerCase().replace(/\.$/, "").trim();
  return POS_SHORT[p] || pos || "";
}

/** 手動輸入「decision n. 決定, decisive adj. 果斷的」→ [{w,pos,zh}] */
export function textToFamily(text) {
  return String(text || "").split(/[,，;；\n]+/).map(part => {
    let zh = "";
    // 括號裡的當中文意思：decisive(果斷的)
    const t = part.replace(/[（(]([^)）]*)[)）]/g, (_, z) => { zh = z.trim(); return " "; });
    const words = [], rest = [];
    let pos = "";
    for (const tok of t.trim().split(/\s+/).filter(Boolean)) {
      const p = tok.toLowerCase().replace(/\.$/, "");
      if (!pos && words.length && ["n", "v", "adj", "adv"].includes(p)) { pos = p + "."; continue; }
      if (!pos && !rest.length && /^[A-Za-z'-]+$/.test(tok)) { words.push(tok); continue; }
      rest.push(tok);
    }
    if (!words.length) return null;
    return { w: words.join(" "), pos, zh: zh || rest.join(" ") };
  }).filter(Boolean).slice(0, 6);
}
export function familyToText(list) {
  return (list || []).map(x => [x.w, x.pos, x.zh].filter(Boolean).join(" ")).join(", ");
}

/**
 * 補查詞形與詞性變化（舊的快取或單字本沒有這兩個欄位時用）。
 * 一次最多 25 個字合成一個請求；查完寫回快取與單字本，同一個字只會補查一次。
 * @param {Array<string>} words
 * @returns {Promise<number>} 補到幾個字
 */
export async function fetchForms(words) {
  const list = [...new Set(words.map(w => String(w).trim()).filter(Boolean))].slice(0, 25);
  if (!list.length) return 0;
  const prompt = `For each English word below, give its inflections ("forms") and its word family \
("family") for a Traditional Chinese speaker learning English.
Words: ${list.map(w => `"${w}"`).join(", ")}

Return ONLY a JSON array, no markdown fence, one element per word, same order:
[{"word":"decide","forms":[{"k":"past","w":"decided"},{"k":"pp","w":"decided"},{"k":"ing","w":"deciding"},{"k":"s3","w":"decides"}],\
"family":[{"w":"decision","pos":"n.","zh":"決定"},{"w":"decisive","pos":"adj.","zh":"果斷的"}]}]

${FORMS_RULES}
"zh" is Traditional Chinese (never Simplified), 8 characters or fewer.`;
  const raw = await complete(prompt, { maxTokens: 300 + list.length * 160 });
  const arr = parseJSON(raw);
  if (!Array.isArray(arr)) throw new Error("模型沒有回傳陣列");
  let n = 0;
  list.forEach((w, i) => {
    const d = arr.find(x => x && String(x.word || "").toLowerCase() === w.toLowerCase()) || arr[i];
    if (!d) return;
    const forms = normForms(d.forms, w), family = normFamily(d.family, w);
    storeForms(w, forms, family);
    n++;
  });
  save();
  return n;
}

/** 寫回快取與單字本（單字本裡你自己填過的詞性變化不覆蓋） */
function storeForms(word, forms, family) {
  const hit = cacheGet(word);
  if (hit) { hit.forms = forms; hit.family = family; }
  else cacheSet(word, { word, forms, family });
  const card = find(word);
  if (card) {
    if (!Array.isArray(card.forms)) card.forms = forms;
    if (!Array.isArray(card.family) || !card.family.length) card.family = family;
  }
}

/** 單字本裡還沒有詞性變化資料的字 */
export function missingForms() {
  return vocab().filter(v => !Array.isArray(v.family) || !Array.isArray(v.forms)).map(v => v.word);
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
      forms: normForms(d.forms, d.word || w),
      family: normFamily(d.family, d.word || w),
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
"synonyms":[{"w":"near-synonym","zh":"中文"}],"antonyms":[{"w":"antonym","zh":"中文"}],\
"forms":[{"k":"past","w":"decided"}],"family":[{"w":"decision","pos":"n.","zh":"決定"}]}

At most 2 synonyms and 2 antonyms each, same part of speech and sense; empty array if none \
exists (never invent an antonym). Return exactly ${list.length} elements, in the same order. \
Traditional Chinese only.

${FORMS_RULES}`;
  const raw = await complete(prompt, { json: false, maxTokens: 6000 });
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
/**
 * 記錄一次複習結果。
 * @param {string} id
 * @param {number} quality 0=忘記 3=困難 4=普通 5=簡單
 * @param {Object} meta    {mode: 題型, ms: 作答花了幾毫秒}，個人分析用
 */
/**
 * 0–5 的品質分數 → FSRS 的四級評分。
 * 只有翻卡的「簡單」才算「簡單」：測驗答對只代表「普通」，
 * 不然每個拼對的字都會被一口氣排到兩週後。
 */
function toRating(quality, mode) {
  if (quality < 3) return FSRS.AGAIN;
  if (quality === 3) return FSRS.HARD;
  if (quality >= 5 && mode === "flip") return FSRS.EASY;
  return FSRS.GOOD;
}

function useFSRS() { return (load().settings.scheduler || "fsrs") === "fsrs"; }
function retention() { return Number(load().settings.retention) || 0.9; }

/** 翻卡畫面四個按鈕各會排到幾天後：{0:天數, 3:..., 4:..., 5:...} */
export function previewIntervals(card) {
  if (useFSRS()) {
    FSRS.migrate(card);
    const p = FSRS.preview(card, retention());
    return { 0: 0, 3: p[2], 4: p[3], 5: p[4] };
  }
  const ivl = card.smIvl ?? card.interval ?? 0, reps = card.reps || 0, ef = card.ef || 2.5;
  const next = (q) => {
    if (q < 3) return 0;
    if (reps === 0) return 1;
    if (reps === 1) return 6;
    const ef2 = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    return Math.round((ivl || 1) * ef2);
  };
  return { 0: 0, 3: next(3), 4: next(4), 5: next(5) };
}

export function grade(id, quality, meta = {}) {
  const card = vocab().find(v => v.id === id);
  if (!card) return null;
  const repsBefore = card.reps || 0;
  const mode = meta.mode || "flip";

  // --- SM-2（一直在背景更新，切回 SM-2 時才不會從頭來） ---
  let smIvl = card.smIvl ?? card.interval ?? 0;
  if (quality < 3) {
    smIvl = 0;
  } else {
    const n = repsBefore + 1;
    smIvl = n === 1 ? 1 : n === 2 ? 6 : Math.round((smIvl || 1) * (card.ef || 2.5));
  }
  const q = quality;
  card.ef = Math.max(1.3, (card.ef || 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  card.smIvl = smIvl;

  // --- FSRS ---
  FSRS.migrate(card);
  const f = FSRS.schedule(card, toRating(quality, mode), retention());
  card.fs = f.s;
  card.fd = f.d;

  // 共用欄位：reps / lapses 兩套演算法意義相同
  if (quality < 3) {
    card.reps = 0;
    card.lapses = (card.lapses || 0) + 1;
  } else {
    card.reps = repsBefore + 1;
  }

  // 由目前選用的演算法決定下次日期；interval 0 表示今天稍後再出現一次
  card.interval = useFSRS() ? f.interval : smIvl;
  card.due = card.interval ? dayKeyOffset(card.interval) : todayKey();
  card.lastReview = Date.now();

  // 作答紀錄：分析「哪種題型比較弱」「保持率」「哪個時段練最多」都靠這個
  const log = load().reviewLog;
  log.push({ t: Date.now(), w: card.word, m: meta.mode || "flip", q,
             ms: Math.round(meta.ms || 0), r: repsBefore });
  if (log.length > 6000) log.splice(0, log.length - 6000);

  save();
  bumpDaily({ reviews: 1 });
  return card;
}

/**
 * 切換演算法或目標記憶率後，依新規則重排所有複習過的卡。
 * 以「上次複習那天」為起點重新算，不是從今天起算，所以不會讓大家一起往後延。
 */
export function rescheduleAll() {
  const fsrs = useFSRS(), r = retention();
  let n = 0;
  for (const c of vocab()) {
    if (!c.lastReview || !(c.reps > 0)) continue;   // 新卡與今天剛忘記的不動
    FSRS.migrate(c);
    const ivl = fsrs ? Math.max(1, Math.round(FSRS.intervalFor(c.fs, r)))
                     : Math.max(1, c.smIvl ?? c.interval ?? 1);
    const due = dayKeyOffset(ivl, new Date(c.lastReview));
    if (due !== c.due || ivl !== c.interval) { c.interval = ivl; c.due = due; n++; }
  }
  save(true);
  return n;
}

/** 此刻還記得的機率（FSRS 推算；沒複習過的回傳 null） */
export function recallNow(card) {
  if (card.fs > 0) return FSRS.currentR(card);
  const c = { ...card };            // 舊卡還沒轉換過：用推估值算，但不改動原卡
  FSRS.migrate(c);
  return FSRS.currentR(c);
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

/** 對外提供詞幹化，跟讀比對也用同一套規則，兩邊判斷才會一致 */
export function stemWord(w) { return stem(String(w || "")); }

/**
 * 判斷一段話裡有沒有用到某個特定的字（支援詞形變化與片語）。
 * 用說的複習靠這個判斷答對沒，所以不需要呼叫 API。
 */
export function textUsesWord(text, word) {
  const toks = stemTokens(text);
  const parts = stemTokens(word);
  if (!toks.length || !parts.length) return false;
  if (parts.length === 1) return toks.includes(parts[0]);
  return (" " + toks.join(" ") + " ").includes(" " + parts.join(" ") + " ");
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

/**
 * store.js — 全站資料層
 *
 * 所有資料都存在使用者自己的瀏覽器 localStorage，沒有後端、沒有帳號。
 * 這是「部署到免費靜態主機 + 使用者自備金鑰」架構的必然結果：
 * 伺服器不存任何東西，也就沒有隱私與成本問題。
 */

const KEY = "englishtalk.v1";
const SCHEMA_VERSION = 1;

/** 預設資料結構；升級時用這份補齊缺少的欄位 */
function emptyState() {
  return {
    v: SCHEMA_VERSION,
    settings: {
      provider: "gemini",            // gemini | groq
      geminiKey: "",
      groqKey: "",
      geminiModel: "gemini-2.5-flash",
      groqModel: "llama-3.1-8b-instant",
      ttsEngine: "browser",          // browser | edge
      browserVoice: "",              // speechSynthesis 的 voice.name
      edgeVoice: "en-US-AvaNeural",
      rate: 1.0,                     // 0.7 ~ 1.3
      level: "B1",
      persona: "Ava, a warm and curious American friend in her late twenties",
      bargeSensitivity: 3.0,         // 0 = 關閉搶話
      silenceMs: 1000,
      useVocabInChat: true,          // 讓 AI 刻意用到你的單字
      autoLookup: true,              // 點單字自動查詢
      promoteHeard: true,            // AI 用了但你沒接的字，自動提前複習
      analyzeGaps: true,             // 對話結束後挖出「想講但講不出來」的字
    },
    vocab: [],     // 單字本（含 SM-2 間隔重複欄位）
    lookups: {},   // 查詢快取：查過的字永久留著，同一個字一輩子只查一次
    sessions: [],  // 對話紀錄
    daily: {},     // { "YYYY-MM-DD": {seconds, turns, userWords, reviews} }
  };
}

let state = null;
let saveTimer = null;

/** 深層合併：只補上缺少的鍵，不覆蓋已有的值（用於 schema 升級） */
function fillDefaults(target, defaults) {
  for (const k of Object.keys(defaults)) {
    if (target[k] === undefined) {
      target[k] = Array.isArray(defaults[k]) ? defaults[k].slice()
                : (defaults[k] && typeof defaults[k] === "object") ? { ...defaults[k] }
                : defaults[k];
    } else if (defaults[k] && typeof defaults[k] === "object" && !Array.isArray(defaults[k])) {
      fillDefaults(target[k], defaults[k]);
    }
  }
  return target;
}

export function load() {
  if (state) return state;
  const base = emptyState();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = fillDefaults(parsed, base);
      state.v = SCHEMA_VERSION;
    } else {
      state = base;
    }
  } catch (e) {
    console.warn("[store] 讀取失敗，改用空白資料", e);
    state = base;
  }
  return state;
}

/** 存檔（預設延遲 400ms 合併多次寫入，避免每個按鍵都寫 localStorage） */
export function save(immediate = false) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const doSave = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.error("[store] 寫入失敗（可能是容量已滿）", e);
      window.dispatchEvent(new CustomEvent("store:error", { detail: e }));
    }
  };
  if (immediate) doSave(); else saveTimer = setTimeout(doSave, 400);
}

export function settings() { return load().settings; }
export function vocab()    { return load().vocab; }
export function lookups()  { return load().lookups; }
export function sessions() { return load().sessions; }
export function daily()    { return load().daily; }

/* ---------- 日期工具（一律用本地時區的 YYYY-MM-DD） ---------- */

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

export function dayKeyOffset(days, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return todayKey(d);
}

/** 累加今天的統計數字 */
export function bumpDaily(patch) {
  const st = load();
  const k = todayKey();
  const row = st.daily[k] || { seconds: 0, turns: 0, userWords: 0, reviews: 0 };
  for (const [key, val] of Object.entries(patch)) row[key] = (row[key] || 0) + val;
  st.daily[k] = row;
  save();
}

/* ---------- 查詢快取 ---------- */

const LOOKUP_CACHE_MAX = 3000;

export function cacheGet(word) {
  const k = String(word || "").trim().toLowerCase();
  if (!k) return null;
  const hit = load().lookups[k];
  if (!hit) return null;
  hit.t = Date.now();          // 更新使用時間，供汰換用
  return hit;
}

export function cacheSet(word, data) {
  const k = String(word || "").trim().toLowerCase();
  if (!k || !data) return;
  const st = load();
  st.lookups[k] = { ...data, t: Date.now() };

  // 超過上限就丟掉最久沒用的一批（一次丟 200 個，免得每次都在整理）
  const keys = Object.keys(st.lookups);
  if (keys.length > LOOKUP_CACHE_MAX) {
    keys.sort((a, b) => (st.lookups[a].t || 0) - (st.lookups[b].t || 0));
    for (const dead of keys.slice(0, 200)) delete st.lookups[dead];
  }
  save();
}

export function cacheDrop(word) {
  const k = String(word || "").trim().toLowerCase();
  const st = load();
  if (st.lookups[k]) { delete st.lookups[k]; save(); }
}

export function cacheSize() { return Object.keys(load().lookups).length; }

/* ---------- 匯出 / 匯入 ---------- */

export function exportJSON() {
  return JSON.stringify(load(), null, 2);
}

/**
 * 匯入備份。mode = "replace" 整份取代，"merge" 只併入單字本與紀錄。
 * 金鑰一律不匯入，避免備份檔外流造成金鑰外洩。
 */
export function importJSON(text, mode = "merge") {
  const incoming = JSON.parse(text);
  if (!incoming || typeof incoming !== "object") throw new Error("格式不正確");
  const st = load();

  if (mode === "replace") {
    const keepKeys = { geminiKey: st.settings.geminiKey, groqKey: st.settings.groqKey };
    state = fillDefaults(incoming, emptyState());
    Object.assign(state.settings, keepKeys);
    save(true);
    return { vocab: state.vocab.length, sessions: state.sessions.length };
  }

  let added = 0;
  const byWord = new Map(st.vocab.map(v => [v.word.toLowerCase(), v]));
  for (const v of (incoming.vocab || [])) {
    const k = (v.word || "").toLowerCase();
    if (!k || byWord.has(k)) continue;
    st.vocab.push(v);
    byWord.set(k, v);
    added++;
  }
  for (const [k, v] of Object.entries(incoming.lookups || {})) {
    if (!st.lookups[k]) st.lookups[k] = v;
  }

  const ids = new Set(st.sessions.map(s => s.id));
  let addedSessions = 0;
  for (const s of (incoming.sessions || [])) {
    if (!s.id || ids.has(s.id)) continue;
    st.sessions.push(s);
    addedSessions++;
  }
  for (const [k, row] of Object.entries(incoming.daily || {})) {
    const cur = st.daily[k];
    if (!cur) { st.daily[k] = row; continue; }
    for (const f of ["seconds", "turns", "userWords", "reviews"]) {
      cur[f] = Math.max(cur[f] || 0, row[f] || 0);
    }
  }
  st.sessions.sort((a, b) => a.start - b.start);
  save(true);
  return { vocab: added, sessions: addedSessions };
}

/** 清空全部資料（設定與金鑰一併清掉） */
export function wipe() {
  localStorage.removeItem(KEY);
  state = null;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

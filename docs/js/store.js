/**
 * store.js — 全站資料層
 *
 * 所有資料都存在使用者自己的瀏覽器，沒有後端、沒有帳號。
 *
 * 存放位置：瀏覽器內建的資料庫 IndexedDB（容量通常是幾百 MB 到好幾 GB）。
 * 舊版存在 localStorage（上限只有約 5MB，對話紀錄一多就會滿），第一次打開新版時自動搬過去。
 * 萬一這台瀏覽器不能用 IndexedDB（少數無痕模式），自動退回 localStorage，功能照常。
 *
 * 讀寫方式：啟動時整份讀進記憶體（init），之後所有讀取都是同步的；
 * 修改後延遲 400ms 合併寫回資料庫，離開頁面時立刻寫。
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
      // 2.5 系列只開放給最近用過的帳號，新使用者預設用 3.5 Flash-Lite（快、省、幾乎不思考）
      geminiModel: "gemini-3.5-flash-lite",
      groqModel: "llama-3.1-8b-instant",
      // 查字、新增單字、文法檢查用的 Groq 模型：auto = llama-3.3-70b-versatile（不能用時退回對話模型），
      // same = 跟對話同一個。分開用的好處是額度各算各的，背景工作不會吃掉對話的額度。
      groqToolModel: "auto",
      ttsEngine: "browser",          // browser | edge
      browserVoice: "",              // speechSynthesis 的 voice.name
      edgeVoice: "en-US-AvaNeural",
      rate: 1.0,                     // 0.7 ~ 1.3
      level: "B1",
      persona: "Ava, a warm and curious American friend in her late twenties",
      bargeSensitivity: 3.0,         // 0 = 關閉搶話
      silenceMs: 1000,
      // 0 = 關閉，1 = 每輪都注入。0.5 大約每兩輪一次。
      // 用機率閘門控制，而不是在提示詞裡寫「偶爾」—— 模型對程度副詞不敏感，
      // 但「這一輪根本沒拿到單字」是確定的。
      vocabFrequency: 0.5,
      autoLookup: true,              // 點單字自動查詢
      reviewMode: "flip",            // flip = 翻卡（預設，搭捷運也能用），speak = 用說的複習
      promoteHeard: true,            // AI 用了但你沒接的字，自動提前複習
      analyzeGaps: true,             // 對話結束後挖出「想講但講不出來」的字
      fallback: true,                // 主要的 AI 出問題時自動換備援（對話不會斷）
      scheduler: "fsrs",             // fsrs | sm2
      retention: 0.9,                // FSRS 目標記憶率：0.85 輕鬆、0.9 標準、0.95 嚴格
      grammarCheck: "live",          // live = 每句說完就在旁邊標出修正，end = 對話結束一次檢查，off
      // 查字、新增單字、文法檢查用的 Gemini 模型：auto = gemini-3.5-flash-lite，same = 跟對話同一個
      geminiToolModel: "auto",
    },
    vocab: [],     // 單字本（含 FSRS 與 SM-2 間隔重複欄位）
    lookups: {},   // 查詢快取：查過的字永久留著，同一個字一輩子只查一次
    reviewLog: [], // 每一次作答的紀錄 {t, w, m, q, ms, r}，個人分析用（只留最近 6000 筆）
    aiUsage: {},   // AI 用量：{days: {日期: {"供應商|模型": {req, ok, fail, tok, backup, by}}}, limits}
    coach: {},     // AI 週報快取 { "2026-W41": "…" }，同一週只呼叫一次
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

/** 舊資料升級成目前的格式（補上新欄位、轉換舊設定） */
function upgrade(parsed) {
  // 舊版的布林開關 → 新版的頻率數值
  if (parsed.settings && parsed.settings.useVocabInChat !== undefined
      && parsed.settings.vocabFrequency === undefined) {
    parsed.settings.vocabFrequency = parsed.settings.useVocabInChat ? 0.5 : 0;
    delete parsed.settings.useVocabInChat;
  }
  const st = fillDefaults(parsed, emptyState());
  st.v = SCHEMA_VERSION;
  // v2.0 曾把預設改成「用說的」；沒有自己切換過的人一律回到翻卡
  if (!st.settings.reviewModeChosen) st.settings.reviewMode = "flip";
  return st;
}

/* ---------- IndexedDB（只存一筆：整份資料） ---------- */

const DB_NAME = "englishtalk", DB_STORE = "kv", DB_KEY = "state";
let db = null;                      // 開成功才有；null 表示用 localStorage
let backend = "localStorage";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB 寫入被中止"));
  });
}
const idbGet = (k) => idb("readonly", (os) => os.get(k));
const idbPut = (k, v) => idb("readwrite", (os) => os.put(v, k));
const idbDel = (k) => idb("readwrite", (os) => os.delete(k));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * 啟動時呼叫一次：打開資料庫、讀進記憶體。
 * localStorage 裡如果有資料（舊版，或測試／匯入工具直接寫進去的），以它為準搬進資料庫，搬完就刪掉。
 */
export async function init() {
  if (state && db) return state;
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) {}
  try {
    if (!("indexedDB" in window)) throw new Error("no IndexedDB");
    db = await withTimeout(openDB(), 4000);
    const stored = await idbGet(DB_KEY);
    const ls = raw ? JSON.parse(raw) : null;
    // localStorage 那份是「關分頁時的暫存」才會有 savedAt；跟資料庫比，取比較新的。
    // （同時開兩個分頁時，舊分頁留下的暫存不能蓋掉另一個分頁後來存的資料）
    // 沒有 savedAt 的是舊版資料或匯入工具寫的，一律以它為準。
    const lsWins = ls && !(stored && ls.savedAt && (stored.savedAt || 0) > ls.savedAt);
    if (lsWins) {
      state = upgrade(ls);
      await idbPut(DB_KEY, state);
    } else {
      state = stored ? upgrade(stored) : emptyState();
    }
    if (raw) { try { localStorage.removeItem(KEY); } catch (e) {} }   // 確定寫進資料庫才刪，失敗會跳到下面的 catch
    backend = "indexedDB";
  } catch (e) {
    console.warn("[store] IndexedDB 不能用，改用 localStorage", e);
    db = null;
    backend = "localStorage";
    state = null;
    load();
  }
  // 請瀏覽器不要在空間緊張時自動清掉這個網站的資料（安裝成 App 或常用的網站通常會直接同意）
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  // 切到背景：還沒寫的立刻寫（頁面還活著，資料庫寫得完）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer) save(true);
  });
  // 關分頁、重新整理：資料庫是非同步的，頁面可能在寫完前就被關掉。
  // 這時改用同步的 localStorage 暫存一份，下次打開 init() 會看到它、搬回資料庫再刪掉。
  // 資料太大塞不進 localStorage 就算了（資料庫那邊仍會盡量寫）。
  window.addEventListener("pagehide", () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer); saveTimer = null;
    state.savedAt = Date.now();
    if (!db) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} return; }
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 太大 */ }
    try { idbPut(DB_KEY, state).catch(() => {}); } catch (e) {}
  });
  return state;
}

/** 同步取得資料（init 之前呼叫的話，退回直接讀 localStorage） */
export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? upgrade(JSON.parse(raw)) : emptyState();
  } catch (e) {
    console.warn("[store] 讀取失敗，改用空白資料", e);
    state = emptyState();
  }
  return state;
}

/** 空間比較大（IndexedDB）時，各種紀錄可以留多一點 */
export function roomy() { return backend === "indexedDB"; }

/** 目前用了多少空間（給「紀錄」頁顯示） */
export async function usage() {
  const out = { backend, used: null, quota: null, persisted: null };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      out.used = e.usage; out.quota = e.quota;
    }
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch (e) {}
  if (backend === "localStorage") {
    // localStorage 的上限各瀏覽器約 5MB（以 UTF-16 計，一個字元 2 bytes）
    try { out.used = (localStorage.getItem(KEY) || "").length * 2; } catch (e) {}
    out.quota = 5 * 1024 * 1024;
  }
  return out;
}

/** 存檔（預設延遲 400ms 合併多次寫入，避免每個按鍵都寫一次） */
export function save(immediate = false) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const fail = (e) => {
    console.error("[store] 寫入失敗（可能是容量已滿）", e);
    window.dispatchEvent(new CustomEvent("store:error", { detail: e }));
  };
  const doSave = () => {
    saveTimer = null;
    state.savedAt = Date.now();
    if (db) {
      // put 的當下就把資料複製一份，之後再改記憶體裡的 state 不會影響這次寫入
      try { idbPut(DB_KEY, state).catch(fail); } catch (e) { fail(e); }
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { fail(e); }
  };
  if (immediate) doSave(); else saveTimer = setTimeout(doSave, 400);
}

export function settings() { return load().settings; }
export function vocab()    { return load().vocab; }
export function lookups()  { return load().lookups; }
export function sessions() { return load().sessions; }
export function reviewLog() { return load().reviewLog; }
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

// 查詢快取上限：IndexedDB 空間大，可以留很多；退回 localStorage 時維持小一點
const lookupMax = () => (roomy() ? 30000 : 3000);

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
  if (keys.length > lookupMax()) {
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
export async function wipe() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(KEY); } catch (e) {}
  if (db) { try { await idbDel(DB_KEY); } catch (e) {} }
  state = null;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

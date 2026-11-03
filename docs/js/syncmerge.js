/**
 * syncmerge.js — 雲端同步的「合併」規則（純函式，不碰網路、不碰 Firebase）
 *
 * 兩台裝置可能都離線改過資料，所以不能「誰最後上傳誰贏」，要三方合併：
 *   本機（local）、雲端（remote）、上次同步完的樣子（base，只存每筆資料的雜湊值）。
 *   - 只有一邊改過 → 用改過的那邊
 *   - 兩邊都改過   → 依規則挑比較新的（單字看最後複習時間與複習次數）
 *   - 一邊刪掉、另一邊沒動 → 刪掉
 *   - 一邊刪掉、另一邊有改 → 保留（改過的比刪除重要）
 * base 是空的（第一次同步、換新裝置）時，等於兩邊聯集，不會刪任何東西。
 *
 * 合併結果直接寫回本機的物件（同一個陣列、同一個物件），
 * 其他模組手上拿著的參照（例如正在複習的卡片）不會失效。
 */

/* ---------- 雜湊 ---------- */

/** FNV-1a 32 位元，夠用來判斷「這筆資料有沒有變」 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 物件的雜湊：鍵排序後再序列化，欄位順序不同也算同一份 */
export function hashOf(v) { return hashStr(stable(v)); }

function stable(v) {
  if (v === undefined) return "u";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

/* ---------- 要同步哪些東西 ---------- */

// 這些設定只跟「這台裝置」有關，不同步
const LOCAL_ONLY_SETTINGS = new Set(["browserVoice", "onboardedAt"]);
// API 金鑰永遠不以明文上傳：要同步的話，由 vault.js 用使用者的同步密碼加密後放在 payload.vault
const KEY_SETTINGS = new Set(["geminiKey", "groqKey"]);

/** 哪些設定欄位要同步（「同步金鑰」開關 syncKeys 本身會同步，讓每台裝置知道要不要處理保險箱） */
export function syncableSetting(k) {
  return !LOCAL_ONLY_SETTINGS.has(k) && !KEY_SETTINGS.has(k);
}

/**
 * 從本機資料挑出要上傳的部分。
 * 查詢快取（lookups）可以重查、AI 用量是各裝置各自的，都不上傳，省雲端空間。
 */
export function buildPayload(st, { vault = null } = {}) {
  const settings = {};
  for (const [k, v] of Object.entries(st.settings || {})) {
    if (syncableSetting(k)) settings[k] = v;
  }
  const out = {
    v: 1,
    settings,
    vocab: st.vocab || [],
    sessions: st.sessions || [],
    reviewLog: st.reviewLog || [],
    daily: st.daily || {},
    coach: st.coach || {},
  };
  // 加密過的金鑰保險箱（沒開金鑰同步就不放）
  if (vault) out.vault = vault;
  return out;
}

/** 記下「這次同步完的樣子」：每筆資料只存雜湊，很小 */
export function snapshotBase(payload) {
  const vocab = {}, sessions = {}, settings = {};
  for (const v of payload.vocab) if (v && v.id) vocab[v.id] = hashOf(v);
  for (const s of payload.sessions) if (s && s.id) sessions[s.id] = hashOf(s);
  for (const [k, v] of Object.entries(payload.settings)) settings[k] = hashOf(v);
  return { vocab, sessions, settings };
}

/* ---------- 合併 ---------- */

/** 把 src 的內容整個搬進 dst（保留 dst 這個物件本身） */
function assignInPlace(dst, src) {
  for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
  Object.assign(dst, JSON.parse(JSON.stringify(src)));
}

/** 兩張同一個字的卡都改過：複習得比較新、比較多的那張贏 */
function newerCard(l, r) {
  const a = [l.lastReview || 0, l.reps || 0, l.produced || 0];
  const b = [r.lastReview || 0, r.reps || 0, r.produced || 0];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] > a[i] ? "r" : "l";
  return "l";
}

/** 兩邊都改過的對話紀錄：輪數多的（比較完整的）贏 */
function newerSession(l, r) {
  const n = (s) => (s.turns ? s.turns.length : 0) + (s.end || 0) / 1e13;
  return n(r) > n(l) ? "r" : "l";
}

/**
 * 依 id 三方合併一個陣列，直接改寫 local 陣列。
 * 回傳 { pulled, changed }：pulled = 從雲端帶進來或刪掉幾筆，changed = 結果跟雲端有沒有不同
 */
function mergeById(local, remote, base, pick) {
  const L = new Map(), R = new Map();
  for (const x of local) if (x && x.id) L.set(x.id, x);
  for (const x of remote || []) if (x && x.id) R.set(x.id, x);
  const out = [];
  let pulled = 0;
  const seen = new Set();

  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const l = L.get(id), r = R.get(id), b = base[id];
    if (l && r) {
      const hl = hashOf(l), hr = hashOf(r);
      if (hl !== hr) {
        if (hl === b) { assignInPlace(l, r); pulled++; }              // 只有雲端改過
        else if (hr !== b && pick(l, r) === "r") { assignInPlace(l, r); pulled++; }   // 兩邊都改過
      }
      out.push(l);
    } else if (l) {
      // 雲端沒有：base 有記錄而且本機沒改 → 是在別台刪掉的
      if (b !== undefined && hashOf(l) === b) { pulled++; return; }
      out.push(l);
    } else if (r) {
      // 本機沒有：base 有記錄而且雲端沒改 → 是在這台刪掉的
      if (b !== undefined && hashOf(r) === b) return;
      out.push(JSON.parse(JSON.stringify(r)));
      pulled++;
    }
  };
  // 保持本機原本的順序，雲端多出來的接在後面
  for (const x of local) if (x && x.id) visit(x.id);
  for (const x of remote || []) if (x && x.id) visit(x.id);
  // 沒有 id 的（理論上不會有）原樣留著
  for (const x of local) if (!x || !x.id) out.push(x);

  local.length = 0;
  local.push(...out);
  return pulled;
}

/**
 * 同一個字在兩台裝置各加了一次（id 不同）→ 只留一張：
 * 複習比較多的那張留下，標籤合併。回傳刪掉幾張。
 */
function dedupeVocab(vocab) {
  const byWord = new Map();
  const drop = new Set();
  for (const v of vocab) {
    const k = String(v.word || "").trim().toLowerCase();
    if (!k) continue;
    const cur = byWord.get(k);
    if (!cur) { byWord.set(k, v); continue; }
    // 比較好的留下；同分時 id 小的留下（兩台裝置算出來的結果才會一樣）
    let keep = cur, lose = v;
    const w = newerCard(cur, v);
    if (w === "r" || (w === "l" && sameProgress(cur, v) && String(v.id) < String(cur.id))) { keep = v; lose = cur; }
    keep.tags = [...new Set([...(keep.tags || []), ...(lose.tags || [])])];
    for (const f of ["zh", "pos", "phonetic", "example", "exampleZh"]) if (!keep[f] && lose[f]) keep[f] = lose[f];
    byWord.set(k, keep);
    drop.add(lose);
  }
  if (!drop.size) return 0;
  const kept = vocab.filter(v => !drop.has(v));
  vocab.length = 0;
  vocab.push(...kept);
  return drop.size;
}
function sameProgress(a, b) {
  return (a.lastReview || 0) === (b.lastReview || 0) && (a.reps || 0) === (b.reps || 0) && (a.produced || 0) === (b.produced || 0);
}

/**
 * 把雲端資料併進本機 state（直接改 st）。
 * remote 是雲端那份 payload（沒有雲端資料時傳 null）；base 是上次同步完的雜湊（第一次同步傳 null）。
 * 回傳 { pulledVocab, pulledSessions, settingsChanged, logAdded }
 */
export function mergeInto(st, remote, base, { logMax = 6000 } = {}) {
  const b = base || { vocab: {}, sessions: {}, settings: {} };
  const res = { pulledVocab: 0, pulledSessions: 0, settingsChanged: [], logAdded: 0 };
  if (!remote) return res;

  st.vocab = st.vocab || [];
  st.sessions = st.sessions || [];
  st.reviewLog = st.reviewLog || [];
  st.daily = st.daily || {};
  st.coach = st.coach || {};
  st.settings = st.settings || {};

  // 單字本
  res.pulledVocab = mergeById(st.vocab, remote.vocab, b.vocab || {}, newerCard);
  res.pulledVocab += dedupeVocab(st.vocab);

  // 對話紀錄（依開始時間排）
  res.pulledSessions = mergeById(st.sessions, remote.sessions, b.sessions || {}, newerSession);
  st.sessions.sort((x, y) => (x.start || 0) - (y.start || 0));

  // 作答紀錄：只會一直加，取聯集（同一時間、同一個字算同一筆），只留最近 logMax 筆
  const key = (r) => `${r.t}|${r.w}`;
  const have = new Set(st.reviewLog.map(key));
  for (const r of remote.reviewLog || []) {
    if (!r || have.has(key(r))) continue;
    st.reviewLog.push(r);
    have.add(key(r));
    res.logAdded++;
  }
  if (res.logAdded) {
    st.reviewLog.sort((x, y) => (x.t || 0) - (y.t || 0));
    if (st.reviewLog.length > logMax) st.reviewLog.splice(0, st.reviewLog.length - logMax);
  }

  // 每日統計：每個欄位都只會變大，取比較大的
  for (const [day, row] of Object.entries(remote.daily || {})) {
    const cur = st.daily[day];
    if (!cur) { st.daily[day] = { ...row }; continue; }
    for (const [f, val] of Object.entries(row)) {
      if (typeof val === "number" && val > (cur[f] || 0)) cur[f] = val;
    }
  }

  // AI 週報快取：本機沒有的才補
  for (const [k, v] of Object.entries(remote.coach || {})) if (!(k in st.coach)) st.coach[k] = v;

  // 設定：逐欄三方合併；不同步的欄位完全不碰
  // 第一次同步（base 是空的，例如新裝置登入）→ 以雲端帳號的設定為準，不然新裝置的預設值會蓋掉你原本的設定
  const firstSync = !base;
  const bs = b.settings || {};
  const rs = remote.settings || {};
  const adopt = (k) => {
    const lv = st.settings[k], rv = rs[k];
    const hl = hashOf(lv);
    if (hl === hashOf(rv)) return;
    const empty = lv === undefined || lv === "";
    // 本機沒改過 → 用雲端的
    const localUntouched = bs[k] !== undefined ? hl === bs[k] : (firstSync || empty);
    if (localUntouched) {
      st.settings[k] = rv;
      res.settingsChanged.push(k);
    }
  };
  // 舊版曾經以明文上傳金鑰：syncableSetting 會把它們擋掉，不會寫進本機；下次上傳就從雲端消失
  for (const k of Object.keys(rs)) {
    if (syncableSetting(k)) adopt(k);
  }
  return res;
}

/* ---------- 壓縮與切塊 ---------- */

/** JSON → gzip 位元組（瀏覽器不支援壓縮時直接用 UTF-8） */
export async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return { enc: "json", bytes };
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { enc: "gzip", bytes: new Uint8Array(await new Response(cs).arrayBuffer()) };
}

export async function unpack(enc, bytes) {
  let raw = bytes;
  if (enc === "gzip") {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    raw = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

/** 切成每塊最多 size 位元組（Firestore 一份文件上限 1 MiB，留一點空間給欄位名稱） */
export function split(bytes, size = 900 * 1024) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  if (!out.length) out.push(new Uint8Array(0));
  return out;
}

export function join(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

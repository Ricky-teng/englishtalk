/**
 * sync.js — 雲端同步（Firebase：Google 登入＋Firestore）
 *
 * 不登入：一切照舊，資料只在這台裝置。
 * 登入後：單字本、複習進度、對話紀錄、每日統計、設定會自動同步到雲端，
 *         換裝置登入同一個 Google 帳號就能接著用。
 *
 * 雲端的資料長這樣（每個人只讀寫得到自己的，見 tools/firebase/firestore.rules）：
 *   users/{uid}            { rev, n, enc, hash, size, updatedAt, device }   ← 「目錄」
 *   users/{uid}/chunks/{i} { rev, i, d: Bytes }                            ← gzip 壓縮後切塊的資料
 * 整份資料壓縮後通常只有幾十 KB，一次同步只要寫 2 份文件，免費額度很夠用。
 *
 * 同步流程（syncNow）：
 *   1. 讀目錄；雲端版本（rev）跟上次同步的不同 → 下載、跟本機三方合併（規則在 syncmerge.js）
 *   2. 合併後跟雲端不一樣 → 用交易（transaction）上傳；上傳前有別台搶先寫了 → 重來一次
 *   3. 記下這次同步完的樣子（只存雜湊），下次才分得出「誰改了什麼」
 *
 * Firebase SDK 只有在「網站有設定 Firebase」而且「你按了登入（或之前登入過）」時才載入，
 * 沒用到雲端同步的人不會多下載任何東西。
 */

import * as Store from "./store.js";
import * as M from "./syncmerge.js";
import * as Vault from "./vault.js";
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.3.0/";
const BASE_KEY = "englishtalk.syncBase";   // 上次同步完的樣子：{ uid, rev, hash, base }
const FLAG_KEY = "englishtalk.syncOn";     // 這台裝置登入過：下次打開自動載入 SDK
const DEV_KEY = "englishtalk.deviceId";
const VREMOTE = "englishtalk.vaultRemote";   // 雲端目前的金鑰保險箱（密文）；這台還沒解鎖時原樣保留，不會被蓋掉
const VCACHE = "englishtalk.vaultCache";     // { fp, vault }：本機金鑰沒變就沿用同一個保險箱，不用重新上傳
const VSEEN = "englishtalk.vaultSeen";       // 已經解開套用過的保險箱雜湊
const DEBOUNCE_MS = 15000;                 // 改完資料 15 秒沒再動就上傳
const MAX_WAIT_MS = 60000;                 // 一直有在改的話，最多 60 秒也要上傳一次

/** 目前狀態（UI 用）。state：off 未登入／idle 已同步／syncing 同步中／offline 離線／error 失敗 */
export const status = {
  configured: false,
  loading: false,
  user: null,          // { uid, email, name, photo }
  state: "off",
  lastSync: 0,
  error: "",
  vault: "off",        // 金鑰同步：off 沒開／ready 這台已解鎖／locked 要輸入同步密碼／unsupported 瀏覽器不支援
};

let fb = null;                 // { auth, db, A: auth 模組, F: firestore 模組 }
let sdkPromise = null;
let timer = null, firstDirty = 0;
let running = null, again = false;
let unsubMeta = null;
let lockedNotified = false;

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

const lsJSON = (k) => { try { return JSON.parse(lsGet(k) || "null"); } catch (e) { return null; } };
const lsSetJSON = (k, v) => (v == null ? lsDel(k) : lsSet(k, JSON.stringify(v)));

function emit() {
  status.vault = vaultState();
  window.dispatchEvent(new CustomEvent("sync:status", { detail: status }));
}
function setState(s, err = "") { status.state = s; status.error = err; emit(); }

export function configured() {
  return !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);
}

function deviceId() {
  let d = lsGet(DEV_KEY);
  if (!d) { d = Math.random().toString(36).slice(2, 10); lsSet(DEV_KEY, d); }
  return d;
}

function readBase(uid) {
  try {
    const b = JSON.parse(lsGet(BASE_KEY) || "null");
    if (b && b.uid === uid) return b;
  } catch (e) {}
  return { uid, rev: -1, hash: "", base: null };   // 沒同步過：第一次會是「聯集」合併，不會刪任何東西
}
function writeBase(b) { lsSet(BASE_KEY, JSON.stringify(b)); }

/* ---------- 啟動 ---------- */

/** app 啟動時呼叫一次（Store.init 之後） */
export function init() {
  status.configured = configured();
  if (!status.configured) return;
  // 資料有存檔就排一次同步
  window.addEventListener("store:saved", (e) => { if (!(e.detail && e.detail.fromSync)) schedule(); });
  // 切到背景、恢復連線：盡快同步
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && timer) syncNow();
    if (document.visibilityState === "visible" && status.user) schedule(2000);
  });
  window.addEventListener("online", () => status.user && schedule(1000));
  // 之前登入過 → 背景載入 SDK，Firebase 會自己恢復登入狀態
  if (lsGet(FLAG_KEY)) loadSDK().catch(e => setState("error", friendly(e)));
  emit();
}

async function loadSDK() {
  if (fb) return fb;
  if (sdkPromise) return sdkPromise;
  status.loading = true; emit();
  sdkPromise = (async () => {
    const [appM, A, F] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-firestore.js"),
    ]);
    const app = appM.initializeApp(firebaseConfig);
    const auth = A.getAuth(app);
    const db = F.getFirestore(app);
    // 本機測試用：設定裡有 emulators 就連到 Firebase 模擬器
    const emu = firebaseConfig.emulators;
    if (emu) {
      if (emu.auth) A.connectAuthEmulator(auth, emu.auth, { disableWarnings: true });
      if (emu.firestore) F.connectFirestoreEmulator(db, emu.firestore[0], emu.firestore[1]);
    }
    fb = { app, auth, db, A, F };
    window.__etFirebase = fb;   // 給自動測試與除錯用
    // 用「跳轉」方式登入回來時，在這裡接住結果（錯誤才需要處理，成功會觸發 onAuthStateChanged）
    A.getRedirectResult(auth).catch(e => setState("error", friendly(e)));
    A.onAuthStateChanged(auth, onUser);
    return fb;
  })();
  try { return await sdkPromise; }
  catch (e) { sdkPromise = null; throw e; }
  finally { status.loading = false; emit(); }
}

function onUser(u) {
  if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  if (!u) {
    status.user = null;
    lsDel(FLAG_KEY);
    setState("off");
    return;
  }
  status.user = { uid: u.uid, email: u.email || "", name: u.displayName || "", photo: u.photoURL || "" };
  lsSet(FLAG_KEY, "1");
  // 別台裝置上傳了新版本 → 這台馬上拉下來（每次變動只花 1 次讀取）
  const { F, db } = fb;
  unsubMeta = F.onSnapshot(F.doc(db, "users", u.uid), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    if ((snap.data().rev || 0) !== readBase(u.uid).rev) schedule(1500);
  }, () => { /* 離線或權限錯誤：等下一次 syncNow 再顯示 */ });
  syncNow();
}

/* ---------- 登入／登出 ---------- */

export async function signIn() {
  if (!configured()) throw new Error("網站還沒設定 Firebase");
  const { A, auth } = await loadSDK();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    const code = e && e.code || "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return false;
    // 瀏覽器擋彈出視窗（或 App 模式不支援）→ 改用整頁跳轉
    if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
      await A.signInWithRedirect(auth, provider);
      return false;
    }
    throw new Error(friendly(e));
  }
  return true;
}

/** 登出：先把還沒上傳的傳完；本機資料保留 */
export async function signOut() {
  if (!fb) return;
  if (status.user) { try { await syncNow(); } catch (e) {} }
  clearTimeout(timer); timer = null; firstDirty = 0;
  lsDel(BASE_KEY);
  forgetVault();
  await fb.A.signOut(fb.auth);
}

/**
 * 「清除所有資料」用：直接登出、忘掉同步紀錄，不上傳。
 * （不然清空後的本機會被當成「全部刪掉」同步到雲端）
 */
export async function forget() {
  clearTimeout(timer); timer = null; firstDirty = 0;
  lsDel(BASE_KEY);
  lsDel(FLAG_KEY);
  forgetVault();
  if (fb) { try { await fb.A.signOut(fb.auth); } catch (e) {} }
  // SDK 還沒載入（這次沒用到同步）：直接刪掉 Firebase 記住登入狀態的資料庫，效果等於登出
  else { try { indexedDB.deleteDatabase("firebaseLocalStorageDb"); } catch (e) {} }
}

/* ---------- 同步 ---------- */

/** 排一次同步（合併短時間內的多次存檔） */
export function schedule(ms = DEBOUNCE_MS) {
  if (!status.user) return;
  const now = Date.now();
  if (!firstDirty) firstDirty = now;
  // 一直有在改也不能一直延後
  const wait = Math.max(0, Math.min(ms, firstDirty + MAX_WAIT_MS - now));
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncNow(); }, wait);
}

/** 立刻同步一次；同步中再被呼叫的話，做完會再補一次 */
export function syncNow() {
  if (!fb || !status.user) return Promise.resolve();
  if (running) { again = true; return running; }
  clearTimeout(timer); timer = null; firstDirty = 0;
  running = (async () => {
    setState("syncing");
    try {
      const res = await syncOnce();
      status.lastSync = Date.now();
      setState("idle");
      if (status.vault === "locked" && !lockedNotified) {
        lockedNotified = true;
        window.dispatchEvent(new CustomEvent("sync:locked"));
      }
      if (res && (res.pulledVocab || res.pulledSessions || res.logAdded || res.settingsChanged.length)) {
        window.dispatchEvent(new CustomEvent("sync:pulled", { detail: res }));
      }
    } catch (e) {
      const offline = !navigator.onLine || /offline|unavailable/i.test(String(e && (e.code || e.message)));
      setState(offline ? "offline" : "error", friendly(e));
    } finally {
      running = null;
      if (again) { again = false; schedule(1000); }
    }
  })();
  return running;
}

async function syncOnce() {
  const { F, db } = fb;
  const uid = status.user.uid;
  const metaRef = F.doc(db, "users", uid);
  let pulled = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await F.getDoc(metaRef);
    const meta = snap.exists() ? snap.data() : null;
    const saved = readBase(uid);
    const st = Store.load();

    // 1. 雲端有新版本 → 拉下來合併（「同步金鑰」開關可能在這一步從雲端改變）
    if (meta && meta.rev !== saved.rev) {
      const remote = await readRemote(uid, meta);
      if (!remote) continue;               // 讀到一半被別台改掉了，重來
      const res = M.mergeInto(st, remote, saved.base, { logMax: Store.roomy() ? 50000 : 6000 });
      await takeRemoteVault(st, remote.vault || null, res);
      if (res.pulledVocab || res.pulledSessions || res.logAdded || res.settingsChanged.length) {
        Store.save(true, { fromSync: true });
        pulled = pulled ? addRes(pulled, res) : res;
      }
    }

    // 2. 本機跟雲端不一樣 → 上傳
    const payload = M.buildPayload(st, { vault: await localVault(st) });
    const hash = M.hashOf(payload);
    let rev = meta ? (meta.rev || 0) : 0;
    if (!meta || hash !== meta.hash) {
      try {
        rev = await writeRemote(uid, payload, hash, rev, meta ? (meta.n || 0) : 0);
      } catch (e) {
        if (e && e.conflict) continue;     // 別台搶先上傳了：重新合併一次
        throw e;
      }
    }

    // 3. 記下這次同步完的樣子
    writeBase({ uid, rev, hash, base: M.snapshotBase(payload) });
    lsSetJSON(VREMOTE, payload.vault || null);
    if (payload.vault) { Vault.markUploaded(); lsSet(VSEEN, M.hashOf(payload.vault)); }
    return pulled;
  }
  throw new Error("雲端資料一直在變動，等一下再試");
}

function addRes(a, b) {
  return {
    pulledVocab: a.pulledVocab + b.pulledVocab,
    pulledSessions: a.pulledSessions + b.pulledSessions,
    logAdded: a.logAdded + b.logAdded,
    settingsChanged: [...new Set([...a.settingsChanged, ...b.settingsChanged])],
  };
}

/** 下載雲端資料；任何一塊的版本跟目錄對不上（正在被別台寫）就回傳 null */
async function readRemote(uid, meta) {
  const { F, db } = fb;
  const snaps = await Promise.all(Array.from({ length: meta.n || 0 },
    (_, i) => F.getDoc(F.doc(db, "users", uid, "chunks", String(i)))));
  const parts = [];
  for (const s of snaps) {
    if (!s.exists() || s.data().rev !== meta.rev) return null;
    parts.push(s.data().d.toUint8Array());
  }
  return M.unpack(meta.enc, M.join(parts));
}

/** 上傳（交易）：雲端版本還是 expectedRev 才寫入，不然丟出 conflict */
async function writeRemote(uid, payload, hash, expectedRev, oldN) {
  const { F, db } = fb;
  const { enc, bytes } = await M.pack(payload);
  const parts = M.split(bytes);
  const metaRef = F.doc(db, "users", uid);
  const newRev = expectedRev + 1;
  await F.runTransaction(db, async (tx) => {
    const snap = await tx.get(metaRef);
    const cur = snap.exists() ? (snap.data().rev || 0) : 0;
    if (cur !== expectedRev) { const e = new Error("conflict"); e.conflict = true; throw e; }
    const prevN = snap.exists() ? (snap.data().n || 0) : oldN;
    parts.forEach((p, i) => tx.set(F.doc(db, "users", uid, "chunks", String(i)),
      { rev: newRev, i, d: F.Bytes.fromUint8Array(p) }));
    for (let i = parts.length; i < prevN; i++) tx.delete(F.doc(db, "users", uid, "chunks", String(i)));
    tx.set(metaRef, {
      rev: newRev, n: parts.length, enc, hash, size: bytes.length,
      updatedAt: F.serverTimestamp(), device: deviceId(),
    });
  });
  return newRev;
}

/* ---------- API 金鑰（端對端加密） ---------- */

function vaultState() {
  if (!Vault.supported()) return "unsupported";
  if (!Store.settings().syncKeys) return "off";
  const lk = Vault.localKey(), rv = lsJSON(VREMOTE);
  if (lk && (!rv || rv.salt === lk.salt || lk.fresh)) return "ready";
  return "locked";
}

/** 雲端有沒有加密過的金鑰（決定按下「同步金鑰」時是要「設定密碼」還是「輸入密碼」） */
export function remoteVault() { return lsJSON(VREMOTE); }

/** 把解開的金鑰寫進本機設定 */
function applyKeys(st, data, changed) {
  for (const f of Vault.KEY_FIELDS) {
    if (data[f] && st.settings[f] !== data[f]) { st.settings[f] = data[f]; changed.push(f); }
  }
}

/** 拉到雲端資料時：記下雲端的保險箱；這台解得開而且是新的，就套用裡面的金鑰 */
async function takeRemoteVault(st, rv, res) {
  lsSetJSON(VREMOTE, rv);
  if (!rv || !st.settings.syncKeys) return;
  const h = M.hashOf(rv);
  if (h === lsGet(VSEEN)) return;
  const data = await Vault.open(rv);
  if (!data) return;                       // 這台還沒解鎖，或別台改過密碼：等使用者輸入密碼
  applyKeys(st, data, res.settingsChanged);
  lsSet(VSEEN, h);
  lsSetJSON(VCACHE, { fp: await Vault.fingerprint(st.settings), vault: rv });
}

/** 要上傳的保險箱 */
async function localVault(st) {
  if (!st.settings.syncKeys || !Vault.supported()) return null;
  const lk = Vault.localKey(), rv = lsJSON(VREMOTE);
  if (!lk) return rv;                                      // 這台還沒解鎖：原樣保留雲端的
  if (rv && rv.salt !== lk.salt && !lk.fresh) return rv;   // 別台改過密碼、這台還沒重新解鎖
  const fp = await Vault.fingerprint(st.settings);
  const c = lsJSON(VCACHE);
  if (c && c.fp === fp && c.vault && c.vault.salt === lk.salt) return c.vault;
  const v = await Vault.seal(st.settings);
  lsSetJSON(VCACHE, { fp, vault: v });
  return v;
}

function forgetVault() {
  Vault.forget();
  lsDel(VREMOTE); lsDel(VCACHE); lsDel(VSEEN);
  lockedNotified = false;
}

/** 打開金鑰同步（第一次）或重設同步密碼：用這台的金鑰建立新的保險箱，蓋掉雲端舊的 */
export async function setKeyPassphrase(pass) {
  await Vault.setPassphrase(pass);
  lsDel(VCACHE);
  Store.settings().syncKeys = true;
  Store.save(true);
  emit();
  await syncNow();
}

/** 新裝置：輸入同步密碼，打開雲端的保險箱。密碼錯回傳 false */
export async function unlockKeys(pass) {
  const rv = lsJSON(VREMOTE);
  if (!rv) return false;
  const data = await Vault.unlock(pass, rv);
  if (!data) return false;
  const st = Store.load();
  const changed = [];
  applyKeys(st, data, changed);
  lsSet(VSEEN, M.hashOf(rv));
  lsSetJSON(VCACHE, { fp: await Vault.fingerprint(st.settings), vault: rv });
  Store.save(true, { fromSync: true });
  emit();
  window.dispatchEvent(new CustomEvent("sync:pulled", {
    detail: { pulledVocab: 0, pulledSessions: 0, logAdded: 0, settingsChanged: changed } }));
  syncNow();
  return true;
}

/** 關掉金鑰同步：下次同步會把雲端的保險箱刪掉（各裝置本機的金鑰保留） */
export async function disableKeySync() {
  Store.settings().syncKeys = false;
  Store.save(true);
  forgetVault();
  emit();
  await syncNow();
}

/* ---------- 錯誤訊息 ---------- */

function friendly(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/unauthorized-domain": "這個網址還沒加進 Firebase 的「授權網域」",
    "auth/network-request-failed": "網路連不上，等一下再試",
    "auth/operation-not-allowed": "Firebase 還沒開啟 Google 登入",
    "auth/popup-blocked": "瀏覽器擋住了登入視窗，請允許這個網站的彈出視窗",
    "permission-denied": "雲端拒絕存取（Firestore 安全規則沒設好）",
    "unavailable": "目前離線，連上網路後會自動同步",
    "resource-exhausted": "雲端今天的免費額度用完了，明天會恢復",
  };
  for (const [k, v] of Object.entries(map)) if (code === k || code.endsWith("/" + k)) return v;
  if (/Failed to fetch|dynamically imported module/i.test(String(e && e.message))) return "載入 Firebase 失敗，請確認有連上網路";
  return (e && e.message) || String(e);
}

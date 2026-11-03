/**
 * vault.js — API 金鑰的端對端加密（雲端同步用）
 *
 * 金鑰在瀏覽器裡先用「同步密碼」加密才上傳，雲端（以及網站管理者）只看得到密文。
 *   同步密碼 ──PBKDF2-SHA256（60 萬次）＋隨機 salt──▶ AES-GCM 256 位元金鑰
 *   { geminiKey, groqKey } ──AES-GCM（每次隨機 IV）──▶ 密文
 * 雲端存的「保險箱」：{ v, kdf, iter, salt, iv, ct }，沒有密碼就解不開；
 * 密碼錯的話 AES-GCM 的驗證會失敗，所以也不用另外存「驗證碼」。
 *
 * 這台裝置解開過一次後，會把「推導出來的 AES 金鑰」（不是密碼本身）存在本機，
 * 之後同步不用再輸入密碼。它跟 API 金鑰本來就存在本機一樣，只留在這台裝置，不會上傳、不會進備份檔。
 */

const LOCAL_KEY = "englishtalk.vaultKey";   // { salt, iter, k: base64 的 AES 金鑰 }
const ITER = 600000;                         // OWASP 2023 對 PBKDF2-SHA256 的建議次數
export const KEY_FIELDS = ["geminiKey", "groqKey"];

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function supported() {
  return !!(window.crypto && crypto.subtle && window.isSecureContext);
}

/** 密碼 + salt → AES-GCM 金鑰（可匯出，才能存在本機） */
async function derive(pass, salt, iter = ITER) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function importAes(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* ---------- 本機記住的金鑰 ---------- */

export function localKey() {
  try {
    const k = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
    return k && k.salt && k.k ? k : null;
  } catch (e) { return null; }
}

async function remember(aesKey, salt, iter, fresh) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));
  const rec = { salt: b64(salt), iter, k: b64(raw), fresh: !!fresh };
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(rec)); } catch (e) {}
  return rec;
}

/** 上傳成功後：這把金鑰已經是雲端那把了 */
export function markUploaded() {
  const k = localKey();
  if (k && k.fresh) { k.fresh = false; try { localStorage.setItem(LOCAL_KEY, JSON.stringify(k)); } catch (e) {} }
}

export function forget() {
  try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
}

/* ---------- 設定密碼、解鎖 ---------- */

/** 設定（或重設）同步密碼：產生新的 salt。fresh = 還沒上傳，上傳時會蓋掉雲端舊的保險箱 */
export async function setPassphrase(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(pass, salt, ITER);
  return remember(key, salt, ITER, true);
}

/**
 * 用密碼打開雲端的保險箱。成功回傳裡面的金鑰（並記住這台裝置的解鎖金鑰），密碼錯回傳 null。
 */
export async function unlock(pass, vault) {
  const salt = unb64(vault.salt);
  const key = await derive(pass, salt, vault.iter || ITER);
  try {
    const data = await decryptWith(key, vault);
    await remember(key, salt, vault.iter || ITER, false);
    return data;
  } catch (e) {
    return null;
  }
}

/* ---------- 加密、解密 ---------- */

async function decryptWith(aesKey, vault) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, aesKey, unb64(vault.ct));
  return JSON.parse(dec.decode(pt));
}

/** 用這台記住的金鑰解開保險箱；salt 不同（別台重設過密碼）或解不開都回傳 null */
export async function open(vault) {
  const lk = localKey();
  if (!lk || !vault || lk.salt !== vault.salt) return null;
  try { return await decryptWith(await importAes(unb64(lk.k)), vault); }
  catch (e) { return null; }
}

/** 把本機的金鑰鎖進新的保險箱 */
export async function seal(settings) {
  const lk = localKey();
  if (!lk) return null;
  const data = {};
  for (const f of KEY_FIELDS) if (settings[f]) data[f] = settings[f];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await importAes(unb64(lk.k)), enc.encode(JSON.stringify(data))));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: lk.iter, salt: lk.salt, iv: b64(iv), ct: b64(ct) };
}

/** 本機金鑰的指紋（加上 salt）：金鑰沒變就沿用上次的保險箱，不用每次重新加密、重新上傳 */
export async function fingerprint(settings) {
  const lk = localKey();
  const s = KEY_FIELDS.map(f => settings[f] || "").join("\n") + "\n" + (lk ? lk.salt : "");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return b64(h.slice(0, 12));
}

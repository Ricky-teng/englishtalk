/**
 * firebase-config.js — 雲端同步用的 Firebase 設定
 *
 * 到 Firebase Console → 專案設定 → 一般 → 「你的應用程式」→ 網頁應用程式（</>）
 * 把 firebaseConfig 那一段的值貼進下面。
 *
 * 這一段本來就是公開的（每個用 Firebase 的網站都會把它放在前端），
 * 真正保護資料的是 Firestore 安全規則（tools/firebase/firestore.rules），不是這段設定。
 *
 * 留空（apiKey 或 projectId 是空字串）＝ 網站不顯示雲端同步，其他功能照常。
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCtvfUiBeqVCbryGMV0Es4WabuGM4Cbi90",
  authDomain: "englishtalk-32915.firebaseapp.com",
  projectId: "englishtalk-32915",
  storageBucket: "englishtalk-32915.firebasestorage.app",
  messagingSenderId: "166978225035",
  appId: "1:166978225035:web:6f44a56f63067ce733e58e",
  measurementId: "G-REE5XPH1V2"
};

# 雲端同步（Firebase）設定步驟

網站的雲端同步用 Firebase：**Google 登入**＋**Firestore** 存資料。
`docs/js/firebase-config.js` 留空時，網站完全不顯示雲端同步，其他功能照常。

## 1. 開啟 Google 登入

Firebase Console → 你的專案 → **Authentication** → 開始使用 → **Sign-in method** → **Google** → 啟用 → 選一個支援用的 email → 儲存。

## 2. 加入授權網域

Authentication → **Settings** → **授權網域（Authorized domains）** → 新增：

```
ricky-teng.github.io
```

（`localhost` 預設就有，本機測試不用加。）

## 3. 建立 Firestore 資料庫

**Firestore Database** → 建立資料庫 → 選 **正式版模式（production mode）** → 地區建議 `asia-east1`（台灣）。

## 4. 貼上安全規則

Firestore Database → **規則（Rules）** → 整段換成 `tools/firebase/firestore.rules` 的內容 → **發布**。

這份規則只允許「登入的人讀寫自己的那一份」，別人就算拿到網站設定也讀不到你的資料。

## 5. 把網站設定貼進程式

專案設定（齒輪）→ 一般 → **你的應用程式** → 新增應用程式 → 網頁（`</>`）→ 取個名字（不用勾 Hosting）→
複製 `firebaseConfig` 那一段的值，貼進 `docs/js/firebase-config.js`，推上 GitHub 就完成了。

> 這段設定（含 apiKey）本來就是公開在前端的，**可以 commit**；保護資料的是第 4 步的安全規則。
> （這跟 Gemini／Groq 的金鑰不一樣，那些絕對不能 commit。）

## 6.（建議）限制 API 金鑰只能從你的網站使用

Google Cloud Console → 選同一個專案 → API 和服務 → **憑證** → 「Browser key (auto created by Firebase)」→
應用程式限制選 **網站**，加入：

```
https://ricky-teng.github.io/*
https://<你的專案ID>.firebaseapp.com/*
http://localhost/*
```

第二行一定要加，Google 登入的彈出視窗是從那個網域跑的。

## 免費額度夠不夠？

Spark（免費）方案每天：讀取 5 萬次、寫入 2 萬次，總容量 1 GiB。

- 每個人整份資料 gzip 壓縮後通常只有幾 KB 到幾百 KB，存成 1～2 份文件。
- 一次有變動的同步 ≈ 2～3 次讀取＋2 次寫入；沒變動只讀 1 次。
- 改資料後 15 秒（最多 60 秒）才上傳一次，連續操作會合併。

粗估每天活躍 1,000 人以內都在免費額度內。額度用完時同步會暫停，隔天自動恢復，本機資料不受影響。

## 資料結構

```
users/{uid}             { rev, n, enc, hash, size, updatedAt, device }
users/{uid}/chunks/{i}  { rev, i, d: Bytes }   ← gzip 壓縮後的資料，超過 900 KB 才會切第二塊
```

同步的有：單字本、複習進度、作答紀錄、對話紀錄、每日統計、AI 週報、設定。
不同步的有：查字快取（可以重查）、AI 用量（各裝置各自算）、瀏覽器語音（每台裝置不同）。
API 金鑰只有使用者在「紀錄 → 雲端同步」打開「也同步 API 金鑰」才會上傳。

## 本機用模擬器測試

```
npm i -g firebase-tools
firebase emulators:start --only auth,firestore --project demo-et
```

在 `firebase-config.js` 暫時加上（測完記得拿掉）：

```js
emulators: { auth: "http://127.0.0.1:9099", firestore: ["127.0.0.1", 8080] },
```

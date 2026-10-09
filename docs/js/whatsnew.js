/**
 * whatsnew.js — 新版本第一次打開時的「新功能」介紹，以及安裝到桌面
 */

export const APP_VERSION = "2.5";
const SEEN_KEY = "englishtalk.seenVersion";

let deferredInstall = null;   // Android / 桌面 Chrome 的安裝提示
let hooks = { go: () => {} };
let dlg = null;

export function initWhatsNew(h) {
  hooks = { ...hooks, ...h };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    const b = document.getElementById("btnInstall");
    if (b) b.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    const b = document.getElementById("btnInstall");
    if (b) b.hidden = true;
  });
  const b = document.getElementById("btnInstall");
  if (b) b.addEventListener("click", install);

  build();
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

export async function install() {
  if (deferredInstall) {
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    const b = document.getElementById("btnInstall");
    if (b) b.hidden = true;
    return true;
  }
  return false;
}

function installHelp() {
  if (isStandalone()) return "你已經是用安裝版開的了 👍";
  if (isIOS()) return "iPhone／iPad：用 Safari 打開本站，點下方的「分享」→「加入主畫面」。";
  if (deferredInstall) return "";
  return "Chrome／Edge：網址列右邊的「安裝」圖示，或選單 → 「安裝 English Talk」。";
}

const FEATURES = [
  { icon: "📚", title: "同一個字的不同意思，合成一張卡", go: "vocab",
    body: "查 bank 會看到一張卡、底下列出「銀行」「河岸」，勾選要的意思一起加入；之後再加同一個字的新意思，也會併進同一張卡。單字本、翻卡背面、查字彈窗都會一行一個意思列出來。另外連線變穩了：網路不穩會自動重試，Gemini 回覆被截斷也會自動補要一次。" },
  { icon: "🔎", title: "新增單字：打中文也可以", go: "vocab",
    body: "按「＋ 新增單字」，輸入中文（例如「消耗」）會列出 consume、use up、deplete 等候選，每個都附用法差別和例句；輸入英文則列出它的各個意思（bank：銀行／河岸）。挑你要的按「＋ 加入」就好，同一個字的第二個意思會用「補上這個意思」併進去。查過的不會再花 API。" },
  { icon: "🌳", title: "單字底下顯示詞形與詞性變化", go: "vocab",
    body: "查單字時，意思底下會列出詞形（decided、deciding、decides）和同字根的其他詞性（decision n. 決定、decisive adj. 果斷的），點一下就能查那個字。單字本和翻卡背面也看得到。舊單字可以在單字本按「補齊詞性變化」一次補完，每 25 個字只花一次 API。" },
  { icon: "✏️", title: "文法修正，標在你那句話底下", go: "chat",
    body: "每句話說完，幾秒後就會在那句底下標出更好的說法：刪掉的字劃紅線、改過的字標綠色，再用一行中文說明規則。AI 照樣自然聊天、不會打斷你；可以按「🔊」聽正確說法、「🎤」跟讀一遍。標點、口語贅字和語音辨識聽錯的字都不算錯。「分析」頁會統計你最常犯哪一類錯。" },
  { icon: "🧠", title: "換成 FSRS 排程", go: "review",
    body: "複習排程改用 Anki 現行的 FSRS 演算法：依你每個字的遺忘曲線決定下次複習時間，同樣記得牢，複習次數更少。翻卡的四個按鈕現在會直接顯示「3 天後」「2 個月後」。設定裡可以調目標記憶率，也能換回舊的 SM-2。" },
  { icon: "🔀", title: "七種新的複習方式", go: "review",
    body: "除了翻卡，現在還有看英選中、看中選英、例句填空、拼字、聽寫、配對遊戲，全部不用出聲，搭捷運也能練。最推薦「混合」：新字先用選擇題認，熟了自動換成填空和拼字逼你寫出來；錯的字這輪最後會再考一次。翻卡仍是預設。" },
  { icon: "📊", title: "給你的個人分析", go: "stats",
    body: "紀錄頁多了專屬分析：哪些字認得卻從沒說出口、哪種題型最弱、哪幾個字一直忘、你最愛用哪個「萬用字」、句子有沒有越講越長、每一課的進度、未來 7 天的複習量。每條建議旁邊都有按鈕可以直接開練。還有每週一次的 AI 教練週報。" },
  { icon: "🎤", title: "用說的複習", go: "review",
    body: "方便開口的時候可以選這個：畫面給你中文，AI 用語音問你一個生活問題，你要想出英文單字並用它說一句話回答。說對自動評分，卡住會給提示。題目存在卡片上，之後再複習不花 API 額度。" },
  { icon: "👆", title: "全站每個英文字都能點", go: "chat",
    body: "不只 AI 的話 —— 你自己說的話、單字本、例句、複習卡背面、對話紀錄、跟讀視窗，連查詢視窗裡的例句都能再點。滑鼠移過去會淡淡標示；用滑鼠反白 carry out 這種片語，會跳出「查詢」按鈕。" },
  { icon: "🗣️", title: "跟讀練發音", go: "chat",
    body: "AI 的每一句話、每個例句旁都有「跟讀」。先聽、再跟著唸，逐字標出語音辨識沒聽懂的字。它會抓出 happened 唸成 happen 這種字尾被吃掉的問題 —— 台灣學生最常見的發音盲點。完全不花 API 額度。" },
  { icon: "📊", title: "對話結束的總結卡", go: "chat",
    body: "結束對話時會看到這次練了多久、開口幾個字、自己用出了哪些單字本的字、哪些字 AI 用了你還沒接（已排進明天複習），以及連續練習天數。" },
  { icon: "📲", title: "安裝到手機桌面", go: "install",
    body: "現在可以像 App 一樣裝到手機或電腦桌面，全螢幕開啟，沒網路時也能打開單字本和翻卡複習。" },
];

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "modal whatsnew";
  dlg.innerHTML = `
    <div class="m-head">
      <div class="wn-badge">v${APP_VERSION}</div>
      <h2>新功能來了</h2>
      <p class="note" style="margin:0">更多複習方式、更懂你的分析，加上全站點字查詢與跟讀。</p>
    </div>
    <div class="m-body"><div class="wn-list"></div><div class="wn-install note"></div></div>
    <div class="m-foot">
      <button class="btn primary" type="button" data-close autofocus>開始用</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());

  const list = dlg.querySelector(".wn-list");
  for (const f of FEATURES) {
    const item = document.createElement("div");
    item.className = "wn-item";
    item.innerHTML = `<div class="wn-icon">${f.icon}</div>
      <div class="wn-text"><b>${f.title}</b><p>${f.body}</p></div>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini wn-try";
    btn.textContent = f.go === "install" ? "安裝" : "試試看";
    btn.addEventListener("click", async () => {
      if (f.go === "install") {
        const ok = await install();
        if (!ok) dlg.querySelector(".wn-install").textContent = installHelp();
        return;
      }
      dlg.close();
      hooks.go(f.go);
    });
    item.querySelector(".wn-text").appendChild(btn);
    list.appendChild(item);
  }
}

export function openWhatsNew() {
  dlg.querySelector(".wn-install").textContent = "";
  if (!dlg.open) dlg.showModal();
  try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch (e) {}
}

/**
 * 老使用者第一次打開新版本才顯示；全新使用者直接走設定金鑰的流程，不打擾。
 * @param {boolean} isReturning 是否已經有資料（金鑰、單字或紀錄）
 */
export function maybeShowWhatsNew(isReturning) {
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch (e) {}
  if (seen === APP_VERSION) return false;
  if (!isReturning) {
    try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch (e) {}
    return false;
  }
  openWhatsNew();
  return true;
}

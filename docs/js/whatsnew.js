/**
 * whatsnew.js — 新版本第一次打開時的「新功能」介紹，以及安裝到桌面
 */

export const APP_VERSION = "2.12";
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
  if (isStandalone()) return "已在使用安裝版 👍";
  if (isIOS()) return "iPhone／iPad：用 Safari 開啟本站，點「分享」→「加入主畫面」。";
  if (deferredInstall) return "";
  return "Chrome／Edge：點網址列右側的「安裝」圖示，或選單 →「安裝 English Talk」。";
}

const FEATURES = [
  { icon: "📦", title: "課本單字包", go: "vocab",
    body: "單字本新增「📦 單字包」，第一包是龍騰版高中英文第一冊，含每課單字和片語，不用 API。加入的字會標上課次，可以只複習某一課。已有的字不會重複，只補標籤。" },
  { icon: "🧭", title: "新手引導", go: "onboard",
    body: "第一次使用有 5 步驟引導：選目標和程度、申請免費金鑰、測試麥克風和喇叭。貼上金鑰會自動辨識是哪一家並驗證。設定新增「練習目標」，AI 角色會跟著換。" },
  { icon: "🛟", title: "備援 AI", go: "settings",
    body: "主要 AI 額度用完、連不上或忙線時，改由下一個模型接手，例如 Groq 8B → Groq 70B → Gemini。對話中會提示，恢復後自動切回。兩家金鑰都填，一家全部停擺也能接手。" },
  { icon: "📈", title: "AI 用量", go: "stats",
    body: "「紀錄」頁新增 AI 用量：各模型今天的次數、token、失敗與備援次數，離每日免費上限多遠，以及最近 7 天趨勢。" },
  { icon: "💾", title: "儲存空間加大", go: "stats",
    body: "資料從 localStorage（上限約 5MB）改存到 IndexedDB，容量大很多。舊資料會在第一次開啟時自動搬移。「紀錄」頁最下方可以看用量。" },
  { icon: "💪", title: "複習完還能繼續練", go: "review",
    body: "到期的字複習完，可以按「繼續練習」，挑最快會忘的字再練一輪，所有題型都能用。練習會記進分析，但不改變複習排程。" },
  { icon: "🎛️", title: "模型下拉選單", go: "settings",
    body: "設定的模型改成下拉選單，會顯示速度、聰明程度、優缺點和免費額度。對話和查字、文法可以分開選，額度分開算。清單沒有的模型，可以按「載入我帳號可用的模型」或自行輸入。" },
  { icon: "⚡", title: "Groq 更穩定", go: "chat",
    body: "Groq 免費方案每分鐘額度少，請求太密集會出現「Failed to fetch」。現在會先估算額度，不夠就排隊。查字和文法改用 llama-3.3-70b，額度和對話分開。" },
  { icon: "📚", title: "一字多義合成一張卡", go: "vocab",
    body: "查 bank 會看到一張卡，列出「銀行」「河岸」，勾選要的意思加入。之後加同一個字的新意思，也會併進這張卡。另外，網路不穩會自動重試，Gemini 回覆被截斷也會重新要一次。" },
  { icon: "🔎", title: "新增單字可輸入中文", go: "vocab",
    body: "按「＋ 新增單字」輸入中文，例如「消耗」，會列出 consume、use up、deplete 等候選，附用法差別和例句。輸入英文會列出各個意思。挑好按「＋ 加入」。查過的字不再用 API。" },
  { icon: "🌳", title: "詞形與詞性變化", go: "vocab",
    body: "查單字時會列出詞形，例如 decided、deciding，以及同字根的其他詞性，例如 decision n. 決定，點了可以再查。舊單字可以在單字本「⋯ → 補齊例句與詞性變化」一次補完。" },
  { icon: "✏️", title: "文法修正", go: "chat",
    body: "每句說完幾秒後，句子下方會標出更好的說法：刪除的字畫紅線，修改的字標綠色，附一行中文說明。AI 不會打斷對話。按「🔊」聽正確說法，按「🎤」跟讀。標點、口語贅字和辨識錯誤不算錯。「分析」頁會統計你最常犯的錯誤類型。" },
  { icon: "🧠", title: "換成 FSRS 排程", go: "review",
    body: "複習排程改用 Anki 現用的 FSRS 演算法，複習次數較少。翻卡按鈕會顯示「3 天後」「2 個月後」。設定裡可以調目標記憶率，或換回 SM-2。" },
  { icon: "🔀", title: "七種新的複習方式", go: "review",
    body: "新增看英選中、看中選英、例句填空、拼字、聽寫、配對遊戲，都不用出聲。推薦「混合」：新字先考選擇題，熟了換成填空和拼字。答錯的字在這輪最後再考一次。翻卡仍是預設。" },
  { icon: "📊", title: "個人分析", go: "stats",
    body: "紀錄頁新增分析：認得卻沒說過的字、最弱的題型、常忘的字、最常用的「萬用字」、句子長度變化、各課進度、未來 7 天複習量。每條建議都有按鈕可以開始練。另有每週的 AI 教練週報。" },
  { icon: "🎤", title: "用說的複習", go: "review",
    body: "看中文，聽 AI 問一個生活問題，用那個英文字說一句話回答。說對自動評分，卡住會提示。題目會存起來，再複習不用 API。" },
  { icon: "👆", title: "英文字都能點來查", go: "chat",
    body: "AI 和你說的話、單字本、例句、複習卡背面、對話紀錄、跟讀視窗裡的英文字都能點。反白 carry out 這類片語會出現「查詢」按鈕。" },
  { icon: "🗣️", title: "跟讀練發音", go: "chat",
    body: "AI 的每句話和每個例句旁都有「跟讀」。聽完跟著唸，會逐字標出沒被辨識的字，例如把 happened 唸成 happen。不用 API。" },
  { icon: "📊", title: "對話結束的總結卡", go: "chat",
    body: "結束對話時會顯示練習時間、開口字數、用出的單字、AI 用過你還沒用的字（排進明天複習），以及連續天數。" },
  { icon: "📲", title: "安裝到手機桌面", go: "install",
    body: "可以安裝到手機或電腦桌面，全螢幕開啟。沒有網路也能看單字本、用翻卡複習。" },
];

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "modal whatsnew";
  dlg.innerHTML = `
    <div class="m-head">
      <div class="wn-badge">v${APP_VERSION}</div>
      <h2>新功能</h2>
      <p class="note" style="margin:0">新的複習方式、個人分析、點字查詢與跟讀。</p>
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

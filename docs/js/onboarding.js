/**
 * onboarding.js — 第一次使用的新手引導
 *
 * 目標：一個從沒申請過 API 金鑰的人，3 分鐘內講出第一句英文。
 *   1. 歡迎：這是什麼、要花多久
 *   2. 目標與程度：決定 AI 的角色和用字難度（白話選項，不用懂 CEFR）
 *   3. 免費金鑰：一步步帶去申請、貼上自動判斷是哪一家、當場驗證能不能用
 *   4. 麥克風與喇叭：確認聽得到、也辨識得出來（不支援的瀏覽器直接說清楚，改用打字也行）
 *   5. 完成：開始第一場對話，或先加幾個單字

 */

import * as Store from "./store.js";
import * as LLM from "./llm.js";
import * as TTS from "./tts.js";
import { listenOnce, canListen } from "./listen.js";
import { CATALOG, AUTO_TOOL, info as modelInfo } from "./models.js";

const DONE_KEY = "onboardedAt";      // 存在 settings 裡：完成（或跳過）引導的時間

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 學習目標 → AI 扮演的角色（使用者自己改過角色就不動） */
export const GOALS = {
  daily:  { icon: "☕", label: "日常聊天", hint: "生活、興趣、最近發生的事",
            persona: "Ava, a warm and curious American friend in her late twenties" },
  work:   { icon: "💼", label: "工作英文", hint: "會議、專案、跟同事閒聊",
            persona: "Ava, a friendly coworker at an international company who likes chatting about work, projects and meetings" },
  toeic:  { icon: "📝", label: "多益", hint: "辦公室、商務、日常服務情境",
            persona: "Ava, a friendly office worker who chats about everyday business situations like meetings, travel, orders and schedules" },
  ielts:  { icon: "🎓", label: "雅思／托福口說", hint: "模擬口試，一次一題，引導你多講",
            persona: "Ava, a friendly speaking-test partner who asks one IELTS-style speaking question at a time and encourages longer answers" },
  travel: { icon: "✈️", label: "旅行", hint: "點餐、問路、飯店、機場",
            persona: "Ava, a friendly local you meet while traveling, who helps with everyday situations like ordering food, asking for directions and checking in" },
};
const PRESET_PERSONAS = Object.values(GOALS).map(g => g.persona);

const LEVELS = [
  { v: "A2", label: "還不太敢開口", hint: "會簡單的句子，講長就卡住" },
  { v: "B1", label: "能聊日常", hint: "日常話題聊得下去，常找不到想講的字" },
  { v: "B2", label: "能討論想法", hint: "能講理由、說故事，想說得更精準" },
  { v: "C1", label: "接近流利", hint: "大多能表達，想練道地用法和細節" },
];

const PROVIDERS = {
  gemini: {
    name: "Google Gemini", url: "https://aistudio.google.com/apikey", prefix: "AIza",
    steps: [
      "按下方按鈕，用 Google 帳號登入 Google AI Studio。",
      "按「Create API key」，專案用預設即可。",
      "複製 <code>AIza</code> 開頭的金鑰，貼到下方。",
    ],
    pros: "額度較多，連線穩定。",
  },
  groq: {
    name: "Groq", url: "https://console.groq.com/keys", prefix: "gsk_",
    steps: [
      "按下方按鈕，用 Google 帳號或 Email 登入 GroqCloud。",
      "按「Create API Key」，名稱自訂，例如 english。",
      "複製 <code>gsk_</code> 開頭的金鑰，貼到下方。金鑰只會顯示一次。",
    ],
    pros: "回話最快，每分鐘額度較少。",
  },
};

/**
 * 新手不會選模型：從這把金鑰「實際能用」的模型裡，照推薦順序挑幾個來試。
 * @param {string[]|null} ids  帳號可用的模型清單；拿不到（null）就用整理過的推薦清單
 */
export function pickChatModels(provider, ids) {
  const fits = CATALOG[provider].filter(m => m.fit.includes("chat")).map(m => m.id);
  const others = CATALOG[provider].filter(m => !m.fit.includes("chat")).map(m => m.id);
  if (!ids) return fits.slice(0, 4);
  const have = new Set(ids);
  const out = [...fits, ...others].filter(id => have.has(id));
  // 清單外的新模型：挑名字看起來是快速聊天用的（例如新的 flash-lite、instant）
  const fast = provider === "groq" ? /instant|versatile|llama|gpt-oss|qwen/i : /flash/i;
  const extra = ids.filter(id => !out.includes(id) && fast.test(id) && !/preview|exp/i.test(id))
                   .sort((a, b) => (/lite|instant/i.test(b) ? 1 : 0) - (/lite|instant/i.test(a) ? 1 : 0));
  const rest = ids.filter(id => !out.includes(id) && !extra.includes(id));
  return [...out, ...extra, ...rest].slice(0, 4);
}

/** 從金鑰開頭判斷是哪一家 */
export function detectProvider(key) {
  const k = String(key || "").trim();
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("gsk_")) return "groq";
  return "";
}

let dlg = null;
let hooks = { onFinish: () => {}, openAdd: () => {}, openPacks: () => {}, startChat: () => {},
              cloud: false, signIn: () => {} };   // cloud：網站有設定雲端同步時，第一步可以直接登入取回資料
const W = { step: 0, goal: "daily", level: "B1", provider: "gemini", keyOk: false, keyProvider: "", micOk: null };

export function initOnboarding(h) { hooks = { ...hooks, ...h }; }

/** 需不需要跑引導：沒完成過、而且還沒有任何金鑰（老使用者不打擾） */
export function needsOnboarding() {
  const s = Store.settings();
  return !s[DONE_KEY] && !s.geminiKey && !s.groqKey;
}

/**
 * 打開引導。
 * @param {number} step  從第幾步開始（例如只想補金鑰就從 2 開始）
 */
export function openOnboarding(step = 0) {
  if (!dlg) build();
  const s = Store.settings();
  W.goal = s.goal || "daily";
  W.level = s.level || "B1";
  W.keyOk = !!(s.geminiKey || s.groqKey);
  W.keyProvider = s.provider;
  W.step = step;
  paint();
  if (!dlg.open) dlg.showModal();
}

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "modal onboard";
  dlg.id = "dlgOnboard";
  dlg.innerHTML = `
    <div class="m-head">
      <div class="ob-dots" aria-hidden="true"></div>
      <h2 class="ob-title"></h2>
      <p class="note ob-sub" style="margin:0"></p>
    </div>
    <div class="m-body ob-body"></div>
    <div class="m-foot">
      <button class="btn ghost" type="button" data-ob="back">上一步</button>
      <button class="btn ghost ob-skip" type="button" data-ob="skip">先跳過</button>
      <button class="btn primary" type="button" data-ob="next" autofocus>下一步</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-ob="back"]').addEventListener("click", () => { W.step = Math.max(0, W.step - 1); paint(); });
  dlg.querySelector('[data-ob="next"]').addEventListener("click", next);
  dlg.querySelector('[data-ob="skip"]').addEventListener("click", skip);
  // 按 Esc 關掉也算「之後再說」，不要下次一打開又跳出來
  dlg.addEventListener("cancel", () => markDone());
}

const STEPS = ["welcome", "goal", "key", "mic", "done"];

function markDone() {
  const s = Store.settings();
  if (!s[DONE_KEY]) { s[DONE_KEY] = Date.now(); Store.save(true); }
}

/** 從外面直接結束引導（例如登入雲端後已經取回金鑰） */
export function finishOnboarding() {
  markDone();
  if (dlg && dlg.open) dlg.close();
  hooks.onFinish();
}

function skip() {
  if (STEPS[W.step] === "key" || STEPS[W.step] === "mic") { W.step++; paint(); return; }
  markDone();
  dlg.close();
  hooks.onFinish();
}

function next() {
  const name = STEPS[W.step];
  if (name === "goal") saveGoal();
  if (name === "key" && !W.keyOk) {
    const note = dlg.querySelector(".ob-keynote");
    if (note) { note.textContent = "請貼上金鑰並按「檢查」，或按「先跳過」。"; note.className = "ob-keynote warn"; }
    return;
  }
  if (name === "done") { finish("chat"); return; }
  W.step = Math.min(STEPS.length - 1, W.step + 1);
  paint();
}

function finish(action) {
  markDone();
  dlg.close();
  hooks.onFinish();
  if (action === "chat") hooks.startChat();
  if (action === "add") hooks.openAdd();
  if (action === "packs") hooks.openPacks();
}

/** 目標與程度寫進設定；角色只在使用者沒自己改過時才換 */
function saveGoal() {
  const s = Store.settings();
  s.goal = W.goal;
  s.level = W.level;
  if (!s.persona || PRESET_PERSONAS.includes(s.persona)) s.persona = GOALS[W.goal].persona;
  Store.save(true);
}

function paint() {
  const name = STEPS[W.step];
  dlg.querySelector(".ob-dots").innerHTML = STEPS.map((_, i) =>
    `<i class="${i < W.step ? "done" : i === W.step ? "on" : ""}"></i>`).join("");
  const $ = (sel) => dlg.querySelector(sel);
  const body = $(".ob-body");
  $('[data-ob="back"]').hidden = W.step === 0 || name === "done";
  $(".ob-skip").hidden = !(name === "key" || name === "mic" || name === "welcome");
  $(".ob-skip").textContent = name === "welcome" ? "我自己摸索" : "先跳過";
  $('[data-ob="next"]').textContent = name === "welcome" ? "開始設定（約 3 分鐘）" : name === "done" ? "🗣️ 開始第一場對話" : "下一步";

  if (name === "welcome") {
    $(".ob-title").textContent = "嗨，這是 English Talk";
    $(".ob-sub").textContent = "用英文跟 AI 聊天，把想背的單字練到說得出口。";
    body.innerHTML = `
      <div class="ob-points">
        <div><span>🗣️</span><p><b>開口說</b>AI 說話時也能插話，像跟朋友聊天。也可以打字。</p></div>
        <div><span>📚</span><p><b>單字回到對話裡</b>AI 會用到你在背的字。你說出口，就記一次「說得出」。</p></div>
        <div><span>✏️</span><p><b>不打斷的文法提示</b>每句說完，更好的說法會標在旁邊。</p></div>
      </div>
      <p class="note">免費使用：AI 用的是 Google 或 Groq 的免費額度。金鑰和資料預設只存在你的瀏覽器。</p>
      ${hooks.cloud ? `<div class="ob-restore"><span>在別的裝置用過了？</span>
        <button type="button" class="btn sm" data-ob-restore>☁️ 用 Google 登入取回資料</button></div>` : ""}`;
    const rb = body.querySelector("[data-ob-restore]");
    if (rb) rb.addEventListener("click", () => hooks.signIn());
  }

  if (name === "goal") {
    $(".ob-title").textContent = "你想練什麼？";
    $(".ob-sub").textContent = "AI 會依此決定角色和用字難度，之後可在設定修改。";
    body.innerHTML = `
      <div class="ob-label">目標</div>
      <div class="ob-choices">${Object.entries(GOALS).map(([k, g]) => `
        <button type="button" class="ob-choice ${W.goal === k ? "on" : ""}" data-goal="${k}" aria-pressed="${W.goal === k}">
          <span class="ob-ci">${g.icon}</span><b>${esc(g.label)}</b><small>${esc(g.hint)}</small></button>`).join("")}</div>
      <div class="ob-label">你現在的程度</div>
      <div class="ob-choices lv">${LEVELS.map(l => `
        <button type="button" class="ob-choice ${W.level === l.v ? "on" : ""}" data-level="${l.v}" aria-pressed="${W.level === l.v}">
          <b>${esc(l.label)}</b><small>${esc(l.hint)}</small></button>`).join("")}</div>
      <p class="note">聊了覺得太難或太簡單，再到設定調整。</p>`;
    body.querySelectorAll("[data-goal]").forEach(b => b.addEventListener("click", () => { W.goal = b.dataset.goal; paint(); }));
    body.querySelectorAll("[data-level]").forEach(b => b.addEventListener("click", () => { W.level = b.dataset.level; paint(); }));
  }

  if (name === "key") paintKey(body);
  if (name === "mic") paintMic(body);

  if (name === "done") {
    const s = Store.settings();
    const hasKey = !!(s.geminiKey || s.groqKey);
    $(".ob-title").textContent = hasKey ? "準備好了 🎉" : "差一步就能開始";
    $(".ob-sub").textContent = hasKey ? "開始聊天，或先加入想背的單字。"
                                      : "還沒有金鑰。單字本和複習可以先用，對話和查字需要金鑰。";
    body.innerHTML = `
      <div class="ob-next">
        <button type="button" class="ob-choice" data-go="packs"><span class="ob-ci">📦</span><b>加入課本單字包</b>
          <small>整課單字一次加入，可以只複習某一課</small></button>
        <button type="button" class="ob-choice" data-go="add"><span class="ob-ci">📚</span><b>自己加幾個單字</b>
          <small>用中文或英文查，AI 會在對話中用到</small></button>
        ${hasKey ? "" : `<button type="button" class="ob-choice" data-go="key"><span class="ob-ci">🔑</span><b>回去設定金鑰</b><small>約 1 分鐘</small></button>`}
      </div>
      <div class="ob-tips">
        <b>三個小技巧</b>
        <ul>
          <li>戴耳機。喇叭外放時，AI 的聲音可能被當成你在說話。</li>
          <li>點英文字可以查詢，再加入單字本。</li>
          <li>說不出來時，說「How do you say …」或中英夾雜，AI 會幫你接。</li>
        </ul>
      </div>`;
    body.querySelector('[data-go="add"]').addEventListener("click", () => finish("add"));
    body.querySelector('[data-go="packs"]').addEventListener("click", () => finish("packs"));
    const k = body.querySelector('[data-go="key"]');
    if (k) k.addEventListener("click", () => { W.step = STEPS.indexOf("key"); paint(); });
    $('[data-ob="next"]').hidden = !hasKey;
    if (!hasKey) { $(".ob-skip").hidden = false; $(".ob-skip").textContent = "先用單字和複習"; }
  } else {
    $('[data-ob="next"]').hidden = false;
  }
  body.scrollTop = 0;
}

/* ---------- 第 3 步：金鑰 ---------- */

function paintKey(body) {
  const s = Store.settings();
  const P = PROVIDERS[W.provider];
  dlg.querySelector(".ob-title").textContent = "申請免費的 AI 金鑰";
  dlg.querySelector(".ob-sub").textContent = "AI 用的是你自己的免費額度，需要一把金鑰。申請一次就好，約 1 分鐘。";
  const have = [s.geminiKey && "Gemini", s.groqKey && "Groq"].filter(Boolean);
  body.innerHTML = `
    ${have.length ? `<div class="ob-have">✓ 已有 ${have.join("、")} 的金鑰。可以下一步，或再加一把當備援。</div>` : ""}
    <div class="ob-tabs" role="tablist">${Object.entries(PROVIDERS).map(([k, p]) => `
      <button type="button" role="tab" class="ob-tab ${W.provider === k ? "on" : ""}" data-p="${k}" aria-selected="${W.provider === k}">
        ${esc(p.name)}${k === "gemini" ? "（推薦）" : ""}</button>`).join("")}</div>
    <p class="ob-pros">${esc(P.pros)}</p>
    <ol class="ob-steps">${P.steps.map(x => `<li>${x}</li>`).join("")}</ol>
    <a class="ob-open" href="${P.url}" target="_blank" rel="noopener">開啟 ${esc(P.name)} 申請頁 ↗</a>
    <label class="field" for="obKey">貼上金鑰</label>
    <div class="row">
      <input type="password" id="obKey" class="grow" placeholder="${P.prefix}…" autocomplete="off" spellcheck="false">
      <button class="btn primary" type="button" id="obCheck">檢查</button>
    </div>
    <div class="ob-keynote" aria-live="polite"></div>
    <p class="note">金鑰只存在這個瀏覽器，本站沒有伺服器。匯出的備份也不含金鑰。</p>`;

  // 切換分頁會重畫，已經貼上的金鑰要留著
  body.querySelectorAll("[data-p]").forEach(b => b.addEventListener("click", () => {
    const v = body.querySelector("#obKey").value;
    W.provider = b.dataset.p; paint();
    dlg.querySelector("#obKey").value = v;
  }));
  const input = body.querySelector("#obKey");
  const note = body.querySelector(".ob-keynote");
  // 貼上時自動判斷是哪一家，切到對的分頁
  input.addEventListener("input", () => {
    const p = detectProvider(input.value);
    if (p && p !== W.provider) {
      W.provider = p;
      const v = input.value;
      paint();
      const again = dlg.querySelector("#obKey");
      again.value = v;
      again.focus();
      dlg.querySelector(".ob-keynote").textContent = `這是 ${PROVIDERS[p].name} 的金鑰，已幫你切換。`;
    }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); check(); } });
  body.querySelector("#obCheck").addEventListener("click", check);

  async function check() {
    const key = input.value.trim();
    if (!key) { note.textContent = "還沒貼上金鑰。"; note.className = "ob-keynote warn"; input.focus(); return; }
    const p = detectProvider(key) || W.provider;
    const s2 = Store.settings();
    const backup = { provider: s2.provider, geminiKey: s2.geminiKey, groqKey: s2.groqKey,
                     geminiModel: s2.geminiModel, groqModel: s2.groqModel,
                     geminiToolModel: s2.geminiToolModel, groqToolModel: s2.groqToolModel };
    const modelKey = p === "groq" ? "groqModel" : "geminiModel";
    const toolKey = p === "groq" ? "groqToolModel" : "geminiToolModel";
    s2.provider = p;
    if (p === "groq") s2.groqKey = key; else s2.geminiKey = key;
    note.textContent = "檢查中…"; note.className = "ob-keynote";
    const btn = body.querySelector("#obCheck");
    btn.disabled = true;
    try {
      const t0 = performance.now();
      // 1. 先問這把金鑰能用哪些模型：不需要指定模型，也順便驗證金鑰對不對
      let ids = null;
      try { ids = await LLM.listModels(p); }
      catch (e) { if (/40[013]/.test(e.message)) throw e; }   // 金鑰錯就直接報錯；其他（網路）就改用推薦清單直接試
      // 2. 照推薦順序挑幾個，一個一個試，第一個能回話的就用它
      const cands = pickChatModels(p, ids && ids.length ? ids : null);
      let used = "", lastErr = null;
      for (const m of cands) {
        s2[modelKey] = m;
        note.textContent = `檢查中…（試用 ${(modelInfo(p, m) || {}).name || m}）`;
        try {
          await LLM.complete("Reply with the single word OK.", { maxTokens: 10, kind: "chat", noFailover: true, purpose: "chat" });
          used = m;
          break;
        } catch (e) {
          lastErr = e;
          if (/40[13]/.test(e.message)) break;          // 金鑰問題，換模型也沒用
        }
      }
      if (!used) throw lastErr || new Error("找不到這把金鑰能用的模型");
      // 查字用的模型：推薦的那個帳號裡有就用「自動」，沒有就跟對話用同一個
      s2[toolKey] = !ids || ids.includes(AUTO_TOOL[p]) ? "auto" : "same";
      // 第一把金鑰決定主要供應商；已經有另一家的話，新的這把就當備援
      if (backup.geminiKey || backup.groqKey) s2.provider = backup.provider;
      Store.save(true);
      LLM.resetModelFallback();
      W.keyOk = true;
      note.innerHTML = `✅ 可以用了，已選用 <b>${esc((modelInfo(p, used) || {}).name || used)}</b>`
        + `（${Math.round(performance.now() - t0)} 毫秒，可在設定更換模型）`
        + (s2.geminiKey && s2.groqKey ? "<br>兩家金鑰都有了，一家出錯時由另一家接手。" : "");
      note.className = "ob-keynote ok";
      input.value = "";
      hooks.onFinish();      // 讓頂端的標章、歡迎畫面跟著更新
    } catch (e) {
      Object.assign(s2, backup);
      note.textContent = "❌ " + (e.message || "檢查失敗") + "（請確認金鑰完整，前後沒有空白）";
      note.className = "ob-keynote warn";
    } finally {
      btn.disabled = false;
    }
  }
}

/* ---------- 第 4 步：麥克風與喇叭 ---------- */

function paintMic(body) {
  dlg.querySelector(".ob-title").textContent = "試一下麥克風";
  dlg.querySelector(".ob-sub").textContent = "確認 AI 聽得到你、你也聽得到 AI。";
  const supported = canListen();
  body.innerHTML = `
    ${supported ? "" : `<div class="ob-warn">這個瀏覽器不支援語音辨識，請改用電腦或 Android 上的 <b>Chrome</b> 或 <b>Edge</b>。
      在這個瀏覽器仍可打字聊天。</div>`}
    <div class="ob-mic">
      <button class="btn" type="button" id="obSpeak">🔊 聽聽 AI 的聲音</button>
      ${supported ? `<button class="btn primary" type="button" id="obListen">🎤 按這裡，然後說：<i>Hello, nice to meet you</i></button>` : ""}
    </div>
    <div class="ob-heard" aria-live="polite"></div>
    <p class="note">第一次會詢問麥克風權限，請按允許。建議戴耳機。</p>`;
  body.querySelector("#obSpeak").addEventListener("click", () =>
    TTS.speak("Hi! I'm Ava. Nice to meet you. What would you like to talk about today?", undefined, null));
  const btn = body.querySelector("#obListen");
  if (!btn) return;
  const heard = body.querySelector(".ob-heard");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    heard.className = "ob-heard";
    heard.textContent = "聆聽中… 請說英文";
    const L = listenOnce({ silenceMs: 1200, maxMs: 9000, onInterim: (t) => { heard.textContent = "聽到：" + t; } });
    try {
      const text = await L.promise;
      if (text) {
        W.micOk = true;
        heard.innerHTML = `✅ 聽到了：「${esc(text)}」<br><small>辨識有誤差沒關係，AI 會理解你的意思。</small>`;
        heard.className = "ob-heard ok";
      } else {
        heard.textContent = "沒聽到聲音。請確認麥克風沒有靜音，靠近一點再試。";
        heard.className = "ob-heard warn";
      }
    } catch (e) {
      heard.textContent = e.message;
      heard.className = "ob-heard warn";
    } finally {
      btn.disabled = false;
    }
  });
}

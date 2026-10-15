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
  ielts:  { icon: "🎓", label: "雅思／托福口說", hint: "像口試一樣，一次問一題、引導你多講",
            persona: "Ava, a friendly speaking-test partner who asks one IELTS-style speaking question at a time and encourages longer answers" },
  travel: { icon: "✈️", label: "旅行", hint: "點餐、問路、飯店、機場",
            persona: "Ava, a friendly local you meet while traveling, who helps with everyday situations like ordering food, asking for directions and checking in" },
};
const PRESET_PERSONAS = Object.values(GOALS).map(g => g.persona);

const LEVELS = [
  { v: "A2", label: "還不太敢開口", hint: "會一些單字和簡單句子，講長一點就卡住" },
  { v: "B1", label: "能聊日常", hint: "日常話題聊得下去，但常找不到想講的字" },
  { v: "B2", label: "能討論想法", hint: "可以講理由、說故事，想更自然更精準" },
  { v: "C1", label: "接近流利", hint: "大多能表達，想練道地用法和細節" },
];

const PROVIDERS = {
  gemini: {
    name: "Google Gemini", url: "https://aistudio.google.com/apikey", prefix: "AIza",
    steps: [
      "按下面的按鈕，用 Google 帳號登入 Google AI Studio。",
      "按「Create API key」（建立 API 金鑰），專案選預設的就好。",
      "複製那一串 <code>AIza</code> 開頭的金鑰，回來貼在下面。",
    ],
    pros: "額度通常比較多，網頁直連最穩。",
  },
  groq: {
    name: "Groq", url: "https://console.groq.com/keys", prefix: "gsk_",
    steps: [
      "按下面的按鈕，用 Google 帳號或 Email 登入 GroqCloud。",
      "按「Create API Key」，名稱隨便取（例如 english）。",
      "複製那一串 <code>gsk_</code> 開頭的金鑰（只會顯示一次），回來貼在下面。",
    ],
    pros: "回話最快，但每分鐘額度比較少。",
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
let hooks = { onFinish: () => {}, openAdd: () => {}, openPacks: () => {}, startChat: () => {} };
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
    if (note) { note.textContent = "請先貼上金鑰並按「檢查」，或按「先跳過」之後再設定。"; note.className = "ob-keynote warn"; }
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
    $(".ob-title").textContent = "嗨！這是 English Talk";
    $(".ob-sub").textContent = "跟 AI 用英文聊天，順便把想背的單字練到說得出口。";
    body.innerHTML = `
      <div class="ob-points">
        <div><span>🗣️</span><p><b>真的用講的</b>AI 說話時你隨時可以插話，就像跟朋友聊天。打字也可以。</p></div>
        <div><span>📚</span><p><b>單字會回到對話裡</b>你在背的字，AI 會自然地用出來；你自己說出口就記一次「會用了」。</p></div>
        <div><span>✏️</span><p><b>不打斷的文法提示</b>每句話說完，更好的說法會安靜地標在旁邊。</p></div>
      </div>
      <p class="note">完全免費：用的是 Google 或 Groq 提供的免費 AI 額度，金鑰和資料都只存在你自己的瀏覽器。</p>`;
  }

  if (name === "goal") {
    $(".ob-title").textContent = "你想練什麼？";
    $(".ob-sub").textContent = "AI 會照這個決定聊天的角色和用字難度，之後在設定裡隨時可以改。";
    body.innerHTML = `
      <div class="ob-label">目標</div>
      <div class="ob-choices">${Object.entries(GOALS).map(([k, g]) => `
        <button type="button" class="ob-choice ${W.goal === k ? "on" : ""}" data-goal="${k}" aria-pressed="${W.goal === k}">
          <span class="ob-ci">${g.icon}</span><b>${esc(g.label)}</b><small>${esc(g.hint)}</small></button>`).join("")}</div>
      <div class="ob-label">你現在的程度</div>
      <div class="ob-choices lv">${LEVELS.map(l => `
        <button type="button" class="ob-choice ${W.level === l.v ? "on" : ""}" data-level="${l.v}" aria-pressed="${W.level === l.v}">
          <b>${esc(l.label)}</b><small>${esc(l.hint)}</small></button>`).join("")}</div>
      <p class="note">選不準沒關係，聊幾句覺得太難或太簡單，再到設定調整。</p>`;
    body.querySelectorAll("[data-goal]").forEach(b => b.addEventListener("click", () => { W.goal = b.dataset.goal; paint(); }));
    body.querySelectorAll("[data-level]").forEach(b => b.addEventListener("click", () => { W.level = b.dataset.level; paint(); }));
  }

  if (name === "key") paintKey(body);
  if (name === "mic") paintMic(body);

  if (name === "done") {
    const s = Store.settings();
    const hasKey = !!(s.geminiKey || s.groqKey);
    $(".ob-title").textContent = hasKey ? "準備好了 🎉" : "差一步就能開始";
    $(".ob-sub").textContent = hasKey ? "接下來可以直接開始聊，或先把想背的單字加進來。"
                                      : "還沒有金鑰：單字本和複習可以先用，對話和查字要等設定好金鑰。";
    body.innerHTML = `
      <div class="ob-next">
        <button type="button" class="ob-choice" data-go="packs"><span class="ob-ci">📦</span><b>加入課本單字包</b>
          <small>整課的課本單字一鍵加入，複習時可以只練某一課</small></button>
        <button type="button" class="ob-choice" data-go="add"><span class="ob-ci">📚</span><b>自己加幾個單字</b>
          <small>打中文或英文都能查，AI 之後會在聊天中用到它們</small></button>
        ${hasKey ? "" : `<button type="button" class="ob-choice" data-go="key"><span class="ob-ci">🔑</span><b>回去設定金鑰</b><small>大約 1 分鐘</small></button>`}
      </div>
      <div class="ob-tips">
        <b>三個小技巧</b>
        <ul>
          <li>戴耳機最好：喇叭外放時，AI 的聲音可能會被當成你在講話。</li>
          <li>網站上任何英文字都可以點來查，查過的字一鍵加入單字本。</li>
          <li>說不出來就說「How do you say …」或直接中英夾雜，AI 會幫你接。</li>
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
  dlg.querySelector(".ob-sub").textContent = "AI 是用你自己的免費額度跑的，所以需要一把「金鑰」。只要申請一次，大約 1 分鐘。";
  const have = [s.geminiKey && "Gemini", s.groqKey && "Groq"].filter(Boolean);
  body.innerHTML = `
    ${have.length ? `<div class="ob-have">✓ 已經有 ${have.join("、")} 的金鑰。可以直接下一步，或再加一把當備援。</div>` : ""}
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
    <p class="note">金鑰只存在這個瀏覽器，不會傳到我們的伺服器（我們也沒有伺服器）。匯出備份時也不會包含金鑰。</p>`;

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
      dlg.querySelector(".ob-keynote").textContent = `看起來是 ${PROVIDERS[p].name} 的金鑰，已經幫你切過來了。`;
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
      note.innerHTML = `✅ 可以用了！自動選了 <b>${esc((modelInfo(p, used) || {}).name || used)}</b>`
        + `（${Math.round(performance.now() - t0)} 毫秒；之後在設定裡可以換模型）`
        + (s2.geminiKey && s2.groqKey ? "<br>兩家都有了，一家出問題時另一家會自動接手。" : "");
      note.className = "ob-keynote ok";
      input.value = "";
      hooks.onFinish();      // 讓頂端的標章、歡迎畫面跟著更新
    } catch (e) {
      Object.assign(s2, backup);
      note.textContent = "❌ " + (e.message || "檢查失敗") + "（請確認整串都有複製到，前後沒有空白）";
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
    ${supported ? "" : `<div class="ob-warn">這個瀏覽器不支援語音辨識。請改用 <b>Chrome</b> 或 <b>Edge</b>（電腦或 Android 都可以）。
      現在這個瀏覽器還是可以用打字跟 AI 聊天。</div>`}
    <div class="ob-mic">
      <button class="btn" type="button" id="obSpeak">🔊 聽聽 AI 的聲音</button>
      ${supported ? `<button class="btn primary" type="button" id="obListen">🎤 按這裡，然後說：<i>Hello, nice to meet you</i></button>` : ""}
    </div>
    <div class="ob-heard" aria-live="polite"></div>
    <p class="note">第一次會跳出「允許使用麥克風」，請按允許。戴耳機效果最好。</p>`;
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
        heard.innerHTML = `✅ 聽到了：「${esc(text)}」<br><small>辨識得不完全一樣也沒關係，AI 會猜你的意思。</small>`;
        heard.className = "ob-heard ok";
      } else {
        heard.textContent = "沒有聽到聲音。檢查麥克風有沒有被靜音，或靠近一點再試一次。";
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

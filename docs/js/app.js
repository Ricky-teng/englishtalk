/**
 * app.js — 主程式：把對話、單字本、複習、統計四個分頁串起來
 */

import * as Store from "./store.js";
import * as LLM from "./llm.js";
import * as TTS from "./tts.js";
import * as V from "./vocab.js";
import * as Stats from "./stats.js";
import { Listener, isSupported, wordCount } from "./asr.js";
import { initLookup, closeLookup, formsHTML } from "./lookup.js";
import { initShadow, openShadow } from "./shadow.js";
import { initSpeakReview, startSpeakReview, stopSpeakReview, isActive as speakReviewActive } from "./speakreview.js";
import * as Insights from "./insights.js";
import { initQuiz, startQuiz, stopQuiz, isQuizActive, QUIZ_MODES } from "./quiz.js";
import * as Grammar from "./grammar.js";
import { initWhatsNew, maybeShowWhatsNew, openWhatsNew, APP_VERSION } from "./whatsnew.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* =========================================================================
   通用 UI
   ========================================================================= */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function applyTheme(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("englishtalk.theme", mode); } catch (e) {}
}

$("btnTheme").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : cur === "light" ? "auto" : "dark";
  applyTheme(next);
  toast(next === "auto" ? "跟隨系統" : next === "dark" ? "深色" : "淺色", 1200);
});

/* ---------- 分頁 ---------- */

function showTab(name) {
  if (name !== "review" && speakReviewActive()) stopSpeakReview();
  if (name !== "review" && isQuizActive()) { stopQuiz(); }
  closeLookup();
  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  });
  document.querySelectorAll("section.page").forEach(p => {
    p.classList.toggle("active", p.id === "page-" + name);
  });
  if (name === "vocab") renderVocab();
  if (name === "review") renderReviewHome();
  if (name === "stats") renderStats();
}

document.querySelectorAll("nav.tabs button").forEach(b => {
  b.addEventListener("click", () => showTab(b.dataset.tab));
});

function refreshPills() {
  const c = V.counts();
  const pv = $("pillVocab"), pd = $("pillDue");
  pv.textContent = c.total;
  pv.classList.toggle("zero", c.total === 0);
  pd.textContent = c.due;
  pd.classList.toggle("zero", c.due === 0);
}

function refreshBadges() {
  const s = Store.settings();
  $("badgeEngine").textContent = s.provider === "groq" ? "Groq" : "Gemini";
  const hasKey = s.provider === "groq" ? !!s.groqKey : !!s.geminiKey;
  $("badgeEngine").className = "badge" + (hasKey ? " on" : " warn");
  const usingEdge = s.ttsEngine === "edge" && !TTS.edgeIsDisabled();
  $("badgeTTS").textContent = usingEdge ? "微軟語音" : "瀏覽器語音";
  $("badgeTTS").className = "badge" + (usingEdge ? " on" : "");
}

/* =========================================================================
   對話
   ========================================================================= */

const C = {
  running: false,
  state: "idle",            // idle | listening | thinking | speaking
  history: [],              // 傳給模型的對話歷史
  listener: null,
  abort: null,
  ttsQueue: [],
  ttsBusy: false,
  stopSpeaking: false,
  aiNode: null,
  interimNode: null,
  secondsTimer: null,
  turnCount: 0,        // 這場對話進行到第幾輪
  lastVocabTurn: -99,  // 上次注入單字是第幾輪
};

const chatInner = $("chatInner");

// 文法修正底下的「聽正確說法」「跟讀」
chatInner.addEventListener("fix:hear", (e) => {
  pauseConversationAudio();
  TTS.speak(e.detail, undefined, null).then(resumeConversationAudio);
});
chatInner.addEventListener("fix:shadow", (e) => openShadow(e.detail));

function setState(st) {
  C.state = st;
  $("dot").className = st;
  $("statusText").textContent = {
    idle: "尚未開始",
    listening: "聆聽中… 請說英文",
    thinking: "思考中…",
    speaking: "AI 說話中（可直接插話）",
  }[st] || st;
}

function addMsg(kind, text) {
  const d = el("div", "msg " + kind);
  const head = el("div", "msg-head");
  head.appendChild(el("span", "who", kind === "user" ? "你" : kind === "ai" ? "AI" : "系統"));
  d.appendChild(head);
  const body = el("span", "body");
  if (kind === "ai") renderClickableWords(body, text || "");
  else body.textContent = text || "";
  d.appendChild(body);

  // AI 的每一句話都可以再聽一次、或拿來跟讀
  if (kind === "ai") {
    const acts = el("div", "msg-acts");
    const bReplay = el("button", "mini", "🔊 再聽");
    bReplay.title = "再聽一次這句";
    bReplay.addEventListener("click", () => {
      const t = body.textContent.trim();
      if (t) { pauseConversationAudio(); TTS.speak(t, undefined, null).then(resumeConversationAudio); }
    });
    const bShadow = el("button", "mini", "🎤 跟讀");
    bShadow.title = "跟著唸這句，看哪些字發音不清楚";
    bShadow.addEventListener("click", () => {
      const t = body.textContent.trim();
      if (t) openShadow(t);
    });
    acts.append(bReplay, bShadow);
    head.appendChild(acts);          // 放在「AI」那一行的右邊，不額外佔高度
  }

  chatInner.appendChild(d);
  scrollChat();
  return { root: d, body };
}

/* ---------- 暫停／恢復對話的麥克風與喇叭（跟讀、用說的複習要獨占） ---------- */

let pausedForTool = false;

function pauseConversationAudio() {
  if (C.state === "speaking" || C.ttsBusy) bargeIn();
  TTS.stop();
  if (C.running && C.listener && C.listener.running) {
    C.listener.stop();
    pausedForTool = true;
  }
}

function resumeConversationAudio() {
  if (pausedForTool && C.running && C.listener) {
    C.listener.start();
    setState("listening");
  }
  pausedForTool = false;
}

function sysMsg(t) { addMsg("sys", t); }

function scrollChat() {
  const c = $("chat");
  c.scrollTop = c.scrollHeight;
}

/** 把 AI 的回覆切成可點擊的單字，點了就查詢 */
function renderClickableWords(container, text) {
  container.textContent = "";
  const saved = new Set(Store.vocab().map(v => v.word.toLowerCase()));
  const parts = text.split(/([A-Za-z][A-Za-z'-]*)/g);
  for (const part of parts) {
    if (/^[A-Za-z]/.test(part) && part.length > 1) {
      const w = el("span", "w", part);
      w.dataset.word = part;
      if (saved.has(part.toLowerCase())) w.classList.add("saved");
      container.appendChild(w);
    } else if (part) {
      container.appendChild(document.createTextNode(part));
    }
  }
}

function showInterim(text) {
  if (!text) return clearInterim();
  if (!C.interimNode) {
    C.interimNode = addMsg("user", text);
    C.interimNode.root.classList.add("interim");
  } else {
    C.interimNode.body.textContent = text;
  }
  scrollChat();
}

function clearInterim() {
  if (C.interimNode) { C.interimNode.root.remove(); C.interimNode = null; }
}

/* ---------- 句子切割與 TTS 佇列 ---------- */

function splitSentences(buf) {
  const sentences = [];
  let rest = buf;
  const re = /[^.!?]*[.!?]+["')\]]*\s+/;
  let m;
  while ((m = rest.match(re)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    rest = rest.slice(m[0].length);
  }
  if (rest.length > 150) {
    const i = rest.lastIndexOf(", ");
    if (i > 40) { sentences.push(rest.slice(0, i + 1).trim()); rest = rest.slice(i + 2); }
  }
  return { sentences, rest };
}

function enqueueTTS(text) {
  if (!text || C.stopSpeaking) return;
  C.ttsQueue.push(text);
  if (!C.ttsBusy) runTTS();
}

async function runTTS() {
  C.ttsBusy = true;
  let prefetched = null;   // {text, promise}

  while (C.ttsQueue.length && !C.stopSpeaking) {
    const text = C.ttsQueue.shift();
    const p = (prefetched && prefetched.text === text)
      ? prefetched.promise : TTS.prefetch(text);
    prefetched = null;

    // 一邊播這句，一邊先抓下一句，接得比較順
    if (C.ttsQueue.length) {
      const nx = C.ttsQueue[0];
      prefetched = { text: nx, promise: TTS.prefetch(nx) };
    }

    let blob = null;
    try { blob = await p; } catch (e) { blob = null; }
    if (C.stopSpeaking) break;

    if (C.listener) C.listener.setSpeaking(true, text);
    setState("speaking");
    await TTS.speak(text, blob, () => setState("speaking"));
  }

  if (C.listener) C.listener.setSpeaking(false);
  C.ttsBusy = false;
  if (C.running && C.state !== "thinking") setState("listening");
  else if (!C.running) setState("idle");
}

function bargeIn() {
  if (C.state !== "speaking" && !C.ttsBusy) return;
  C.stopSpeaking = true;
  C.ttsQueue.length = 0;
  TTS.stop();
  if (C.abort) { try { C.abort.abort(); } catch (e) {} }
  if (C.listener) C.listener.setSpeaking(false);
  setState("listening");
}

/**
 * 決定這一輪要不要把單字池交給模型。
 *
 * 關鍵：頻率由這裡的機率決定，不是靠提示詞裡寫「偶爾用一下」——
 * 模型對程度副詞不敏感，但「這一輪根本沒拿到單字」是百分之百確定的。
 *
 * 另外兩個讓它不刻意的規則：
 *   1. 前兩輪不注入，先讓對話自然建立起來
 *   2. 除非設成「每一輪」，否則不會連續兩輪都注入
 */
function shouldInjectVocab() {
  const f = Number(Store.settings().vocabFrequency);
  if (!f || f <= 0) return false;
  if (!Store.vocab().length) return false;
  if (C.turnCount < 3) return false;   // 前兩輪一定不注入
  // 低頻率時強制隔一輪，高頻率時解除冷卻 —— 否則「常常」跟「適中」會被冷卻壓成一樣
  const gap = f >= 0.75 ? 1 : 2;
  if (f < 1 && C.turnCount - C.lastVocabTurn < gap) return false;
  if (f < 1 && Math.random() >= f) return false;
  C.lastVocabTurn = C.turnCount;
  return true;
}

/* ---------- 一回合 ---------- */

function removeWelcome() {
  const w = chatInner.querySelector(".welcome");
  if (w) w.remove();
}

async function sendTurn(userText) {
  removeWelcome();   // 直接打字開始聊也要收掉歡迎面板
  const node = addMsg("user", userText);
  const prevAI = [...C.history].reverse().find(m => m.role === "assistant");
  C.history.push({ role: "user", content: userText });
  if (C.history.length > 24) C.history = C.history.slice(-24);
  const rec = Stats.recordTurn("user", userText, wordCount(userText));

  // 文法檢查：排進佇列就走，不等結果、不影響 AI 回話的速度
  Grammar.check(userText, prevAI ? prevAI.content : "", node, rec);

  // 你自己把單字說出來了 —— 這才是真正的學習事件，記進產出紀錄。
  // 完全不打斷對話、不跳提示，結束時才在總結一次告訴你。
  const produced = V.markProduced(V.matchWords(userText));
  if (produced.length) Stats.recordProduced(produced.map(c => c.word));

  setState("thinking");
  C.stopSpeaking = false;
  C.aiNode = null;

  const ctrl = new AbortController();
  C.abort = ctrl;

  C.turnCount++;
  const s = Store.settings();
  const inject = shouldInjectVocab();
  const dueWords = inject ? V.wordsForChat(8) : [];
  // 只有在最高的兩檔頻率，才額外要求 AI 問「會誘使你用到那個字」的問題
  const invite = inject && Number(s.vocabFrequency) >= 0.75;

  let full = "", pending = "";
  try {
    full = await LLM.chatStream(C.history, { dueWords, invite, signal: ctrl.signal }, (delta) => {
      pending += delta;
      if (!C.aiNode) C.aiNode = addMsg("ai", "");
      renderClickableWords(C.aiNode.body, (C.aiNode._raw = (C.aiNode._raw || "") + delta));
      scrollChat();
      const cut = splitSentences(pending);
      pending = cut.rest;
      for (const sent of cut.sentences) enqueueTTS(sent);
    });
  } catch (e) {
    if (e.name !== "AbortError") { sysMsg("⚠️ " + e.message); setState(C.running ? "listening" : "idle"); }
  } finally {
    if (C.abort === ctrl) C.abort = null;
  }

  const tail = pending.trim();
  if (tail && !C.stopSpeaking) enqueueTTS(tail);

  if (full.trim()) {
    C.history.push({ role: "assistant", content: full.trim() });
    Stats.recordTurn("assistant", full.trim());
    const heard = V.matchWords(full);
    V.markHeard(heard);                          // 曝光次數，不影響排程
    Stats.recordHeard(heard.map(c => c.word));   // 這場對話 AI 用過哪些字
  }
  $("turnInfo").textContent = Math.floor(C.history.length / 2) + " 回合";

  if (!C.ttsBusy && !C.ttsQueue.length && C.state === "thinking") {
    setState(C.running ? "listening" : "idle");
  }
}

/* ---------- 開始 / 結束 ---------- */

async function startChat() {
  if (C.running) return;
  removeWelcome();
  const s = Store.settings();
  const hasKey = s.provider === "groq" ? s.groqKey : s.geminiKey;
  if (!hasKey) {
    sysMsg("請先到「設定」填入免費 API 金鑰。");
    openSettings();
    return;
  }

  if (!C.listener) {
    C.listener = new Listener({
      onInterim: showInterim,
      onCommit: (text) => { clearInterim(); sendTurn(text); },
      onBargeIn: bargeIn,
      onLevel: (rms) => { $("meterFill").style.width = Math.min(100, rms * 900) + "%"; },
      onError: (msg) => sysMsg("⚠️ " + msg),
    });
  }
  C.listener.configure({
    silenceMs: Number(s.silenceMs) || 1000,
    bargeSensitivity: Number(s.bargeSensitivity),
  });

  await TTS.loadVoices();
  await C.listener.start();

  C.running = true;
  C.stopSpeaking = false;
  if (!C.history.length) { C.turnCount = 0; C.lastVocabTurn = -99; }
  $("btnStart").disabled = true;
  $("btnStop").disabled = false;
  setState("listening");

  if (!Stats.currentSession()) Stats.beginSession();
  if (!C.secondsTimer) C.secondsTimer = setInterval(() => {
    if (C.running) Stats.tickSeconds(10);
  }, 10000);

  if (!C.history.length) await sendTurn("Hi!");
}

function stopChat() {
  C.running = false;
  bargeIn();
  C.stopSpeaking = true;
  if (C.listener) C.listener.stop();
  clearInterim();
  if (C.secondsTimer) { clearInterval(C.secondsTimer); C.secondsTimer = null; }
  const done = Stats.endSession();
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
  setState("idle");
  if (done && done.turns > 0) {
    const s2 = Store.settings();

    // 「聽得懂但講不出來」：AI 用了、你沒接的字，提前到明天複習（純本地，不呼叫 API）
    const moved = s2.promoteHeard ? V.promoteHeardNotProduced(done.heard, done.produced) : [];
    renderRecap(done, moved);

    // 「想講但講不出來」：整場對話只呼叫一次 API
    if (s2.analyzeGaps && done.turns >= 3) renderGaps(done);

    // 文法：還沒檢查完的句子補檢查（「對話結束後」模式只在這裡打 API）
    Grammar.flushAll().then(() => updateRecapGrammar(done));
  }
  refreshPills();
}

/** 對話結束的總結卡：這次練了什麼、用出了哪些字、哪些字排進明天 */
function renderRecap(done, moved) {
  const mins = Math.max(1, Math.round((done.end - done.start) / 60000));
  const streak = Stats.streak();
  const produced = done.produced || [];
  const due = V.counts().due;

  const card = el("div", "recap");
  card.innerHTML = `
    <div class="recap-head">
      <span class="recap-title">這次練習</span>
      ${streak ? `<span class="recap-streak">🔥 連續 ${streak} 天</span>` : ""}
    </div>
    <div class="recap-nums">
      <div><b>${mins}</b><span>分鐘</span></div>
      <div><b>${done.turns}</b><span>回合</span></div>
      <div><b>${done.userWords}</b><span>開口字數</span></div>
      <div><b>${produced.length}</b><span>用出的單字</span></div>
    </div>
    <div class="recap-grammar"></div>
    ${produced.length ? `<div class="recap-sec"><span class="recap-label">你自己用出來的</span>
      <div class="chips">${produced.map(w => `<span class="chip syn">${esc(w)}</span>`).join("")}</div></div>` : ""}
    ${moved.length ? `<div class="recap-sec"><span class="recap-label">AI 用了、你還沒接 → 已排進明天複習</span>
      <div class="chips">${moved.map(c => `<span class="chip ant">${esc(c.word)}${c.zh ? `<i>${esc(c.zh)}</i>` : ""}</span>`).join("")}</div></div>` : ""}
    ${!produced.length && Store.vocab().length
      ? `<p class="note" style="margin:10px 0 0">這次還沒用到單字本的字。下次試著把正在背的字用進對話裡 —— 說出口的那一刻才是真正記住的時候。</p>` : ""}
    <div class="recap-acts"></div>`;

  const acts = card.querySelector(".recap-acts");
  if (due > 0) {
    const b = el("button", "btn sm primary", reviewLabel(due));
    b.addEventListener("click", () => { showTab("review"); startReviewRound(); });
    acts.appendChild(b);
  }
  const again = el("button", "btn sm ghost", "再聊一場");
  again.addEventListener("click", () => {
    C.history = [];
    Grammar.reset();
    chatInner.innerHTML = "";
    startChat();
  });
  acts.appendChild(again);

  chatInner.appendChild(card);
  C.recapNode = card;
  updateRecapGrammar(done);
  scrollChat();
}

/** 總結卡上的文法摘要：檢查結果陸續回來時會更新 */
function updateRecapGrammar(done) {
  const box = C.recapNode && C.recapNode.querySelector(".recap-grammar");
  if (!box || Grammar.mode() === "off") return;
  const users = (done.messages || []).filter(m => m.role === "user");
  const checked = users.filter(m => m.fix);
  const bad = checked.filter(m => !m.fix.ok);
  if (!checked.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="recap-sec"><span class="recap-label">✏️ 文法</span>
    <p class="note" style="margin:4px 0 0">${bad.length
      ? `檢查了 ${checked.length} 句，其中 <b>${bad.length}</b> 句有更好的說法，已經標在那幾句底下。試著用「🎤 跟讀」把正確的說法唸一遍。`
      : `檢查了 ${checked.length} 句，都沒有文法問題 👍`}</p></div>`;
}

/** 對話頁一打開、還沒開始聊天時的歡迎面板 */
function renderWelcome() {
  if (chatInner.querySelector(".welcome")) return;
  const s = Store.settings();
  const h = new Date().getHours();
  const hello = h < 5 ? "夜深了" : h < 11 ? "早安" : h < 14 ? "午安" : h < 18 ? "下午好" : "晚上好";
  const streak = Stats.streak();
  const today = (Store.daily()[Store.todayKey()] || {});
  const c = V.counts();
  const hasKey = s.provider === "groq" ? !!s.groqKey : !!s.geminiKey;

  const box = el("div", "welcome");
  box.innerHTML = `
    <div class="wl-hello">${hello} 👋</div>
    <div class="wl-stats">
      ${streak ? `<span>🔥 連續 ${streak} 天</span>` : `<span>今天是新的開始</span>`}
      <span>${(today.seconds || 0) >= 60 ? `今天練了 ${Stats.fmtDuration(today.seconds)}` : "今天還沒開口"}</span>
      <span>單字本 ${c.total} 字 · 說得出來 ${c.spoken} 字</span>
    </div>
    <div class="wl-acts"></div>
    <div class="wl-tip">小技巧：網站上任何一個英文字都可以點來查，AI 說的每句話都能「跟讀」。</div>`;

  const acts = box.querySelector(".wl-acts");
  if (!hasKey) {
    const b = el("button", "btn primary", "先設定免費 API 金鑰");
    b.addEventListener("click", openSettings);
    acts.appendChild(b);
  } else {
    const b = el("button", "btn primary", "🗣️ 開始對話");
    b.addEventListener("click", startChat);
    acts.appendChild(b);
  }
  if (c.due > 0) {
    const b = el("button", "btn", reviewLabel(c.due));
    b.addEventListener("click", () => { showTab("review"); startReviewRound(); });
    acts.appendChild(b);
  }
  chatInner.prepend(box);
}

$("btnStart").addEventListener("click", startChat);
$("btnStop").addEventListener("click", stopChat);

$("textInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const t = e.target.value.trim();
  if (!t) return;
  e.target.value = "";
  if (C.state === "speaking") bargeIn();
  if (!C.running) {
    // 純打字模式：不開麥克風也能練
    C.running = true;
    $("btnStart").disabled = true;
    $("btnStop").disabled = false;
    if (!Stats.currentSession()) Stats.beginSession();
  }
  sendTurn(t);
});

window.addEventListener("tts:fallback", (e) => {
  refreshBadges();
  sysMsg("微軟語音服務連不上，已自動改用瀏覽器內建語音。");
});

window.addEventListener("beforeunload", () => { if (C.running) stopChat(); });

/** 對話結束後，把「你想講但講不出來」的字列出來，可一鍵加入單字本 */
async function renderGaps(session) {
  const node = addMsg("sys", "正在看看有沒有你想講但沒講出來的字…");
  let gaps = [];
  try {
    gaps = await V.findGaps(session.messages, Store.settings().level);
  } catch (e) {
    node.root.remove();
    return;                      // 失敗就安靜跳過，不要用錯誤訊息打擾練習心情
  }
  if (!gaps.length) {
    node.body.textContent = "這次表達得很順，沒有明顯卡住的地方。";
    return;
  }

  node.body.textContent = "";
  node.root.classList.add("gaps");
  node.body.appendChild(el("div", "gaps-title", "你可能想講的是這幾個字"));

  for (const g of gaps) {
    const row = el("div", "gap");
    if (g.said) row.appendChild(el("div", "gap-said", "你說：" + g.said));

    const head = el("div", "gap-head");
    head.appendChild(el("span", "gap-word", g.suggest));
    if (g.zh) head.appendChild(el("span", "gap-zh", g.zh));
    row.appendChild(head);

    if (g.better) row.appendChild(el("div", "gap-better", g.better));

    const acts = el("div", "gap-acts");
    const bSpeak = el("button", "btn sm ghost", "🔊");
    bSpeak.addEventListener("click", () => TTS.speak(g.suggest, undefined, null));
    const bAdd = el("button", "btn sm primary", "加入單字本");
    if (V.find(g.suggest)) { bAdd.textContent = "已在單字本"; bAdd.disabled = true; }
    bAdd.addEventListener("click", async () => {
      bAdd.disabled = true;
      bAdd.textContent = "查詢中…";
      try {
        const d = await V.lookup(g.suggest);     // 走快取，多半不會真的打 API
        // 一律用建議的那個字形當卡片名稱：字典可能回原形（reluctantly → reluctant），
        // 但畫面上顯示的是 suggest，加進去的就該是同一個，不然使用者會困惑。
        V.add(g.suggest, {
          ...d,
          word: g.suggest,
          zh: g.zh || d.zh,                      // 情境判斷過的中文比字典的通用解釋準
          example: d.example || g.better,
        });
      } catch (e) {
        V.add(g.suggest, { zh: g.zh, example: g.better });
      }
      bAdd.textContent = "已加入";
      refreshPills();
      toast(`已加入「${g.suggest}」`);
    });
    acts.append(bSpeak, bAdd);
    row.appendChild(acts);
    node.body.appendChild(row);
  }
  scrollChat();
}

/* =========================================================================
   單字彈窗
   ========================================================================= */

// 全站點字查詢與跟讀都在獨立模組裡（lookup.js、shadow.js），這裡只負責接線
initShadow({
  pauseAudio: pauseConversationAudio,
  resumeAudio: resumeConversationAudio,
});
initLookup({
  toast,
  onVocabChanged: (word) => { refreshPills(); markSaved(word); },
});

function markSaved(word) {
  document.querySelectorAll(".msg.ai .w").forEach(n => {
    if (n.dataset.word.toLowerCase() === word.toLowerCase()) n.classList.add("saved");
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* =========================================================================
   單字本
   ========================================================================= */

function renderVocab() {
  refreshPills();
  const miss = V.missingForms().length;
  $("btnFillForms").hidden = !miss;
  if (!$("btnFillForms").disabled) $("btnFillForms").textContent = `補齊詞性變化（${miss} 個字）`;
  const c = V.counts();
  $("vocabCounts").innerHTML = `
    <div class="tile"><div class="t-label">總單字</div><div class="t-value">${c.total}</div></div>
    <div class="tile"><div class="t-label">今天待複習</div><div class="t-value">${c.due}</div></div>
    <div class="tile"><div class="t-label">認得</div><div class="t-value">${c.mastered}</div>
      <div class="t-sub">卡片複習間隔 21 天以上</div></div>
    <div class="tile"><div class="t-label">說得出來</div><div class="t-value">${c.spoken}</div>
      <div class="t-sub">在對話中自己用過；${c.spokenOften} 個用過 3 次以上</div></div>`;

  // 標籤下拉
  const tagSel = $("vocabTag");
  const cur = tagSel.value;
  tagSel.innerHTML = '<option value="">所有標籤</option>';
  V.allTags().forEach(t => {
    const o = el("option", null, t);
    o.value = t;
    tagSel.appendChild(o);
  });
  tagSel.value = cur;

  const q = $("vocabSearch").value.trim().toLowerCase();
  const tag = tagSel.value;
  const sort = $("vocabSort").value;
  const today = Store.todayKey();

  let list = Store.vocab().filter(v => {
    if (tag && !(v.tags || []).includes(tag)) return false;
    if (!q) return true;
    return v.word.toLowerCase().includes(q) || (v.zh || "").includes(q);
  });

  if (sort === "az") list.sort((a, b) => a.word.localeCompare(b.word));
  else if (sort === "new") list.sort((a, b) => b.created - a.created);
  else if (sort === "spoken") list.sort((a, b) => (b.produced || 0) - (a.produced || 0));
  else if (sort === "unspoken") {
    list = list.filter(v => !(v.produced || 0));
    list.sort((a, b) => (a.due < b.due ? -1 : 1));
  }
  else list.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  const box = $("vocabList");
  box.innerHTML = "";
  if (!list.length) {
    box.appendChild(makeEmpty(
      Store.vocab().length ? "沒有符合條件的單字" : "單字本還是空的",
      Store.vocab().length ? "換個搜尋條件試試。"
        : "在對話中點任何一個英文字就會收進來，或按上面的「批次加入」貼上整課單字表。"));
    return;
  }

  for (const v of list) {
    const item = el("div", "vitem");
    const main = el("div", "vmain");

    const line1 = el("div");
    line1.appendChild(el("span", "vword", v.word));
    if (v.phonetic) line1.appendChild(el("span", "vipa", v.phonetic));
    main.appendChild(line1);

    if (v.zh) main.appendChild(el("div", "vzh", (v.pos ? v.pos + " · " : "") + v.zh));
    const fm = formsHTML(v, false);
    if (fm) { const box = el("div", "vforms"); box.innerHTML = fm; main.appendChild(box); }
    if (v.example) main.appendChild(el("div", "vex", v.example));

    const relLine = (label, cls, list) => {
      if (!list || !list.length) return;
      const box = el("div", "vrel");
      box.appendChild(el("small", null, label));
      list.forEach(x => {
        const c = el("span", "chip " + cls, x.w);
        if (x.zh) { const i = el("i", null, x.zh); c.appendChild(i); }
        c.style.cursor = "default";
        box.appendChild(c);
      });
      main.appendChild(box);
    };
    relLine("近義", "syn", v.synonyms);
    relLine("反義", "ant", v.antonyms);

    const meta = el("div", "vmeta");
    const dueTag = el("span", "tag" + (v.due <= today ? " due" : ""),
      v.due <= today ? "今天複習" : "下次 " + v.due);
    meta.appendChild(dueTag);
    meta.appendChild(el("span", "tag", v.reps ? `複習 ${v.reps} 次` : "尚未複習"));
    // 產出是另一條線：說得出來比認得重要，所以給它獨立的綠色標記
    if (v.produced) meta.appendChild(el("span", "tag spoken", `說出 ${v.produced} 次`));
    (v.tags || []).forEach(t => meta.appendChild(el("span", "tag", t)));
    main.appendChild(meta);

    const acts = el("div", "vacts");
    const bSpeak = el("button", "btn sm ghost", "🔊");
    bSpeak.title = "唸一次";
    bSpeak.addEventListener("click", () => TTS.speak(v.word, undefined, null));
    const bShadowEx = el("button", "btn sm ghost", "🎤");
    bShadowEx.title = "跟讀例句";
    bShadowEx.disabled = !v.example;
    bShadowEx.addEventListener("click", () => openShadow(v.example));
    const bTag = el("button", "btn sm ghost", "✎");
    bTag.title = "編輯";
    bTag.addEventListener("click", () => openWordEditor(v));
    const bDel = el("button", "btn sm ghost", "✕");
    bDel.title = "刪除";
    bDel.addEventListener("click", () => {
      if (!confirm(`刪除「${v.word}」？`)) return;
      V.remove(v.id);
      renderVocab();
    });
    acts.append(bSpeak, bShadowEx, bTag, bDel);

    item.append(main, acts);
    box.appendChild(item);
  }
}

function makeEmpty(big, small) {
  const d = el("div", "empty");
  d.appendChild(el("div", "e-big", big));
  d.appendChild(el("div", null, small));
  return d;
}

$("vocabSearch").addEventListener("input", renderVocab);
$("vocabTag").addEventListener("change", renderVocab);
$("vocabSort").addEventListener("change", renderVocab);

$("btnVocabExport").addEventListener("click", () => {
  if (!Store.vocab().length) return toast("單字本是空的");
  download(V.toCSV(), "englishtalk-vocab-" + Store.todayKey() + ".csv", "text/csv;charset=utf-8");
});

/* ---------- 手動新增／編輯單一單字 ---------- */

const dlgWord = $("dlgWord");
let editingId = null;

/** [{w,zh}] → "settle(和解), resolve(解決)" 這種好編輯的一行文字 */
function relToText(list) {
  return (list || []).map(x => x.w + (x.zh ? `(${x.zh})` : "")).join(", ");
}

/** 反向：把一行文字解析回 [{w,zh}]，中文可用括號或不寫 */
function textToRel(text) {
  const out = [];
  for (const piece of String(text || "").split(/[,、;；]/)) {
    const t = piece.trim();
    if (!t) continue;
    const m = t.match(/^([A-Za-z][A-Za-z'’\- ]*?)\s*[（(]\s*([^）)]*)\s*[）)]\s*$/);
    if (m) out.push({ w: m[1].trim(), zh: m[2].trim() });
    else if (/^[A-Za-z]/.test(t)) out.push({ w: t, zh: "" });
    if (out.length >= 5) break;
  }
  return out;
}

let editingForms = null;   // 詞形（過去式等）不給手動編，查到的就跟著存

const allTags = () => [...new Set(Store.vocab().flatMap(v => v.tags || []))].sort();
function fillTagOptions() {
  $("tagOptions").innerHTML = allTags().map(t => `<option value="${esc(t)}">`).join("");
}

/**
 * 打開單字編輯器。
 * @param {Object|null} card     要編輯的卡；null 表示新增
 * @param {Object} prefill       新增時預先填好的內容（從候選清單按「編輯後加入」）
 */
function openWordEditor(card, prefill = null) {
  const d = card || prefill || {};
  editingId = card ? card.id : null;
  $("wordDlgTitle").textContent = card ? "編輯單字" : "新增單字";
  $("wfWord").value       = d.word || "";
  $("wfPhonetic").value   = d.phonetic || "";
  $("wfPos").value        = d.pos || "";
  $("wfZh").value         = d.zh || "";
  $("wfExample").value    = d.example || "";
  $("wfExampleZh").value  = d.exampleZh || "";
  $("wfSyn").value        = relToText(d.synonyms);
  $("wfAnt").value        = relToText(d.antonyms);
  $("wfFam").value        = V.familyToText(d.family);
  editingForms = Array.isArray(d.forms) ? d.forms : null;
  $("wfTags").value       = card ? (card.tags || []).join(" ")
                          : ((prefill && prefill.tags) || [$("vocabTag").value]).filter(Boolean).join(" ");
  // 有填進階欄位就展開，空的就收起來，畫面不會一打開就一長串
  $("wfMore").open = !!(d.example || (d.synonyms || []).length || (d.antonyms || []).length || (d.family || []).length);
  $("wfPick").innerHTML = "";
  $("wordDlgNote").textContent = "";
  fillTagOptions();
  dlgWord.showModal();
  setTimeout(() => $(d.word ? "wfZh" : "wfWord").focus(), 50);
}

/* ---------- 候選清單（新增單字的查詢結果、編輯器的 AI 補齊共用） ---------- */

/** 這個候選跟單字本的關係：new 還沒有、same 已經有這個意思、sense 有這個字但不是這個意思 */
function candState(r) {
  const ex = V.find(r.word);
  if (!ex) return { st: "new" };
  // 括號裡的補充說明不算：「耗盡（資源）」跟「耗盡」是同一個意思
  const norm = (t) => String(t || "").replace(/[（(][^)）]*[)）]/g, "").replace(/[\s、，,；;／/]+/g, "|");
  const have = new Set(norm(ex.zh).split("|").filter(Boolean));
  const overlap = norm(r.zh).split("|").some(z => z && have.has(z)) || !ex.zh;
  return { st: overlap ? "same" : "sense", card: ex };
}

/**
 * @param {HTMLElement} box
 * @param {Array} results
 * @param {"add"|"pick"} mode  add：直接加入單字本；pick：填進編輯器
 * @param {Function} onPick    pick 模式選了哪一個
 */
function renderCands(box, results, mode, onPick) {
  box.innerHTML = "";
  results.forEach((r) => {
    const c = el("div", "cand");
    c.innerHTML = `
      <div class="cand-head"><b class="cand-word">${esc(r.word)}</b>
        ${r.phonetic ? `<span class="cand-ipa">${esc(r.phonetic)}</span>` : ""}
        ${r.pos ? `<span class="cand-pos">${esc(V.posShort(r.pos))}</span>` : ""}
        <button class="mini cand-say" title="唸這個字" aria-label="唸 ${esc(r.word)}">🔊</button></div>
      <div class="cand-zh">${esc(r.zh)}</div>
      ${r.note ? `<div class="cand-note">${esc(r.note)}</div>` : ""}
      ${r.example ? `<div class="cand-ex">${esc(r.example)}${r.exampleZh ? `<br><span class="muted">${esc(r.exampleZh)}</span>` : ""}</div>` : ""}
      ${mode === "add" ? formsHTML(r, false) : ""}
      <div class="cand-acts"></div>`;
    c.querySelector(".cand-say").addEventListener("click", () => TTS.speak(r.word, undefined, null));
    const acts = c.querySelector(".cand-acts");

    if (mode === "pick") {
      const b = el("button", "btn sm primary", "用這個");
      b.addEventListener("click", () => {
        box.querySelectorAll(".cand").forEach(x => x.classList.toggle("chosen", x === c));
        onPick(r);
      });
      acts.appendChild(b);
    } else {
      const paint = () => {
        acts.innerHTML = "";
        const s = candState(r);
        const tag = $("addTag").value.trim();
        const tags = tag ? [tag] : [];
        if (s.st === "same") {
          acts.appendChild(el("span", "cand-done", "✓ 已在單字本"));
          if (tag && !(s.card.tags || []).includes(tag)) {
            const b = el("button", "btn sm ghost", `也加上「${tag}」標籤`);
            b.addEventListener("click", () => { V.add(r.word, { tags }); paint(); renderVocab(); });
            acts.appendChild(b);
          }
          return;
        }
        const main = el("button", "btn sm primary", s.st === "new" ? "＋ 加入" : "補上這個意思");
        if (s.st === "sense") main.title = `單字本已經有「${s.card.zh}」，會把「${r.zh}」加在後面`;
        main.addEventListener("click", () => {
          if (s.st === "new") {
            const { note, ...data } = r;
            V.add(r.word, { ...data, tags });
            toast(`已加入「${r.word}」`);
          } else {
            V.update(s.card.id, { zh: `${s.card.zh}；${r.zh}`,
                                  tags: [...new Set([...(s.card.tags || []), ...tags])] });
            toast(`「${r.word}」多了一個意思：${r.zh}`);
          }
          refreshPills();
          renderVocab();
          // 同一個字的其他意思，按鈕要從「加入」變成「補上這個意思」
          box.querySelectorAll(".cand").forEach(x => x._paint && x._paint());
        });
        acts.appendChild(main);
        if (s.st === "new") {
          const ed = el("button", "btn sm ghost", "改一下再加入");
          ed.addEventListener("click", () => {
            const { note, ...data } = r;
            openWordEditor(null, { ...data, tags });
          });
          acts.appendChild(ed);
        }
      };
      c._paint = paint;
      paint();
    }
    box.appendChild(c);
  });
}

/* ---------- 新增單字：輸入英文或中文 → 列出候選 → 一鍵加入 ---------- */

const dlgAdd = $("dlgAdd");
let addSeq = 0;

function openAddDialog() {
  $("addQuery").value = "";
  $("addTag").value = $("vocabTag").value || "";
  $("addResults").innerHTML = "";
  fillTagOptions();
  dlgAdd.showModal();
  setTimeout(() => $("addQuery").focus(), 50);
}

async function runAddSearch(force = false) {
  const q = $("addQuery").value.trim();
  const box = $("addResults");
  if (!q) { $("addQuery").focus(); return; }
  const seq = ++addSeq;
  box.innerHTML = `<p class="muted note">查詢中…</p>`;
  $("btnAddSearch").disabled = true;
  try {
    const { results, cached, zh } = await V.search(q, { force, level: Store.settings().level });
    if (seq !== addSeq) return;
    if (!results.length) {
      box.innerHTML = `<p class="note">找不到「${esc(q)}」。換個說法，或用下面的「手動填寫」。</p>`;
      return;
    }
    box.innerHTML = "";
    const head = el("div", "add-head");
    head.innerHTML = `<span>${zh ? `「${esc(q)}」可以說成 ${results.length} 種：` : results.length > 1 ? `「${esc(results[0].word)}」有 ${results.length} 個意思，選你要的：` : "查到了："}</span>
      ${cached ? `<span class="muted">（查過的，沒有花 API）</span>` : ""}`;
    if (cached) {
      const again = el("button", "mini", "↻ 重查");
      again.addEventListener("click", () => runAddSearch(true));
      head.appendChild(again);
    }
    box.appendChild(head);
    const list = el("div", "cand-list");
    box.appendChild(list);
    renderCands(list, results, "add");
  } catch (e) {
    if (seq !== addSeq) return;
    box.innerHTML = `<p class="note">查詢失敗：${esc(e.message)}<br>可以先用下面的「手動填寫」加入，之後再補。</p>`;
  } finally {
    if (seq === addSeq) $("btnAddSearch").disabled = false;
  }
}

$("btnAddOne").addEventListener("click", openAddDialog);
$("btnAddSearch").addEventListener("click", () => runAddSearch());
$("addQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); runAddSearch(); }
});
// 改了標籤，候選卡上的按鈕（例如「也加上標籤」）要跟著更新
$("addTag").addEventListener("input", () => $("addResults").querySelectorAll(".cand").forEach(c => c._paint && c._paint()));
$("btnAddDone").addEventListener("click", () => dlgAdd.close());
$("btnAddManual").addEventListener("click", () => {
  const q = $("addQuery").value.trim();
  const zh = /[㐀-鿿]/.test(q);
  openWordEditor(null, { word: zh ? "" : q, zh: zh ? q : "",
                         tags: $("addTag").value.trim() ? [$("addTag").value.trim()] : [] });
});
// 編輯器存檔（從候選「改一下再加入」）之後，候選卡的狀態要更新
dlgWord.addEventListener("close", () => {
  if (dlgAdd.open) $("addResults").querySelectorAll(".cand").forEach(c => c._paint && c._paint());
});

// 舊單字一次補齊詞性變化：每 25 個字一個請求
$("btnFillForms").addEventListener("click", async () => {
  const btn = $("btnFillForms");
  const todo = V.missingForms();
  if (!todo.length) { toast("每個字都已經有詞性變化了"); return; }
  btn.disabled = true;
  let done = 0;
  try {
    for (let i = 0; i < todo.length; i += 25) {
      btn.textContent = `補查中 ${Math.min(i + 25, todo.length)}/${todo.length}…`;
      done += await V.fetchForms(todo.slice(i, i + 25));
    }
    toast(`已補上 ${done} 個字的詞性變化`);
  } catch (e) {
    toast("補查失敗：" + e.message);
  } finally {
    btn.disabled = false;
    renderVocab();
  }
});
$("btnCloseWord").addEventListener("click", () => dlgWord.close());

/** 把選中的候選填進編輯器：只補空白欄位，你自己打的不動 */
function applyCand(r) {
  const fill = (id, val) => { if (!$(id).value.trim() && val) $(id).value = val; };
  fill("wfWord", r.word);
  fill("wfZh", r.zh);
  fill("wfPhonetic", r.phonetic);
  fill("wfPos", r.pos);
  fill("wfExample", r.example);
  fill("wfExampleZh", r.exampleZh);
  fill("wfSyn", relToText(r.synonyms));
  fill("wfAnt", relToText(r.antonyms));
  fill("wfFam", V.familyToText(r.family));
  if (Array.isArray(r.forms)) editingForms = r.forms;
  $("wordDlgNote").textContent = "已補上空白欄位，你原本填的內容沒有被改動。例句、近義詞在「更多欄位」裡。";
}

$("btnAutoFill").addEventListener("click", async () => {
  const word = $("wfWord").value.trim();
  const zh = $("wfZh").value.trim();
  const note = $("wordDlgNote");
  const pick = $("wfPick");
  if (!word && !zh) { note.textContent = "英文或中文先填一個。"; $("wfWord").focus(); return; }
  const btn = $("btnAutoFill");
  btn.disabled = true;
  pick.innerHTML = "";
  note.textContent = "查詢中…";
  try {
    const { results } = await V.search(word || zh, { level: Store.settings().level });
    // 填了英文：只留這個字的各個意思；填了中文：全部候選都給你挑
    let list = word ? results.filter(r => r.word.toLowerCase() === word.toLowerCase()) : results;
    if (!list.length) list = results;
    if (!list.length) { note.textContent = "查不到，請直接自己填。"; return; }
    if (list.length === 1) { applyCand(list[0]); return; }
    note.textContent = "";
    renderCands(pick, list, "pick", (r) => { applyCand(r); });
    // 說明放在候選清單正上方，不要放在最底下看不到
    pick.prepend(el("div", "add-head", word ? `「${word}」有 ${list.length} 個意思，選你要的那個：`
                                            : `「${zh}」可以說成 ${list.length} 種，選你要的那個：`));
  } catch (e) {
    note.textContent = "查詢失敗：" + e.message + "（可以直接自己填）";
  } finally {
    btn.disabled = false;
  }
});

$("btnSaveWord").addEventListener("click", () => {
  const word = $("wfWord").value.trim();
  if (!word) {
    $("wordDlgNote").textContent = $("wfZh").value.trim()
      ? "還沒有英文 —— 按「✨ 用 AI 補齊」從中文找英文，或自己填。" : "英文單字不能空白。";
    $("wfWord").focus();
    return;
  }
  const data = {
    word,
    phonetic:  $("wfPhonetic").value.trim(),
    pos:       $("wfPos").value.trim(),
    zh:        $("wfZh").value.trim(),
    example:   $("wfExample").value.trim(),
    exampleZh: $("wfExampleZh").value.trim(),
    synonyms:  textToRel($("wfSyn").value),
    antonyms:  textToRel($("wfAnt").value),
    family:    V.textToFamily($("wfFam").value),
    ...(editingForms ? { forms: editingForms } : {}),
    tags:      $("wfTags").value.split(/\s+/).filter(Boolean),
  };
  if (editingId) {
    V.update(editingId, data);
    toast(`已更新「${word}」`);
  } else {
    const dup = V.find(word);
    if (dup) {
      V.update(dup.id, data);
      toast(`「${word}」已存在，已更新內容`);
    } else {
      V.add(word, data);
      toast(`已加入「${word}」`);
    }
  }
  dlgWord.close();
  refreshPills();
  renderVocab();
});

// Enter：還沒有英文就先幫你查，有英文就直接存檔（方便連續輸入）
dlgWord.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT") {
    e.preventDefault();
    if (!$("wfWord").value.trim() && $("wfZh").value.trim()) $("btnAutoFill").click();
    else $("btnSaveWord").click();
  }
});

/* ---------- 批次貼上 ---------- */

$("btnBulkAdd").addEventListener("click", () => {
  $("bulkTag").value = $("vocabTag").value || "";
  $("bulkNote").textContent = "";
  $("dlgBulk").showModal();
});
$("btnCloseBulk").addEventListener("click", () => $("dlgBulk").close());

$("btnDoBulk").addEventListener("click", async () => {
  const rows = V.parseWordLines($("bulkText").value);
  const tag = $("bulkTag").value.trim();
  const useAI = $("bulkUseAI").checked;
  const note = $("bulkNote");
  const btn = $("btnDoBulk");

  if (!rows.length) { note.textContent = "沒有認出任何英文單字。"; return; }

  // 不用 AI：完全照貼上的內容存，不動任何欄位，也不花 API 額度
  if (!useAI) {
    let added = 0;
    for (const r of rows) {
      const res = V.add(r.word, { word: r.word, zh: r.zh, tags: tag ? [tag] : [] });
      if (res.isNew) added++;
    }
    note.textContent = `完成：新增 ${added} 個，${rows.length - added} 個已存在。`;
    toast(`已加入 ${added} 個單字`);
    $("bulkText").value = "";
    refreshPills();
    renderVocab();
    return;
  }

  if (rows.length > 20) {
    note.textContent = `一次最多 20 個（現在有 ${rows.length} 個）。請分批，或取消勾選 AI 補齊。`;
    return;
  }

  btn.disabled = true;
  note.textContent = `認出 ${rows.length} 個單字，查詢中…`;
  try {
    // 已經查過的字直接從快取拿，只有真的沒查過的才送出去
    const { byWord, asked } = await V.lookupBatchCached(rows.map(r => r.word));
    let added = 0;
    rows.forEach((r) => {
      const d = byWord[r.word.toLowerCase()] || {};
      const merged = {
        word: r.word,
        phonetic: d.phonetic || "",
        pos: d.pos || "",
        zh: r.zh || d.zh || "",          // 你自己打的中文永遠優先
        example: d.example || "",
        exampleZh: d.exampleZh || "",
        synonyms: d.synonyms || [],
        antonyms: d.antonyms || [],
        ...(Array.isArray(d.family) ? { forms: d.forms || [], family: d.family } : {}),
        tags: tag ? [tag] : [],
      };
      const res = V.add(r.word, merged);
      if (res.isNew) added++;
    });
    const cached = rows.length - asked;
    note.textContent = `完成：新增 ${added} 個，${rows.length - added} 個已存在。`
                     + (cached > 0 ? `（其中 ${cached} 個直接用快取，沒有呼叫 API）` : "");
    toast(`已加入 ${added} 個單字`);
    $("bulkText").value = "";
    refreshPills();
    renderVocab();
  } catch (e) {
    note.textContent = "AI 查詢失敗：" + e.message + "　可以取消勾選「用 AI 補齊」直接存。";
  } finally {
    btn.disabled = false;
  }
});

/* =========================================================================
   複習
   ========================================================================= */

const R = { queue: [], idx: 0, revealed: false, tag: "", done: 0 };

function renderReviewHome() {
  $("page-review").classList.remove("reviewing");
  R.flipActive = false;
  paintReviewMode();
  const sel = $("reviewTag");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部單字</option>';
  V.allTags().forEach(t => {
    const c = V.counts(t);
    const o = el("option", null, `${t}（待複習 ${c.due} / 共 ${c.total}）`);
    o.value = t;
    sel.appendChild(o);
  });
  sel.value = cur;

  const c = V.counts(cur);
  const stage = $("reviewStage");
  stage.innerHTML = "";
  if (!Store.vocab().length) {
    stage.appendChild(makeEmpty("還沒有單字可以複習",
      "先在對話中點幾個單字，或到「單字本」批次加入整課單字表。"));
    return;
  }
  if (!c.due) {
    stage.appendChild(makeEmpty("今天的複習做完了 🎉",
      `這組共 ${c.total} 個單字，已掌握 ${c.mastered} 個。明天再來，或先去對話練幾句。`));
    return;
  }
  stage.appendChild(makeEmpty(`有 ${c.due} 個單字等著複習`, "按上面的「開始複習」。"));
}

$("reviewTag").addEventListener("change", renderReviewHome);

/* ---------- 複習方式：用說的／翻卡 ---------- */

/* 所有複習方式。翻卡是預設；「用說的」要能語音辨識；其餘都是不用出聲的題型（quiz.js） */
const REVIEW_MODES = {
  flip:  { icon: "🃏", name: "翻卡", tip: "看英文想中文，翻面後自己評分。最快刷過一輪，也能離線用。" },
  ...QUIZ_MODES,
  speak: { icon: "🎤", name: "用說的", tip: "畫面給你中文，AI 用語音問一個問題，你要想出英文單字並用它說一句話回答。需要開口。" },
};
const MODE_ORDER = ["flip", "mixed", "mcEn", "mcZh", "cloze", "spell", "listen", "speak", "match"];

function reviewMode() {
  const m = Store.settings().reviewMode;
  if (!REVIEW_MODES[m]) return "flip";
  if (m === "speak" && !isSupported()) return "flip";
  return m;
}

/** 各處「去複習」按鈕的文字跟著目前的複習方式走 */
function reviewLabel(n) {
  const m = REVIEW_MODES[reviewMode()];
  return `${m.icon} 複習 ${n} 個字`;
}

function paintReviewMode() {
  const mode = reviewMode();
  const grid = $("reviewMode");
  grid.innerHTML = "";
  for (const key of MODE_ORDER) {
    const m = REVIEW_MODES[key];
    const b = el("button", "mode-btn");
    b.type = "button";
    b.dataset.mode = key;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(key === mode));
    b.innerHTML = `<span class="mi">${m.icon}</span><span class="mn">${m.name}</span>`;
    if (key === "speak" && !isSupported()) {
      b.disabled = true;
      b.title = "這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge";
    }
    b.addEventListener("click", () => {
      if (speakReviewActive() || isQuizActive()) return;
      Store.settings().reviewMode = key;
      Store.settings().reviewModeChosen = true;   // 記住是自己選的，之後不會被預設值蓋掉
      Store.save();
      paintReviewMode();
    });
    grid.appendChild(b);
  }
  $("reviewModeNote").textContent = REVIEW_MODES[mode].tip;
}


initSpeakReview({
  stage: $("reviewStage"),
  pauseAudio: pauseConversationAudio,
  resumeAudio: resumeConversationAudio,
  toast,
  onDone: (what) => {
    refreshPills();
    if (what === "again") startReviewRound();
    if (what === "home") renderReviewHome();
  },
});

initQuiz({
  stage: $("reviewStage"),
  toast,
  onGraded: refreshPills,
  onDone: (what) => {
    refreshPills();
    if (what === "again") startReviewRound();
    if (what === "home") renderReviewHome();
  },
});

/**
 * 開始一輪複習。
 * @param {Array} override 指定要練的卡（例如分析頁的「專攻最難的字」），不給就用到期的字
 * @param {string} forceMode 指定題型（不改變使用者的預設選擇）
 */
function startReviewRound(override, forceMode) {
  const mode = forceMode || reviewMode();
  R.tag = $("reviewTag").value;
  R.flipActive = false;
  if (Array.isArray(override) && override.length) {
    R.queue = override.slice();
  } else if (mode === "match") {
    // 配對是暖身遊戲：不限到期，從整個範圍隨機抽
    R.queue = Store.vocab().filter(v => !R.tag || (v.tags || []).includes(R.tag));
  } else {
    R.queue = V.due(R.tag);
  }
  R.idx = 0;
  R.done = 0;
  R.revealed = false;
  if (!R.queue.length) { toast("目前沒有到期的單字"); renderReviewHome(); return; }
  $("page-review").classList.add("reviewing");   // 複習進行中收起上方控制列，手機上卡片才看得到
  if (mode === "speak") { startSpeakReview(R.queue); return; }
  if (mode !== "flip") { startQuiz(mode, R.queue); return; }
  R.flipActive = true;
  paintCard();
}

$("btnStartReview").addEventListener("click", () => startReviewRound());

function paintCard() {
  const stage = $("reviewStage");
  stage.innerHTML = "";

  if (R.idx >= R.queue.length) {
    // 把這輪答錯（interval 被歸零）的重新排進來，今天再看一次
    const again = R.queue.filter(c => c.interval === 0 && c.lastReview);
    if (again.length && R.done < 200) {
      R.queue = again;
      R.idx = 0;
    } else {
      stage.appendChild(makeEmpty("這輪複習完成 🎉", `總共複習了 ${R.done} 次。`));
      refreshPills();
      renderReviewHome();
      return;
    }
  }

  const card = R.queue[R.idx];
  if (!R.revealed) R.shownAt = Date.now();   // 從看到題目開始計時
  const prog = el("div", "review-progress");
  prog.appendChild(el("span", null, `第 ${R.idx + 1} / ${R.queue.length} 張`));
  prog.appendChild(el("span", null, `本輪已複習 ${R.done}`));
  stage.appendChild(prog);

  // 正面還沒翻牌時不能點字查詢，不然等於直接看答案
  const fc = el("div", "flashcard" + (R.revealed ? "" : " no-lookup"));
  fc.appendChild(el("div", "fc-word", card.word));
  if (card.phonetic) fc.appendChild(el("div", "fc-ipa", card.phonetic));

  if (R.revealed) {
    if (card.zh) fc.appendChild(el("div", "fc-zh", (card.pos ? card.pos + " · " : "") + card.zh));
    if (card.example) {
      fc.appendChild(el("div", "fc-ex", card.example));
      if (card.exampleZh) fc.appendChild(el("div", "fc-exzh", card.exampleZh));
    }
    if (!card.zh) fc.appendChild(el("div", "fc-zh muted", "（這張卡還沒有中文意思）"));

    // 背面才顯示近義／反義 —— 正面看到就變成提示，失去回想的效果
    const relBox = el("div", "fc-rel");
    const addRel = (label, cls, list) => {
      if (!list || !list.length) return;
      const row = el("div", "wp-rel");
      row.appendChild(el("span", "wp-rel-label", label));
      const chips = el("div", "chips");
      list.forEach(x => {
        const c = el("span", "chip " + cls, x.w);
        if (x.zh) c.appendChild(el("i", null, x.zh));
        c.style.cursor = "default";
        chips.appendChild(c);
      });
      row.appendChild(chips);
      relBox.appendChild(row);
    };
    addRel("近義", "syn", card.synonyms);
    addRel("反義", "ant", card.antonyms);
    const fm = formsHTML(card, false);
    if (fm) { const box = el("div", "fc-forms"); box.innerHTML = fm; fc.appendChild(box); }
    if (relBox.children.length) fc.appendChild(relBox);
  } else {
    fc.appendChild(el("div", "muted", "想想看意思，再按下面顯示答案"));
  }
  stage.appendChild(fc);

  const bar = el("div", "row");
  bar.style.justifyContent = "center";
  bar.style.marginTop = "14px";
  const bSpeak = el("button", "btn ghost", "🔊 唸一次");
  bSpeak.addEventListener("click", () => TTS.speak(card.word, undefined, null));
  bar.appendChild(bSpeak);
  if (R.revealed && card.example) {
    const bSh = el("button", "btn ghost", "🎤 跟讀例句");
    bSh.addEventListener("click", () => openShadow(card.example));
    bar.appendChild(bSh);
  }
  stage.appendChild(bar);

  if (!R.revealed) {
    const show = el("button", "btn primary", "顯示答案");
    show.style.marginTop = "14px";
    show.style.width = "100%";
    show.addEventListener("click", () => { R.revealed = true; paintCard(); });
    stage.appendChild(show);
  } else {
    const grades = el("div", "grade-row");
    const ivl = V.previewIntervals(card);
    const when = (d) => d === 0 ? "今天再來" : d === 1 ? "明天" : d < 60 ? `${d} 天後`
      : d < 365 ? `${Math.round(d / 30)} 個月後` : `${(d / 365).toFixed(1)} 年後`;
    [
      { q: 0, label: "忘記" },
      { q: 3, label: "困難" },
      { q: 4, label: "普通" },
      { q: 5, label: "簡單" },
    ].map(g => ({ ...g, hint: when(ivl[g.q]) })).forEach(g => {
      const b = el("button");
      b.innerHTML = `<b>${g.label}</b><small>${g.hint}</small>`;
      b.addEventListener("click", () => {
        V.grade(card.id, g.q, { mode: "flip", ms: Date.now() - (R.shownAt || Date.now()) });
        R.done++;
        R.idx++;
        R.revealed = false;
        paintCard();
        refreshPills();
      });
      grades.appendChild(b);
    });
    stage.appendChild(grades);
  }
}

// 空白鍵翻牌、1-4 評分
document.addEventListener("keydown", (e) => {
  // 只有翻卡模式要處理空白鍵與 1–4；其他題型各自處理自己的按鍵
  const reviewing = $("page-review").classList.contains("active") && R.flipActive && R.queue.length;
  if (!reviewing) return;
  if (e.target.matches("input, textarea, select")) return;
  if (document.querySelector("dialog[open]")) return;   // 跟讀視窗開著時不要誤觸評分
  if (e.code === "Space") { e.preventDefault(); if (!R.revealed) { R.revealed = true; paintCard(); } }
  if (R.revealed && /^[1-4]$/.test(e.key)) {
    const btns = document.querySelectorAll(".grade-row button");
    const b = btns[Number(e.key) - 1];
    if (b) b.click();
  }
});

/* =========================================================================
   紀錄
   ========================================================================= */

function renderStats() {
  const t = Stats.totals();
  const w = Stats.thisWeek();
  const s = Stats.streak();
  const c = V.counts();

  $("statTiles").innerHTML = `
    <div class="tile"><div class="t-label">連續練習</div><div class="t-value">${s}<span style="font-size:15px"> 天</span></div>
      <div class="t-sub">今天練了就會 +1</div></div>
    <div class="tile"><div class="t-label">本週練習</div><div class="t-value">${Stats.fmtDuration(w.seconds)}</div>
      <div class="t-sub">開口 ${w.userWords} 個字</div></div>
    <div class="tile"><div class="t-label">累計練習</div><div class="t-value">${Stats.fmtDuration(t.seconds)}</div>
      <div class="t-sub">${t.days} 天、${t.sessions} 場對話</div></div>
    <div class="tile"><div class="t-label">說得出來的單字</div><div class="t-value">${c.spoken}<span style="font-size:15px"> / ${c.total}</span></div>
      <div class="t-sub">本週在對話中用出 ${w.produced} 次</div></div>`;

  renderInsights();

  const hm = $("heatmap");
  hm.innerHTML = "";
  hm.appendChild(Stats.renderHeatmap(26));

  const dt = $("dailyTable");
  dt.innerHTML = "";
  dt.appendChild(Stats.renderHeatmapTable(30));

  const box = $("sessionList");
  box.innerHTML = "";
  const list = Store.sessions().slice().reverse().slice(0, 30);
  if (!list.length) {
    box.appendChild(makeEmpty("還沒有對話紀錄", "到「對話」聊幾句，結束後就會存在這裡。"));
    return;
  }
  for (const sess of list) {
    const d = el("details", "session-item");
    const sum = el("summary");
    const dt2 = new Date(sess.start);
    sum.appendChild(el("span", "s-date", dt2.toLocaleString("zh-TW", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    })));
    sum.appendChild(el("span", "tag", sess.turns + " 回合"));
    sum.appendChild(el("span", "tag", sess.userWords + " 字"));
    const mins = Math.max(1, Math.round((sess.end - sess.start) / 60000));
    sum.appendChild(el("span", "tag", mins + " 分鐘"));
    d.appendChild(sum);

    const body = el("div", "s-body");
    for (const m of sess.messages) {
      const line = el("div", "s-line");
      line.appendChild(el("b", null, m.role === "user" ? "你" : "AI"));
      line.appendChild(document.createTextNode(m.content));
      if (m.role === "user" && m.fix && !m.fix.ok) Grammar.renderFix(line, m.content, m.fix);
      body.appendChild(line);
    }
    d.appendChild(body);
    box.appendChild(d);
  }
}

/* ---------- 個人分析 ---------- */

function renderInsights() {
  const data = Insights.compute();
  Insights.render($("insights"), data, async (act, btn) => {
    const go = (cards, mode) => {
      if (!cards.length) { toast("目前沒有可以練的字"); return; }
      showTab("review");
      startReviewRound(cards, mode);
    };
    const sample = (arr, n) => arr.slice().sort(() => Math.random() - .5).slice(0, n);
    if (act === "mixed") go(V.due("").slice(0, 15), "mixed");
    if (act === "produce-gap") go(sample(data.passiveGap, 15), "mixed");
    if (act === "leeches") go(data.leeches, "mixed");
    if (act === "spell") {
      const due = V.due("");
      go(due.length ? due : sample(Store.vocab().filter(v => v.zh), 15), "spell");
    }
    if (act === "freq") {
      Store.settings().vocabFrequency = 0.75;
      Store.save();
      toast("已把對話中的單字頻率調到「常常」");
    }
    if (act === "coach") {
      const s = Store.settings();
      if (!(s.provider === "groq" ? s.groqKey : s.geminiKey)) { toast("要先到設定填 API 金鑰"); return; }
      btn.disabled = true;
      btn.textContent = "產生中…";
      const body = $("insights").querySelector(".coach-body");
      try {
        const cached = !!Store.load().coach[Insights.weekKey()];
        const text = await Insights.coachReport(data, cached);
        body.textContent = text;
        btn.textContent = "重新產生";
      } catch (e) {
        body.textContent = "產生失敗：" + e.message;
        btn.textContent = "再試一次";
      } finally {
        btn.disabled = false;
      }
    }
  });
}

/* ---------- 備份 ---------- */

function download(text, filename, mime) {
  const blob = new Blob([text], { type: mime || "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

$("btnExportAll").addEventListener("click", () => {
  download(Store.exportJSON(), "englishtalk-backup-" + Store.todayKey() + ".json");
  toast("已匯出備份（不含金鑰）");
});

$("btnImportAll").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const r = Store.importJSON(text, "merge");
    toast(`匯入完成：新增 ${r.vocab} 個單字、${r.sessions} 場對話`);
    refreshPills();
    renderStats();
  } catch (err) {
    toast("匯入失敗：" + err.message, 4000);
  }
  e.target.value = "";
});

$("btnWipe").addEventListener("click", () => {
  if (!confirm("這會刪掉單字本、對話紀錄、統計與金鑰設定，且無法復原。確定嗎？")) return;
  Store.wipe();
  location.reload();
});

/* =========================================================================
   設定
   ========================================================================= */

const dlg = $("dlgSettings");

function openSettings() {
  const s = Store.settings();
  $("appVersion").textContent = "v" + APP_VERSION;
  $("testKeyNote").textContent = "";
  $("cfgProvider").value = s.provider;
  $("cfgGeminiModel").value = s.geminiModel;
  $("cfgGroqModel").value = s.groqModel;
  $("cfgTTSEngine").value = s.ttsEngine;
  $("cfgEdgeVoice").value = s.edgeVoice;
  $("cfgRate").value = String(s.rate);
  $("cfgLevel").value = s.level;
  $("cfgPersona").value = s.persona;
  $("cfgBarge").value = String(s.bargeSensitivity);
  $("cfgSilence").value = String(s.silenceMs);
  $("cfgVocabFreq").value = String(s.vocabFrequency);
  $("cfgPromoteHeard").checked = !!s.promoteHeard;
  $("cfgAnalyzeGaps").checked = !!s.analyzeGaps;
  $("cfgGrammar").value = s.grammarCheck || "live";
  $("cfgScheduler").value = s.scheduler || "fsrs";
  $("cfgRetention").value = String(s.retention || 0.9);
  $("cfgRetention").disabled = $("cfgScheduler").value !== "fsrs";
  $("cacheInfo").textContent = `目前已快取 ${Store.cacheSize()} 個單字的查詢結果，這些字不會再呼叫 API。`;
  $("cfgGeminiKey").value = "";
  $("cfgGroqKey").value = "";
  setKeyBadge($("stGemini"), !!s.geminiKey);
  setKeyBadge($("stGroq"), !!s.groqKey);
  syncProviderVisibility();
  syncTTSVisibility();
  fillVoiceSelects();
  dlg.showModal();
}

function setKeyBadge(node, on) {
  node.textContent = on ? "已設定" : "未設定";
  node.className = "badge" + (on ? " on" : "");
}

function syncProviderVisibility() {
  const p = $("cfgProvider").value;
  // 兩組都留著讓使用者可以先填好備用，只是把目前選的放前面強調
  $("grpGemini").style.opacity = p === "gemini" ? "1" : ".6";
  $("grpGroq").style.opacity = p === "groq" ? "1" : ".6";
}

function syncTTSVisibility() {
  const e = $("cfgTTSEngine").value;
  $("grpBrowserVoice").hidden = e !== "browser";
  $("grpEdgeVoice").hidden = e !== "edge";
}

async function fillVoiceSelects() {
  const s = Store.settings();
  const edgeSel = $("cfgEdgeVoice");
  edgeSel.innerHTML = "";
  TTS.EDGE_VOICES.forEach(v => {
    const o = el("option", null, v.label);
    o.value = v.id;
    edgeSel.appendChild(o);
  });
  edgeSel.value = s.edgeVoice;

  const voices = await TTS.loadVoices();
  const bSel = $("cfgBrowserVoice");
  bSel.innerHTML = "";
  if (!voices.length) {
    bSel.appendChild(el("option", null, "（這個瀏覽器沒有英文語音）"));
  } else {
    voices.forEach(v => {
      const neural = /natural|online|google/i.test(v.name);
      const o = el("option", null, (neural ? "★ " : "") + v.name + "（" + v.lang + "）");
      o.value = v.name;
      bSel.appendChild(o);
    });
    bSel.value = s.browserVoice || voices[0].name;
  }
}

$("cfgProvider").addEventListener("change", syncProviderVisibility);
$("cfgTTSEngine").addEventListener("change", syncTTSVisibility);
$("btnSettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", () => dlg.close());

$("btnSaveSettings").addEventListener("click", () => {
  const s = Store.settings();
  s.provider = $("cfgProvider").value;
  if ($("cfgGeminiKey").value.trim()) s.geminiKey = $("cfgGeminiKey").value.trim();
  if ($("cfgGroqKey").value.trim()) s.groqKey = $("cfgGroqKey").value.trim();
  s.geminiModel = $("cfgGeminiModel").value.trim() || s.geminiModel;
  s.groqModel = $("cfgGroqModel").value.trim() || s.groqModel;
  s.ttsEngine = $("cfgTTSEngine").value;
  s.browserVoice = $("cfgBrowserVoice").value || "";
  s.edgeVoice = $("cfgEdgeVoice").value;
  s.rate = Number($("cfgRate").value);
  s.level = $("cfgLevel").value;
  s.persona = $("cfgPersona").value.trim() || s.persona;
  s.bargeSensitivity = Number($("cfgBarge").value);
  s.silenceMs = Number($("cfgSilence").value);
  s.vocabFrequency = Number($("cfgVocabFreq").value);
  s.promoteHeard = $("cfgPromoteHeard").checked;
  s.analyzeGaps = $("cfgAnalyzeGaps").checked;
  s.grammarCheck = $("cfgGrammar").value;
  const schedChanged = s.scheduler !== $("cfgScheduler").value
    || Number(s.retention) !== Number($("cfgRetention").value);
  s.scheduler = $("cfgScheduler").value;
  s.retention = Number($("cfgRetention").value);
  Store.save(true);
  if (schedChanged) {
    const n = V.rescheduleAll();
    if (n) setTimeout(() => toast(`已依新的排程重新安排 ${n} 個字的複習日`), 2700);
    refreshPills();
  }

  TTS.resetEdge();
  if (C.listener) C.listener.configure({
    silenceMs: s.silenceMs, bargeSensitivity: s.bargeSensitivity,
  });
  refreshBadges();
  dlg.close();
  toast("設定已儲存");
});

// 目標記憶率只對 FSRS 有意義
$("cfgScheduler").addEventListener("change", () => {
  $("cfgRetention").disabled = $("cfgScheduler").value !== "fsrs";
});

/* ---------- 模型清單 ---------- */

async function fetchModelsInto(provider) {
  const isGroq = provider === "groq";
  const note = $(isGroq ? "noteGroq" : "noteGemini");
  const list = $(isGroq ? "listGroq" : "listGemini");
  const input = $(isGroq ? "cfgGroqModel" : "cfgGeminiModel");

  // 先把畫面上輸入的金鑰暫存起來，讓查詢可以立刻用新金鑰
  const s = Store.settings();
  const typed = $(isGroq ? "cfgGroqKey" : "cfgGeminiKey").value.trim();
  const backup = isGroq ? s.groqKey : s.geminiKey;
  if (typed) { if (isGroq) s.groqKey = typed; else s.geminiKey = typed; }

  note.textContent = "查詢中…";
  try {
    const models = await LLM.listModels(provider);
    list.innerHTML = "";
    models.forEach(m => {
      const o = document.createElement("option");
      o.value = m;
      list.appendChild(o);
    });
    if (!models.includes(input.value.trim()) && models.length) {
      const prefer = isGroq
        ? ["llama-3.1-8b-instant", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]
        : ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"];
      input.value = prefer.find(p => models.includes(p)) || models[0];
    }
    note.textContent = `找到 ${models.length} 個可用模型，點輸入框可下拉選擇。`;
  } catch (e) {
    note.textContent = "查詢失敗：" + e.message;
    if (typed) { if (isGroq) s.groqKey = backup; else s.geminiKey = backup; }
  }
}

/* ---------- 測試連線：貼完金鑰馬上知道能不能用，不用等到開始對話才發現 ---------- */

$("btnTestKey").addEventListener("click", async () => {
  const note = $("testKeyNote");
  const s = Store.settings();
  const provider = $("cfgProvider").value;
  const isGroq = provider === "groq";
  const typed = $(isGroq ? "cfgGroqKey" : "cfgGeminiKey").value.trim();
  const model = $(isGroq ? "cfgGroqModel" : "cfgGeminiModel").value.trim();

  // 暫時套用畫面上的值來測，測完還原；真正存檔要按「儲存」
  const backup = { provider: s.provider, groqKey: s.groqKey, geminiKey: s.geminiKey,
                   groqModel: s.groqModel, geminiModel: s.geminiModel };
  s.provider = provider;
  if (typed) { if (isGroq) s.groqKey = typed; else s.geminiKey = typed; }
  if (model) { if (isGroq) s.groqModel = model; else s.geminiModel = model; }

  if (!(isGroq ? s.groqKey : s.geminiKey)) {
    Object.assign(s, backup);
    note.textContent = "請先貼上金鑰。";
    return;
  }
  const btn = $("btnTestKey");
  btn.disabled = true;
  note.textContent = "測試中…";
  try {
    const t0 = performance.now();
    await LLM.complete("Reply with the single word OK.", { maxTokens: 10 });
    const ms = Math.round(performance.now() - t0);
    note.textContent = `✅ 可以用！回應時間 ${ms} 毫秒。記得按「儲存」。`;
  } catch (e) {
    note.textContent = "❌ " + e.message;
  } finally {
    Object.assign(s, backup);
    btn.disabled = false;
  }
});

$("lnkWhatsNew").addEventListener("click", (e) => {
  e.preventDefault();
  dlg.close();
  openWhatsNew();
});

$("btnFetchGemini").addEventListener("click", () => fetchModelsInto("gemini"));
$("btnFetchGroq").addEventListener("click", () => fetchModelsInto("groq"));

/* =========================================================================
   啟動
   ========================================================================= */

(function init() {
  Store.load();
  try {
    const th = localStorage.getItem("englishtalk.theme");
    if (th && th !== "auto") document.documentElement.setAttribute("data-theme", th);
  } catch (e) {}

  refreshBadges();
  refreshPills();
  setState("idle");

  if (!isSupported()) {
    sysMsg("這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge。下方輸入框仍可打字練習。");
  }

  const s = Store.settings();
  const hasAnyKey = !!(s.geminiKey || s.groqKey);
  renderWelcome();

  // 新功能介紹：老使用者第一次打開新版本才會看到；全新使用者直接去設定金鑰
  initWhatsNew({ go: (tab) => showTab(tab) });   // 「試試看」會切到對應的分頁
  const returning = hasAnyKey || Store.vocab().length > 0 || Store.sessions().length > 0;
  const shown = maybeShowWhatsNew(returning);
  if (!hasAnyKey && !shown) setTimeout(openSettings, 400);

  // 從桌面捷徑打開（?tab=review 之類）
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab && document.getElementById("page-" + tab)) showTab(tab);

  // 可安裝成 App、離線也能開（只在安全來源註冊：https 或本機）
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  TTS.loadVoices();
  window.addEventListener("store:error", () => {
    toast("瀏覽器儲存空間已滿，請到「紀錄」匯出備份後清理舊資料。", 5000);
  });
})();

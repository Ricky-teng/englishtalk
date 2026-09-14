/**
 * app.js — 主程式：把對話、單字本、複習、統計四個分頁串起來
 */

import * as Store from "./store.js";
import * as LLM from "./llm.js";
import * as TTS from "./tts.js";
import * as V from "./vocab.js";
import * as Stats from "./stats.js";
import { Listener, isSupported, wordCount } from "./asr.js";

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
  d.appendChild(el("span", "who", kind === "user" ? "你" : kind === "ai" ? "AI" : "系統"));
  const body = el("span", "body");
  if (kind === "ai") renderClickableWords(body, text || "");
  else body.textContent = text || "";
  d.appendChild(body);
  chatInner.appendChild(d);
  scrollChat();
  return { root: d, body };
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

async function sendTurn(userText) {
  addMsg("user", userText);
  C.history.push({ role: "user", content: userText });
  if (C.history.length > 24) C.history = C.history.slice(-24);
  Stats.recordTurn("user", userText, wordCount(userText));

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
    let line = `這次練習：${done.turns} 回合、開口 ${done.userWords} 個字。`;
    if (done.produced && done.produced.length) {
      line += `\n你在對話中自己用出了 ${done.produced.length} 個單字本的字：`
            + done.produced.join("、") + "。";
    }
    sysMsg(line);

    const s2 = Store.settings();

    // 「聽得懂但講不出來」：AI 用了、你沒接的字，提前到明天複習（純本地，不呼叫 API）
    if (s2.promoteHeard) {
      const moved = V.promoteHeardNotProduced(done.heard, done.produced);
      if (moved.length) {
        sysMsg("這幾個字 AI 用了、你沒跟著用到，已經排進明天的複習："
             + moved.map(c => c.word).join("、"));
      }
    }

    // 「想講但講不出來」：整場對話只呼叫一次 API
    if (s2.analyzeGaps && done.turns >= 3) renderGaps(done);
  }
  refreshPills();
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

const pop = $("wordPop");
let popWord = "";
let popContext = "";

document.addEventListener("click", (e) => {
  const w = e.target.closest(".msg.ai .w");
  if (w) { openWordPop(w); return; }
  if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true;
});

async function openWordPop(spanEl) {
  const word = spanEl.dataset.word;
  const sentence = spanEl.closest(".body") ? spanEl.closest(".body").textContent : "";

  // 定位在被點的字下方（之後點近義詞不會再移動，維持閱讀焦點）
  const r = spanEl.getBoundingClientRect();
  pop.hidden = false;
  pop.innerHTML = "";
  const pw = pop.offsetWidth || 330;
  pop.style.left = Math.min(Math.max(r.left - pw / 2 + r.width / 2, 12),
                            window.innerWidth - pw - 12) + "px";
  const below = r.bottom + 8;
  pop.style.top = (below + 260 > window.innerHeight ? Math.max(r.top - 260, 12) : below) + "px";

  loadWordPop(word, sentence.slice(0, 300));
}

/** 查一個字並畫進彈窗；點近義／反義詞會再呼叫這個，形成可連續探索的字詞網 */
async function loadWordPop(word, context = "") {
  popWord = word;
  popContext = context;
  pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(word)}</span></div>
                   <p class="wp-zh muted">查詢中…</p>`;

  const existing = V.find(word);
  if (existing && existing.zh) { paintWordPop(existing, true); return; }

  try {
    const d = await V.lookup(word, context);
    if (popWord !== word) return;   // 使用者已經點了別的字
    paintWordPop(d, false);
  } catch (e) {
    if (popWord !== word) return;
    pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(word)}</span></div>
                     <p class="wp-zh">查詢失敗：${esc(e.message)}</p>
                     <div class="wp-actions">
                       <button class="btn sm" id="wpAddRaw">先加入，之後再補</button>
                     </div>`;
    $("wpAddRaw").addEventListener("click", () => {
      V.add(word);
      pop.hidden = true;
      refreshPills();
      markSaved(word);
      toast(`已加入「${word}」`);
    });
  }
}

/** 近義／反義詞區塊。每個詞都是可點的，點了就查那個詞。 */
function relatedHTML(label, cls, list) {
  if (!list || !list.length) return "";
  const saved = new Set(Store.vocab().map(v => v.word.toLowerCase()));
  const chips = list.map(x => {
    const inBook = saved.has(x.w.toLowerCase()) ? " saved" : "";
    const tip = x.zh ? ` title="${esc(x.zh)}"` : "";
    return `<button class="chip ${cls}${inBook}" data-lookup="${esc(x.w)}"${tip}>`
         + `${esc(x.w)}${x.zh ? `<i>${esc(x.zh)}</i>` : ""}</button>`;
  }).join("");
  return `<div class="wp-rel"><span class="wp-rel-label">${label}</span>
            <div class="chips">${chips}</div></div>`;
}

function paintWordPop(d, already) {
  pop.innerHTML = `
    <div class="wp-head">
      <span class="wp-word">${esc(d.word)}</span>
      ${d.phonetic ? `<span class="wp-ipa">${esc(d.phonetic)}</span>` : ""}
      ${d.pos ? `<span class="wp-pos">${esc(d.pos)}</span>` : ""}
    </div>
    ${d.zh ? `<p class="wp-zh">${esc(d.zh)}</p>` : ""}
    ${d.example ? `<div class="wp-ex">${esc(d.example)}<br><span class="muted">${esc(d.exampleZh || "")}</span></div>` : ""}
    ${relatedHTML("近義", "syn", d.synonyms)}
    ${relatedHTML("反義", "ant", d.antonyms)}
    <div class="wp-actions">
      <button class="btn sm ghost" id="wpSpeak">🔊</button>
      <button class="btn sm ghost" id="wpRefetch" title="這不是這句話裡的意思？重新查一次">↻</button>
      ${already ? `<button class="btn sm" disabled>已在單字本</button>`
                : `<button class="btn sm primary" id="wpAdd">加入單字本</button>`}
    </div>`;
  $("wpSpeak").addEventListener("click", () => TTS.speak(d.word, undefined, null));
  $("wpRefetch").addEventListener("click", async () => {
    V.forgetLookup(d.word);
    pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(d.word)}</span></div>
                     <p class="wp-zh muted">重新查詢中…</p>`;
    try {
      const fresh = await V.lookup(d.word, popContext, true);
      if (popWord === d.word) paintWordPop(fresh, !!V.find(d.word));
    } catch (e) {
      if (popWord === d.word) paintWordPop(d, already);
    }
  });
  const add = $("wpAdd");
  if (add) add.addEventListener("click", () => {
    V.add(d.word, d);
    pop.hidden = true;
    refreshPills();
    markSaved(d.word);
    toast(`已加入「${d.word}」，之後會出現在複習`);
  });

  // 點近義／反義詞就查那個詞，彈窗原地換內容
  pop.querySelectorAll("[data-lookup]").forEach(btn => {
    btn.addEventListener("click", () => loadWordPop(btn.dataset.lookup, ""));
  });
}

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
    acts.append(bSpeak, bTag, bDel);

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

function openWordEditor(card) {
  editingId = card ? card.id : null;
  $("wordDlgTitle").textContent = card ? "編輯單字" : "新增單字";
  $("wfWord").value       = card ? card.word : "";
  $("wfPhonetic").value   = card ? (card.phonetic || "") : "";
  $("wfPos").value        = card ? (card.pos || "") : "";
  $("wfZh").value         = card ? (card.zh || "") : "";
  $("wfExample").value    = card ? (card.example || "") : "";
  $("wfExampleZh").value  = card ? (card.exampleZh || "") : "";
  $("wfSyn").value        = card ? relToText(card.synonyms) : "";
  $("wfAnt").value        = card ? relToText(card.antonyms) : "";
  $("wfTags").value       = card ? (card.tags || []).join(" ") : ($("vocabTag").value || "");
  $("wordDlgNote").textContent = "";
  dlgWord.showModal();
  setTimeout(() => $("wfWord").focus(), 50);
}

$("btnAddOne").addEventListener("click", () => openWordEditor(null));
$("btnCloseWord").addEventListener("click", () => dlgWord.close());

$("btnAutoFill").addEventListener("click", async () => {
  const word = $("wfWord").value.trim();
  const note = $("wordDlgNote");
  if (!word) { note.textContent = "請先填英文單字。"; return; }
  const btn = $("btnAutoFill");
  btn.disabled = true;
  note.textContent = "查詢中…";
  try {
    const d = await V.lookup(word);
    // 只補空白欄位，不覆蓋你已經自己打好的內容
    if (!$("wfPhonetic").value.trim())  $("wfPhonetic").value = d.phonetic || "";
    if (!$("wfPos").value.trim())       $("wfPos").value = d.pos || "";
    if (!$("wfZh").value.trim())        $("wfZh").value = d.zh || "";
    if (!$("wfExample").value.trim())   $("wfExample").value = d.example || "";
    if (!$("wfExampleZh").value.trim()) $("wfExampleZh").value = d.exampleZh || "";
    if (!$("wfSyn").value.trim())       $("wfSyn").value = relToText(d.synonyms);
    if (!$("wfAnt").value.trim())       $("wfAnt").value = relToText(d.antonyms);
    note.textContent = "已補上空白欄位，你原本填的內容沒有被改動。";
  } catch (e) {
    note.textContent = "查詢失敗：" + e.message + "（可以直接自己填）";
  } finally {
    btn.disabled = false;
  }
});

$("btnSaveWord").addEventListener("click", () => {
  const word = $("wfWord").value.trim();
  if (!word) { $("wordDlgNote").textContent = "英文單字不能空白。"; return; }
  const data = {
    word,
    phonetic:  $("wfPhonetic").value.trim(),
    pos:       $("wfPos").value.trim(),
    zh:        $("wfZh").value.trim(),
    example:   $("wfExample").value.trim(),
    exampleZh: $("wfExampleZh").value.trim(),
    synonyms:  textToRel($("wfSyn").value),
    antonyms:  textToRel($("wfAnt").value),
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

// Enter 直接存檔，方便連續輸入
dlgWord.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    $("btnSaveWord").click();
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

$("btnStartReview").addEventListener("click", () => {
  R.tag = $("reviewTag").value;
  R.queue = V.due(R.tag);
  R.idx = 0;
  R.done = 0;
  R.revealed = false;
  if (!R.queue.length) { toast("目前沒有到期的單字"); return; }
  paintCard();
});

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
  const prog = el("div", "review-progress");
  prog.appendChild(el("span", null, `第 ${R.idx + 1} / ${R.queue.length} 張`));
  prog.appendChild(el("span", null, `本輪已複習 ${R.done}`));
  stage.appendChild(prog);

  const fc = el("div", "flashcard");
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
  stage.appendChild(bar);

  if (!R.revealed) {
    const show = el("button", "btn primary", "顯示答案");
    show.style.marginTop = "14px";
    show.style.width = "100%";
    show.addEventListener("click", () => { R.revealed = true; paintCard(); });
    stage.appendChild(show);
  } else {
    const grades = el("div", "grade-row");
    [
      { q: 0, label: "忘記", hint: "今天再來" },
      { q: 3, label: "困難", hint: "很快再看" },
      { q: 4, label: "普通", hint: "正常間隔" },
      { q: 5, label: "簡單", hint: "拉長間隔" },
    ].forEach(g => {
      const b = el("button");
      b.innerHTML = `<b>${g.label}</b><small>${g.hint}</small>`;
      b.addEventListener("click", () => {
        V.grade(card.id, g.q);
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
  const reviewing = $("page-review").classList.contains("active") && R.queue.length;
  if (!reviewing) return;
  if (e.target.matches("input, textarea, select")) return;
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
      body.appendChild(line);
    }
    d.appendChild(body);
    box.appendChild(d);
  }
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
  Store.save(true);

  TTS.resetEdge();
  if (C.listener) C.listener.configure({
    silenceMs: s.silenceMs, bargeSensitivity: s.bargeSensitivity,
  });
  refreshBadges();
  dlg.close();
  toast("設定已儲存");
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
  if (!s.geminiKey && !s.groqKey) {
    sysMsg("歡迎！第一次使用請先到右上角「設定」貼上一組免費 API 金鑰，就可以開始說英文了。");
    setTimeout(openSettings, 400);
  } else {
    sysMsg("按「開始對話」，AI 會先跟你打招呼。說話時不用等它說完，直接插話就好。");
  }

  TTS.loadVoices();
  window.addEventListener("store:error", () => {
    toast("瀏覽器儲存空間已滿，請到「紀錄」匯出備份後清理舊資料。", 5000);
  });
})();

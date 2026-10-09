/**
 * speakreview.js — 用說的複習
 *
 * 翻卡只能證明「看到英文想得起中文」；這個模式反過來，而且要你開口：
 *   畫面給你中文（例如「談判」），AI 用語音問你一個生活化的問題，
 *   你要自己想出英文單字，並用它說一句話回答。
 *
 * 評分全部在本地完成（有沒有用到那個字，支援詞形變化），不花 API 額度。
 * 問題是一次批次產生後存在卡片上的，所以同一個字之後再複習，一次 API 都不用。
 *
 * 提示階梯（答不出來時一層一層給）：
 *   第 1 次沒用到 → 顯示首字母與長度   n _ _ _ _ _ _ _ _
 *   第 2 次沒用到 → 播放那個字的發音
 *   第 3 次       → 公布答案，這張卡記為「忘記」
 * 評分：沒用提示答對 = 簡單、用了首字母 = 普通、聽了發音 = 困難、放棄 = 忘記
 */

import * as V from "./vocab.js";
import * as TTS from "./tts.js";
import { complete, parseJSON } from "./llm.js";
import { bumpDaily, save, settings } from "./store.js";
import { listenOnce, canListen } from "./listen.js";
import { openShadow } from "./shadow.js";

const ROUND_SIZE = 10;
const PRAISE = ["Nice!", "Perfect.", "Great, you got it.", "Exactly.", "Well done!", "That's it!"];

let hooks = { stage: null, pauseAudio: () => {}, resumeAudio: () => {}, onDone: () => {}, toast: () => {} };
let S = null;          // 這一輪的狀態
let listening = null;

export function initSpeakReview(h) { hooks = { ...hooks, ...h }; }
export function isActive() { return !!S; }

/* =========================================================================
   題目產生（批次、快取在卡片上）
   ========================================================================= */

const FALLBACK_Q = [
  "Tell me something about your own life using this word.",
  "Can you make one sentence about school, work, or your weekend with this word?",
  "How would you use this word when talking to a friend? Give me an example.",
];

/** 題目不能把答案講出來：含有目標字（任何詞形）的題目一律丟掉 */
function cleanQuestions(list, word) {
  return (Array.isArray(list) ? list : [])
    .map(q => String(q || "").trim())
    .filter(q => q && q.length < 200 && !V.textUsesWord(q, word));
}

/**
 * 幫還沒有題目的卡片批次產生題目。一次最多 15 張，只呼叫一次 API。
 * 失敗的話不存任何東西（下次還能重試），這一輪改用通用題目。
 */
export async function ensurePrompts(cards, level = "B1") {
  const need = cards.filter(c => !Array.isArray(c.prompts) || !c.prompts.length);
  if (!need.length) return { asked: 0, ok: true };

  let asked = 0, ok = true;
  for (let i = 0; i < need.length; i += 15) {
    const chunk = need.slice(i, i + 15);
    asked += chunk.length;
    const prompt = `QUESTION GENERATOR for a spoken vocabulary review app.
The learner is a Traditional Chinese speaker at about CEFR ${level}. For each target word below,
the learner will SEE the Chinese meaning and must answer your question OUT LOUD using the English word.

Write 2 different short spoken questions for each word (at most 18 words each). Each question must:
- be something a friendly person would really ask, about the learner's OWN life, opinions or experiences;
- create a situation where that exact word (in the given sense) is the natural thing to use;
- NEVER contain the target word or any form of it;
- use only simple vocabulary a ${level} learner understands.

Return ONLY a JSON array, no markdown fence:
[{"word":"<the target word exactly as given>","questions":["...","..."]}]

${chunk.map(c => `WORD: ${c.word}${c.zh ? `  (meaning: ${c.zh})` : ""}`).join("\n")}`;
    try {
      const raw = await complete(prompt, { maxTokens: 1800, geminiJson: true });
      const arr = parseJSON(raw);
      if (!Array.isArray(arr)) throw new Error("格式不正確");
      for (const c of chunk) {
        const hit = arr.find(x => String(x.word || "").toLowerCase() === c.word.toLowerCase());
        const qs = cleanQuestions(hit && hit.questions, c.word);
        if (qs.length) c.prompts = qs.slice(0, 3);
      }
      save();
    } catch (e) {
      ok = false;
      console.warn("[speakreview] 產生題目失敗，改用通用題目：", e.message);
    }
  }
  return { asked, ok };
}

function pickQuestion(card) {
  const list = (card.prompts && card.prompts.length) ? card.prompts : FALLBACK_Q;
  const i = (card.promptIdx || 0) % list.length;
  if (card.prompts && card.prompts.length) card.promptIdx = i + 1;   // 下次換另一題
  return list[i];
}

/* =========================================================================
   一輪複習
   ========================================================================= */

export async function startSpeakReview(cards) {
  if (!cards.length) return;
  stopSpeakReview(true);
  hooks.pauseAudio();

  const round = cards.slice(0, ROUND_SIZE);
  S = { cards: round, idx: 0, attempt: 0, results: [], question: "", heard: "", phase: "loading" };

  paintLoading(round.length);
  const r = await ensurePrompts(round, settings().level);
  if (!S) return;   // 等待期間被中止了
  if (!r.ok) hooks.toast("題目產生失敗，這輪先用通用題目（不影響評分）", 3500);
  nextCard();
}

export function stopSpeakReview(silent = false) {
  stopListening();
  TTS.stop();
  const was = !!S;
  S = null;
  document.removeEventListener("keydown", onKey);
  if (was && !silent) hooks.resumeAudio();
}

function card() { return S.cards[S.idx]; }

/** 中途收掉聆聽：先把 listening 清空，listen() 那邊就知道結果不算數 */
function stopListening() {
  const l = listening;
  listening = null;
  if (l) l.stop();
}

async function nextCard() {
  if (!S) return;
  if (S.idx >= S.cards.length) return finish();
  S.attempt = 0;
  S.heard = "";
  S.phase = "asking";
  S.question = pickQuestion(card());
  S.shownAt = Date.now();
  save();
  paintAsk();
  document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  await TTS.speak(S.question, undefined, null);
  if (!S || S.phase !== "asking") return;
  listen();
}

function hintFor(word, attempt) {
  if (attempt >= 1) {
    // 首字母 + 每個字母一個底線；片語保留空白
    return word.split("").map((ch, i) => (i === 0 || ch === " " ? ch : "_")).join(" ");
  }
  return "";
}

async function listen() {
  if (!S || listening) return;
  TTS.stop();                          // 還在唸題目就按麥克風：先停掉，免得把自己的聲音錄進去
  if (!canListen()) { S.phase = "typing"; paintAsk(); return; }
  S.phase = "listening";
  paintAsk();
  const mine = listenOnce({
    silenceMs: 1600,
    onInterim: (t) => { const n = hooks.stage.querySelector(".sr-heard"); if (n) n.textContent = "聽到：" + t; },
  });
  listening = mine;
  let text = "";
  try { text = await mine.promise; }
  catch (e) { if (listening === mine) listening = null; if (S) { S.phase = "typing"; paintAsk(e.message); } return; }
  // 這段聆聽如果是被別的動作（打字作答、放棄、換題）中途收掉的，結果就不算數，也不要重畫畫面
  if (listening !== mine) return;
  listening = null;
  if (!S || S.phase !== "listening") return;
  if (!text) { S.phase = "asking"; paintAsk("沒有聽到聲音，按麥克風再試一次，或直接打字。"); return; }
  check(text);
}

function check(text) {
  const c = card();
  S.heard = text;
  if (V.textUsesWord(text, c.word)) return pass(S.attempt === 0 ? 5 : S.attempt === 1 ? 4 : 3);

  S.attempt++;
  if (S.attempt >= 3) return fail();
  if (S.attempt === 2) TTS.speak(c.word, undefined, null);   // 第二層提示：直接聽發音
  S.phase = "asking";
  paintAsk();
}

function pass(q, manual = false) {
  const c = card();
  V.grade(c.id, q, { mode: "speak", ms: Date.now() - (S.shownAt || Date.now()) });
  V.markProduced([c]);                 // 這也是真正開口說出來的一次
  bumpDaily({ produced: 1 });
  S.results.push({ word: c.word, zh: c.zh, ok: true, hints: S.attempt, heard: S.heard, manual });
  S.phase = "passed";
  paintResult(true);
  TTS.speak(PRAISE[Math.floor(Math.random() * PRAISE.length)], undefined, null);
}

function fail() {
  const c = card();
  V.grade(c.id, 0, { mode: "speak", ms: Date.now() - (S.shownAt || Date.now()) });
  S.results.push({ word: c.word, zh: c.zh, ok: false, hints: 3, heard: S.heard });
  S.phase = "failed";
  paintResult(false);
  TTS.speak(c.word, undefined, null);
}

function advance() {
  if (!S) return;
  S.idx++;
  nextCard();
}

function onKey(e) {
  if (!S || document.querySelector("dialog[open]")) return;
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "Enter" && (S.phase === "passed" || S.phase === "failed")) { e.preventDefault(); advance(); }
  if (e.code === "Space" && S.phase === "asking") { e.preventDefault(); listen(); }
}

/* =========================================================================
   畫面
   ========================================================================= */

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function progressHTML() {
  const done = S.results.length;
  const dots = S.cards.map((_, i) => {
    const r = S.results[i];
    const cls = r ? (r.ok ? (r.hints ? "mid" : "ok") : "bad") : (i === S.idx ? "now" : "");
    return `<i class="${cls}"></i>`;
  }).join("");
  return `<div class="sr-top"><div class="sr-dots">${dots}</div>
          <span class="muted">${Math.min(done + 1, S.cards.length)} / ${S.cards.length}</span>
          <button class="btn sm ghost sr-quit" type="button">結束</button></div>`;
}

function bindTop() {
  const q = hooks.stage.querySelector(".sr-quit");
  if (q) q.addEventListener("click", () => finish(true));
}

function paintLoading(n) {
  hooks.stage.innerHTML = `<div class="sr-card"><div class="sr-task muted">準備 ${n} 題…</div>
    <p class="muted" style="margin:6px 0 0">第一次複習的字要先請 AI 出題，之後就直接用存好的題目。</p></div>`;
}

function paintAsk(msg = "") {
  const c = card();
  const hint = hintFor(c.word, S.attempt);
  const listeningNow = S.phase === "listening";
  hooks.stage.innerHTML = `
    ${progressHTML()}
    <div class="sr-card">
      <div class="sr-task no-lookup">用<b>「${esc(c.zh || "？")}」</b>這個字回答${c.pos ? `<span class="sr-pos">${esc(c.pos)}</span>` : ""}</div>
      <div class="sr-q">${esc(S.question)}</div>
      ${hint ? `<div class="sr-hint no-lookup">提示：<code>${esc(hint)}</code></div>` : ""}
      ${S.attempt === 2 ? `<div class="sr-hint">提示：剛剛唸給你聽的那個字 <button class="mini sr-replay" type="button">🔊 再聽一次</button></div>` : ""}
      ${S.heard && S.attempt ? `<div class="sr-miss">你說：「${esc(S.heard)}」—— 還沒用到那個字，再試一次</div>` : ""}
      <div class="sr-heard">${msg ? esc(msg) : ""}</div>
      <div class="sr-actions">
        <button class="sr-mic ${listeningNow ? "on" : ""}" type="button" ${listeningNow ? "disabled" : ""}
          title="按下開始說（空白鍵）">${listeningNow ? "🎙️ 聆聽中…" : "🎤 按下說話"}</button>
      </div>
      <form class="sr-type">
        <input type="text" placeholder="或直接打字回答，按 Enter" autocomplete="off">
      </form>
      <div class="sr-sub">
        <button class="mini sr-askagain" type="button">🔊 再聽題目</button>
        ${S.heard && S.attempt ? `<button class="mini sr-override" type="button" title="語音辨識偶爾會聽錯">我有說對，是辨識錯了</button>` : ""}
        <button class="mini sr-giveup" type="button">不會，看答案</button>
      </div>
    </div>`;
  bindTop();
  const $ = (s) => hooks.stage.querySelector(s);
  $(".sr-mic").addEventListener("click", () => listen());
  $(".sr-askagain").addEventListener("click", () => {
    stopListening();
    S.phase = "asking";
    paintAsk();
    TTS.speak(S.question, undefined, null);
  });
  $(".sr-giveup").addEventListener("click", () => { stopListening(); fail(); });
  const ov = $(".sr-override");
  if (ov) ov.addEventListener("click", () => { stopListening(); pass(4, true); });
  const rp = $(".sr-replay");
  if (rp) rp.addEventListener("click", () => TTS.speak(c.word, undefined, null));
  $(".sr-type").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $(".sr-type input").value.trim();
    if (!v) return;
    stopListening();
    check(v);
  });
}

function highlightWord(text, word) {
  // 把回答裡用到目標字的地方標出來
  return esc(text).split(/(\s+)/).map(tok =>
    /\S/.test(tok) && V.textUsesWord(tok, word.split(" ")[0]) ? `<mark>${tok}</mark>` : tok).join("");
}

function paintResult(ok) {
  const c = card();
  hooks.stage.innerHTML = `
    ${progressHTML()}
    <div class="sr-card ${ok ? "pass" : "fail"}">
      <div class="sr-verdict">${ok ? (S.attempt ? "✓ 說出來了（有用提示）" : "✓ 一次就說出來！") : "這次沒想起來，沒關係"}</div>
      ${ok && S.heard ? `<div class="sr-said">「${highlightWord(S.heard, c.word)}」</div>` : ""}
      <div class="sr-answer">
        <span class="sr-word">${esc(c.word)}</span>
        ${c.phonetic ? `<span class="wp-ipa">${esc(c.phonetic)}</span>` : ""}
        <span class="sr-zh">${esc(c.zh || "")}</span>
      </div>
      ${c.example ? `<div class="sr-ex">${esc(c.example)}${c.exampleZh ? `<br><span class="muted">${esc(c.exampleZh)}</span>` : ""}</div>` : ""}
      <div class="sr-actions">
        <button class="mini sr-say" type="button">🔊 聽這個字</button>
        ${c.example ? `<button class="mini sr-shadow" type="button">🎤 跟讀例句</button>` : ""}
        <div class="spacer"></div>
        <button class="btn primary sr-next" type="button">${S.idx + 1 >= S.cards.length ? "看結果" : "下一題"} ⏎</button>
      </div>
      <div class="note" style="margin-top:10px">${ok ? "已記一次複習與一次「說出來」。" : "今天稍後會再出現一次。"}</div>
    </div>`;
  bindTop();
  const $ = (s) => hooks.stage.querySelector(s);
  $(".sr-next").addEventListener("click", advance);
  $(".sr-say").addEventListener("click", () => TTS.speak(c.word, undefined, null));
  const sh = $(".sr-shadow");
  if (sh) sh.addEventListener("click", () => openShadow(c.example));
  $(".sr-next").focus();
}

function finish(early = false) {
  if (!S) return;
  const res = S.results;
  const first = res.filter(r => r.ok && !r.hints).length;
  const hinted = res.filter(r => r.ok && r.hints).length;
  const missed = res.filter(r => !r.ok);
  stopSpeakReview(true);
  hooks.stage.innerHTML = `
    <div class="sr-card sr-summary">
      <div class="sr-verdict">${early ? "這輪先到這裡" : "這輪完成 🎉"}</div>
      <div class="sr-nums">
        <div><b>${first}</b><span>一次說出</span></div>
        <div><b>${hinted}</b><span>靠提示說出</span></div>
        <div><b>${missed.length}</b><span>還要再練</span></div>
      </div>
      ${res.length ? `<div class="sr-list">${res.map(r =>
        `<span class="chip ${r.ok ? (r.hints ? "" : "syn") : "ant"}">${esc(r.word)}<i>${esc(r.zh || "")}</i></span>`).join("")}</div>` : ""}
      ${missed.length ? `<p class="note">沒想起來的字已排在今天稍後再出現，對話時 AI 也會更常用到它們。</p>` : ""}
      <div class="sr-actions">
        <button class="btn primary sr-again" type="button">再來一輪</button>
        <button class="btn ghost sr-home" type="button">回複習首頁</button>
      </div>
    </div>`;
  hooks.stage.querySelector(".sr-again").addEventListener("click", () => hooks.onDone("again"));
  hooks.stage.querySelector(".sr-home").addEventListener("click", () => hooks.onDone("home"));
  hooks.resumeAudio();
  hooks.onDone("finished");
}

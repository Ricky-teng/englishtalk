/**
 * quiz.js — 不用出聲的多種複習題型
 *
 *   ✅ 看英選中   認得（最簡單）
 *   🔁 看中選英   想得起來是哪個字
 *   🧩 例句填空   在句子裡用對（含詞形）
 *   ⌨️ 拼字       完全靠自己拼出來（最難）
 *   🎧 聽寫       聽得懂、拼得出來（要戴耳機）
 *   🔀 混合       依每個字的熟練度自動換題型 —— 新字先認、熟了再逼你拼
 *   🎮 配對遊戲   暖身用，不影響複習排程
 *
 * 全部在本地判分，不呼叫 API。每一題都會寫進作答紀錄，給「個人分析」用。
 */

import * as V from "./vocab.js";
import * as TTS from "./tts.js";
import { vocab, lookups, settings, save } from "./store.js";
import { openShadow } from "./shadow.js";

export const QUIZ_MODES = {
  mixed:  { icon: "🔀", name: "混合", tip: "依每個字的熟練度自動換題型：新字先「看英選中」，熟了改成填空和拼字。錯的字這輪最後會再考一次。（推薦）" },
  mcEn:   { icon: "✅", name: "看英選中", tip: "看英文，從四個中文裡選出意思。最輕鬆，適合剛加入的字。" },
  mcZh:   { icon: "🔁", name: "看中選英", tip: "看中文，從四個英文裡選出正確的字。" },
  cloze:  { icon: "🧩", name: "例句填空", tip: "例句挖掉一個字，打出正確的形態（例如 negotiated）。沒有例句的字會改成拼字題。" },
  spell:  { icon: "⌨️", name: "拼字", tip: "看中文，自己拼出英文。卡住可以按提示一次多給一個字母。" },
  listen: { icon: "🎧", name: "聽寫", tip: "聽發音，拼出單字。要開聲音或戴耳機。" },
  match:  { icon: "🎮", name: "配對遊戲", tip: "把英文和中文配成對，越快越好。只是暖身，不會影響複習排程。" },
};

const ROUND = 15;
let hooks = { stage: null, onDone: () => {}, toast: () => {} };
let S = null;

export function initQuiz(h) { hooks = { ...hooks, ...h }; }
export function isQuizActive() { return !!S; }

/* =========================================================================
   工具
   ========================================================================= */

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const norm = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "'")
  .replace(/[.,!?;:"]+$/g, "").replace(/\s+/g, " ").trim();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** 編輯距離（判斷「差一個字母」的拼錯） */
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

/** 挑三個干擾選項：同詞性優先，不能跟正解同義重複；單字本不夠就從查詢快取補 */
function distractors(card, field) {
  const right = norm(card[field]);
  const seen = new Set([right]);
  const pool = [];
  const pushIf = (val, pos) => {
    const k = norm(val);
    if (!k || seen.has(k)) return;
    if (field === "zh" && (right.includes(k) || k.includes(right))) return;   // 太像的中文不要
    seen.add(k);
    pool.push({ val, same: pos && card.pos && pos === card.pos ? 0 : 1, r: Math.random() });
  };
  for (const v of vocab()) if (v.id !== card.id) pushIf(v[field], v.pos);
  if (pool.length < 3) {
    for (const [k, v] of Object.entries(lookups())) {
      if (k === card.word.toLowerCase()) continue;
      pushIf(field === "zh" ? v.zh : (v.word || k), v.pos);
    }
  }
  return pool.sort((a, b) => a.same - b.same || a.r - b.r).slice(0, 3).map(x => x.val);
}

/** 找出例句裡那個字（含詞形變化、片語），回傳挖空後的句子與正確形態 */
export function clozeOf(card) {
  const ex = card.example || "";
  if (!ex) return null;
  const parts = card.word.trim().split(/\s+/).map(p => V.stemWord(p.toLowerCase()));
  const toks = [...ex.matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
  for (let i = 0; i + parts.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      if (V.stemWord(toks[i + k][0].toLowerCase()) !== parts[k]) { ok = false; break; }
    }
    if (!ok) continue;
    const start = toks[i].index;
    const last = toks[i + parts.length - 1];
    const end = last.index + last[0].length;
    const answer = ex.slice(start, end);
    return { before: ex.slice(0, start), after: ex.slice(end), answer };
  }
  return null;
}

/** 混合模式：依熟練度決定題型（由易到難的「漸進式回想」） */
function pickType(card) {
  const r = card.reps || 0;
  const relapse = (card.lapses || 0) > 0 && (card.interval || 0) === 0;
  if (r === 0 && !relapse) return "mcEn";
  if (r === 0 || r === 1) return "mcZh";
  if (r === 2) return clozeOf(card) ? "cloze" : "spell";
  return clozeOf(card) && Math.random() < 0.5 ? "cloze" : "spell";
}

/** 依題型建立一題；條件不夠（例如選項湊不滿、沒有例句）就換一個做得出來的題型 */
function buildItem(card, type) {
  if (type === "mcEn" || type === "mcZh") {
    const field = type === "mcEn" ? "zh" : "word";
    if (!card.zh) return buildItem(card, "spell");
    const ds = distractors(card, field);
    if (ds.length < 3) return buildItem(card, type === "mcEn" ? "spell" : "spell");
    const options = shuffle([card[field], ...ds]);
    return { type, card, options, answer: options.indexOf(card[field]) };
  }
  if (type === "cloze") {
    const c = clozeOf(card);
    if (!c) return buildItem(card, "spell");
    return { type, card, cloze: c, answer: c.answer, base: card.word };
  }
  if (type === "listen") return { type, card, answer: card.word };
  return { type: "spell", card, answer: card.word };
}

/* =========================================================================
   一輪
   ========================================================================= */

export function startQuiz(mode, cards) {
  stopQuiz();
  if (!cards.length) return;
  if (mode === "match") return startMatch(cards);
  const round = cards.slice(0, ROUND);
  S = { mode, queue: round.map(c => ({ card: c, retry: false })), idx: 0, results: [], item: null,
        answered: false, hints: 0, shownAt: 0, retried: new Set() };
  document.addEventListener("keydown", onKey);
  next();
}

export function stopQuiz() {
  if (S && S.timer) clearInterval(S.timer);
  S = null;
  document.removeEventListener("keydown", onKey);
}

function next() {
  if (!S) return;
  if (S.idx >= S.queue.length) return finish();
  const q = S.queue[S.idx];
  const type = q.retry ? "mcZh" : (S.mode === "mixed" ? pickType(q.card) : S.mode);
  S.item = buildItem(q.card, type);
  S.answered = false;
  S.hints = 0;
  S.shownAt = Date.now();
  paint();
  if (S.item.type === "listen") TTS.speak(q.card.word, undefined, null);
}

function record(ok, q, note = "") {
  const it = S.item;
  const cur = S.queue[S.idx];
  S.answered = true;
  S.lastOk = ok;
  S.note = note;
  cur.result = ok;
  // 「這輪最後再考一次」的題目只是加強，不重複計分，避免同一個字一天被扣兩次
  if (!cur.retry) {
    V.grade(it.card.id, q, { mode: it.type, ms: Date.now() - S.shownAt });
    S.results.push({ word: it.card.word, zh: it.card.zh, ok, q, type: it.type });
    if (!ok && !S.retried.has(it.card.id)) {
      S.retried.add(it.card.id);
      S.queue.push({ card: it.card, retry: true });
    }
  }
  paint();
  hooks.onGraded && hooks.onGraded();
  if (ok && (it.type === "mcEn" || it.type === "mcZh")) {
    // 選擇題答對就快速跳下一題，保持節奏
    const myIdx = S.idx;
    setTimeout(() => { if (S && S.idx === myIdx && S.answered) advance(); }, 750);
  }
}

function advance() {
  if (!S) return;
  S.idx++;
  next();
}

function submitTyped(raw) {
  const it = S.item;
  const v = norm(raw);
  if (!v) return;
  const ans = norm(it.answer);
  if (v === ans) return record(true, S.hints ? 3 : 5);
  if (it.type === "cloze" && it.base && v === norm(it.base) && ans !== norm(it.base)) {
    return record(true, 4, `意思對了！不過這句要用 ${it.answer}`);
  }
  if (ans.length >= 5 && lev(v, ans) === 1) {
    return record(true, 3, `差一個字母：你打 ${raw.trim()}，正確是 ${it.answer}`);
  }
  S.wrongTyped = raw.trim();
  record(false, 0);
}

function onKey(e) {
  if (!S || S.match) return;
  if (document.querySelector("dialog[open]")) return;
  const typing = e.target.matches("input, textarea");
  const it = S.item;
  if (!S.answered && (it.type === "mcEn" || it.type === "mcZh") && /^[1-4]$/.test(e.key) && !typing) {
    e.preventDefault();
    choose(Number(e.key) - 1);
  } else if (S.answered && e.key === "Enter" && !typing) {
    e.preventDefault();
    advance();
  }
}

function choose(i) {
  if (!S || S.answered) return;
  S.chosen = i;
  const ok = i === S.item.answer;
  record(ok, ok ? 4 : 0);
}

/* =========================================================================
   畫面
   ========================================================================= */

function topHTML() {
  const total = S.queue.length;
  const dots = S.queue.map((q, i) => {
    let cls = i === S.idx ? "now" : "";
    if (q.result !== undefined) cls = q.result ? "ok" : "bad";
    if (q.retry) cls += " retry";
    return `<i class="${cls}"></i>`;
  }).join("");
  return `<div class="sr-top"><div class="sr-dots">${dots}</div>
          <span class="muted">${Math.min(S.idx + 1, total)} / ${total}</span>
          <button class="btn sm ghost qz-quit" type="button">結束</button></div>`;
}

const TYPE_LABEL = { mcEn: "看英選中", mcZh: "看中選英", cloze: "例句填空", spell: "拼字", listen: "聽寫" };

function promptHTML(it) {
  const c = it.card;
  const pos = c.pos ? `<span class="sr-pos">${esc(c.pos)}</span>` : "";
  if (it.type === "mcEn") return `<div class="qz-big">${esc(c.word)}</div>
      ${c.phonetic ? `<div class="qz-sub">${esc(c.phonetic)}</div>` : ""}
      <button class="mini qz-say" type="button">🔊 聽發音</button>`;
  if (it.type === "mcZh" || it.type === "spell") return `<div class="qz-big zh">${esc(c.zh || "（沒有中文）")}${pos}</div>`;
  if (it.type === "listen") return `<div class="qz-sub">聽發音，拼出這個字</div>
      <div class="qz-listen"><button class="sr-mic qz-say" type="button">🔊 再聽一次</button>
      <button class="mini qz-slow" type="button">🐢 慢速</button></div>`;
  if (it.type === "cloze") {
    const blank = S.answered ? `<b class="qz-fill ${S.lastOk ? "ok" : "bad"}">${esc(it.answer)}</b>`
      : `<span class="qz-blank">${"＿".repeat(Math.min(8, Math.max(3, it.answer.length / 1.5 | 0)))}</span>`;
    return `<div class="qz-cloze">${esc(it.cloze.before)}${blank}${esc(it.cloze.after)}</div>
      ${c.exampleZh ? `<div class="qz-sub">${esc(c.exampleZh)}</div>` : ""}`;
  }
  return "";
}

/** 提示是累加的：填空題先給意思、再一個一個給字母；拼字題直接給字母 */
function hintHTML(it) {
  if (!S.hints) return "";
  const parts = [];
  if (it.type === "cloze") parts.push(`<div class="sr-hint">意思：<b>${esc(it.card.zh || "？")}</b></div>`);
  const n = it.type === "cloze" ? S.hints - 1 : S.hints;
  if (n > 0) {
    const letters = it.answer.split("").map((ch, i) => (ch === " " || i < n ? ch : "_")).join(" ");
    parts.push(`<div class="sr-hint"><code>${esc(letters)}</code></div>`);
  }
  return parts.join("");
}

function paint() {
  const it = S.item;
  const c = it.card;
  const isMC = it.type === "mcEn" || it.type === "mcZh";
  const retryTag = S.queue[S.idx].retry ? `<span class="qz-retry">再考一次</span>` : "";

  let body = "";
  if (isMC) {
    body = `<div class="qz-opts">${it.options.map((o, i) => {
      let cls = "";
      if (S.answered) cls = i === it.answer ? "ok" : (i === S.chosen ? "bad" : "dim");
      return `<button class="qz-opt ${cls}" type="button" data-i="${i}" ${S.answered ? "disabled" : ""}>
        <kbd>${i + 1}</kbd><span>${esc(o)}</span></button>`;
    }).join("")}</div>`;
  } else {
    const ph = S.answered
      ? (S.lastOk ? "" : "照著正確答案打一次，加深印象（可略過）")
      : (it.type === "cloze" ? "填入空格的字，按 Enter" : "輸入英文，按 Enter");
    body = `<form class="qz-form">
        <input type="text" class="qz-input" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="${ph}" ${S.answered && S.lastOk ? "disabled" : ""}>
      </form>
      ${!S.answered ? `<div class="sr-sub"><button class="mini qz-hint" type="button">💡 提示</button>
        <button class="mini qz-giveup" type="button">不會，看答案</button></div>` : ""}
      ${!S.answered ? hintHTML(it) : ""}`;
  }

  let result = "";
  if (S.answered) {
    const verdict = S.lastOk ? (S.note ? "✓ 差一點，算你對" : "✓ 答對了") : "✗ 這題沒答對";
    result = `
      <div class="qz-result ${S.lastOk ? "pass" : "fail"}">
        <div class="sr-verdict">${verdict}</div>
        ${S.note ? `<div class="qz-note">${esc(S.note)}</div>` : ""}
        ${!S.lastOk && S.wrongTyped ? `<div class="qz-note">你打的是：<s>${esc(S.wrongTyped)}</s></div>` : ""}
        <div class="sr-answer"><span class="sr-word">${esc(c.word)}</span>
          ${c.phonetic ? `<span class="wp-ipa">${esc(c.phonetic)}</span>` : ""}
          <span class="sr-zh">${esc(c.zh || "")}</span></div>
        ${c.example && it.type !== "cloze" ? `<div class="sr-ex">${esc(c.example)}</div>` : ""}
        <div class="sr-actions">
          <button class="mini qz-say2" type="button">🔊</button>
          ${c.example ? `<button class="mini qz-shadow" type="button">🎤 跟讀例句</button>` : ""}
          <div class="spacer"></div>
          <button class="btn primary qz-next" type="button">${S.idx + 1 >= S.queue.length ? "看結果" : "下一題"} ⏎</button>
        </div>
      </div>`;
  }

  // 還沒作答前整張卡不能點字查詢，不然等於偷看答案
  hooks.stage.innerHTML = `${topHTML()}
    <div class="sr-card qz-card ${S.answered ? "" : "no-lookup"}">
      <div class="qz-type">${TYPE_LABEL[it.type]}${retryTag}</div>
      ${promptHTML(it)}
      ${body}
      ${result}
    </div>`;

  const $ = (s) => hooks.stage.querySelector(s);
  $(".qz-quit").addEventListener("click", () => finish(true));
  hooks.stage.querySelectorAll(".qz-say, .qz-say2").forEach(b =>
    b.addEventListener("click", () => TTS.speak(c.word, undefined, null)));
  const slow = $(".qz-slow");
  if (slow) slow.addEventListener("click", () => TTS.speak(c.word, undefined, null, 0.6));
  hooks.stage.querySelectorAll(".qz-opt").forEach(b =>
    b.addEventListener("click", () => choose(Number(b.dataset.i))));
  const form = $(".qz-form");
  if (form) {
    const input = $(".qz-input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!S.answered) return submitTyped(input.value);
      // 答錯後照打一次：對了就綠一下再前進；空白直接前進
      if (!input.value.trim() || norm(input.value) === norm(it.answer)) {
        if (input.value.trim()) input.classList.add("ok");
        setTimeout(advance, input.value.trim() ? 350 : 0);
      } else {
        input.classList.add("shake");
        setTimeout(() => input.classList.remove("shake"), 400);
      }
    });
    if (!input.disabled) setTimeout(() => input.focus(), 30);
  }
  const hint = $(".qz-hint");
  if (hint) hint.addEventListener("click", () => {
    const max = it.answer.length + (it.type === "cloze" ? 1 : 0);
    if (S.hints < max) S.hints++;
    const val = $(".qz-input").value;
    paint();
    $(".qz-input").value = val;
  });
  const giveup = $(".qz-giveup");
  if (giveup) giveup.addEventListener("click", () => { S.wrongTyped = ""; record(false, 0); });
  const nx = $(".qz-next");
  if (nx) {
    nx.addEventListener("click", advance);
    if (isMC || S.lastOk) nx.focus();
  }
  const sh = $(".qz-shadow");
  if (sh) sh.addEventListener("click", () => openShadow(c.example));
}

function finish(early = false) {
  if (!S) return;
  const res = S.results;
  const ok = res.filter(r => r.ok).length;
  const wrong = res.filter(r => !r.ok);
  const wrongCards = wrong.map(r => vocab().find(v => v.word === r.word)).filter(Boolean);
  stopQuiz();
  hooks.stage.innerHTML = `
    <div class="sr-card sr-summary">
      <div class="sr-verdict">${early ? "這輪先到這裡" : "這輪完成 🎉"}</div>
      <div class="sr-nums">
        <div><b>${res.length}</b><span>題</span></div>
        <div><b>${res.length ? Math.round(ok / res.length * 100) : 0}%</b><span>答對率</span></div>
        <div><b>${wrong.length}</b><span>要再練</span></div>
      </div>
      ${res.length ? `<div class="sr-list">${res.map(r =>
        `<span class="chip ${r.ok ? "syn" : "ant"}">${esc(r.word)}<i>${esc(r.zh || "")}</i></span>`).join("")}</div>` : ""}
      <div class="sr-actions">
        <button class="btn primary qz-again" type="button">再來一輪</button>
        ${wrongCards.length ? `<button class="btn qz-wrong" type="button">專攻答錯的 ${wrongCards.length} 個字</button>` : ""}
        <button class="btn ghost qz-home" type="button">回複習首頁</button>
      </div>
    </div>`;
  const $ = (s) => hooks.stage.querySelector(s);
  $(".qz-again").addEventListener("click", () => hooks.onDone("again"));
  $(".qz-home").addEventListener("click", () => hooks.onDone("home"));
  const w = $(".qz-wrong");
  if (w) w.addEventListener("click", () => startQuiz("mixed", wrongCards));
  hooks.onDone("finished");
}

/* =========================================================================
   🎮 配對遊戲（不影響複習排程）
   ========================================================================= */

function startMatch(cards) {
  const pick = shuffle(cards.filter(c => c.zh).slice()).slice(0, 6);
  if (pick.length < 3) {
    hooks.toast("配對遊戲至少要 3 個有中文的字");
    hooks.onDone("home");
    return;
  }
  const left = shuffle(pick.map(c => ({ id: c.id, text: c.word, side: "en" })));
  const right = shuffle(pick.map(c => ({ id: c.id, text: c.zh, side: "zh" })));
  S = { match: true, pick, left, right, sel: null, done: new Set(), mistakes: 0, start: Date.now(), timer: null };
  paintMatch();
  S.timer = setInterval(() => {
    const t = hooks.stage.querySelector(".mt-time");
    if (t && S) t.textContent = ((Date.now() - S.start) / 1000).toFixed(1) + " 秒";
  }, 100);
}

function paintMatch() {
  const col = (arr) => arr.map(x => {
    const done = S.done.has(x.id);
    const sel = S.sel && S.sel.id === x.id && S.sel.side === x.side;
    return `<button type="button" class="mt-tile ${done ? "done" : ""} ${sel ? "sel" : ""}"
      data-id="${x.id}" data-side="${x.side}" ${done ? "disabled" : ""}>${esc(x.text)}</button>`;
  }).join("");
  const best = settings().matchBest;
  hooks.stage.innerHTML = `
    <div class="sr-top"><span class="mt-time">0.0 秒</span>
      <span class="muted">${best ? `最佳 ${best.toFixed(1)} 秒` : ""}</span>
      <button class="btn sm ghost qz-quit" type="button">結束</button></div>
    <div class="sr-card mt-board no-lookup">
      <div class="mt-col">${col(S.left)}</div>
      <div class="mt-col">${col(S.right)}</div>
    </div>
    <p class="note" style="text-align:center">暖身遊戲，不影響複習排程。</p>`;
  hooks.stage.querySelector(".qz-quit").addEventListener("click", () => { stopQuiz(); hooks.onDone("home"); });
  hooks.stage.querySelectorAll(".mt-tile").forEach(b => b.addEventListener("click", () => tapTile(b)));
}

function tapTile(btn) {
  if (!S || !S.match) return;
  const id = btn.dataset.id, side = btn.dataset.side;
  if (!S.sel || S.sel.side === side) {
    S.sel = { id, side };
    paintMatch();
    return;
  }
  if (S.sel.id === id) {
    S.done.add(id);
    S.sel = null;
    if (S.done.size === S.pick.length) return finishMatch();
    paintMatch();
  } else {
    S.mistakes++;
    S.sel = null;
    paintMatch();
    const t = hooks.stage.querySelector(`.mt-tile[data-id="${id}"][data-side="${side}"]`);
    if (t) { t.classList.add("shake"); }
  }
}

function finishMatch() {
  const secs = (Date.now() - S.start) / 1000 + S.mistakes * 1;   // 配錯一次加 1 秒
  const s = settings();
  const isBest = !s.matchBest || secs < s.matchBest;
  if (isBest) { s.matchBest = secs; save(); }
  const mistakes = S.mistakes;
  stopQuiz();
  hooks.stage.innerHTML = `
    <div class="sr-card sr-summary">
      <div class="sr-verdict">${isBest ? "🏆 新紀錄！" : "完成！"}</div>
      <div class="sr-nums">
        <div><b>${secs.toFixed(1)}</b><span>秒（含罰秒）</span></div>
        <div><b>${mistakes}</b><span>配錯</span></div>
        <div><b>${s.matchBest.toFixed(1)}</b><span>最佳紀錄</span></div>
      </div>
      <div class="sr-actions">
        <button class="btn primary qz-again" type="button">再玩一次</button>
        <button class="btn ghost qz-home" type="button">回複習首頁</button>
      </div>
    </div>`;
  hooks.stage.querySelector(".qz-again").addEventListener("click", () => hooks.onDone("again"));
  hooks.stage.querySelector(".qz-home").addEventListener("click", () => hooks.onDone("home"));
}

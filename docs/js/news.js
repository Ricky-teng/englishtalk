/**
 * news.js — 每日新聞
 *
 * 文章是維基百科條目的原文（docs/news/，由 tools/news/build_news.py 每天產生），不經 AI 改寫，
 * 所以內容跟維基百科一樣、附固定版本連結。生字與閱讀測驗由 AI 出，產生時已經自動核對過
 * （生字一定在文章裡、每題的依據原句一定在文章裡、AI 重新作答要一致）。
 *
 * 覺得太難可以按「AI 簡化版」：用使用者自己的金鑰改寫，畫面會清楚標示「可能有錯，以原文為準」。
 */

import * as Store from "./store.js";
import * as V from "./vocab.js";
import { complete } from "./llm.js";
import * as TTS from "./tts.js";
import { openShadow } from "./shadow.js";

const LEVELS = ["A2", "B1", "B2", "C1"];
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let hooks = { toast: () => {}, onVocabChanged: () => {}, chatAbout: () => {}, root: null };
let index = null;                 // news/index.json
const cache = new Map();          // 日期 → 文章
let cur = null;                   // 目前看的文章
let view = { level: "", simple: false, quiz: false, busy: false, lines: false, reading: false, readAt: -1, sumBusy: false };

export function initNews(h) { hooks = { ...hooks, ...h }; }

/** 這台裝置的閱讀紀錄：{ "2026-11-23": {read, score, picked:[...]} } */
function log() {
  const st = Store.load();
  if (!st.news || typeof st.news !== "object") st.news = {};
  return st.news;
}

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status === 404 ? "還沒有新聞" : `讀取失敗（${r.status}）`);
  return r.json();
}

async function loadIndex() {
  index = await getJSON("news/index.json");
  return index;
}

async function loadDay(date) {
  if (!cache.has(date)) cache.set(date, await getJSON(`news/${date}.json`));
  return cache.get(date);
}

/** 台灣時間的今天（跟產生新聞用同一個日期） */
function todayTW() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/** 閱讀統計：連續天數（今天還沒讀就從昨天算起）、讀過幾篇、測驗答對率 */
export function newsStats() {
  const L = log();
  const days = Object.keys(L).filter(d => L[d] && L[d].read).sort();
  const set = new Set(days);
  let streak = 0;
  let d = new Date(todayTW() + "T00:00:00Z");
  if (!set.has(d.toISOString().slice(0, 10))) d = new Date(d.getTime() - 864e5);
  while (set.has(d.toISOString().slice(0, 10))) { streak++; d = new Date(d.getTime() - 864e5); }
  const scored = days.filter(x => L[x].score != null);
  const right = scored.reduce((a, x) => a + L[x].score, 0);
  return { streak, total: days.length, quizzes: scored.length, rate: scored.length ? right / (scored.length * 3) : null };
}

/** 有沒有今天還沒讀的新聞（分頁上的「新」） */
export async function hasUnread() {
  try {
    const idx = index || await loadIndex();
    const top = idx.items && idx.items[0];
    return !!(top && !(log()[top.date] && log()[top.date].read));
  } catch (e) { return false; }
}

export async function renderNews(date = null) {
  const root = hooks.root;
  if (!root) return;
  if (!cur) root.innerHTML = `<p class="muted note">載入中…</p>`;
  try {
    await loadIndex();
  } catch (e) {
    root.innerHTML = `<div class="empty"><div class="e-big">還沒有新聞</div><div>每天早上會更新一篇。</div></div>`;
    return;
  }
  const items = index.items || [];
  if (!items.length) {
    root.innerHTML = `<div class="empty"><div class="e-big">還沒有新聞</div><div>每天早上會更新一篇。</div></div>`;
    return;
  }
  const want = date || (cur && cur.date) || items[0].date;
  try {
    cur = await loadDay(want);
  } catch (e) {
    root.innerHTML = `<p class="note">讀取失敗：${esc(e.message)}</p>`;
    return;
  }
  if (!view.level) view.level = LEVELS.includes(Store.settings().level) ? Store.settings().level : "B1";
  paint();
}

/* ---------- 畫面 ---------- */

/** 段落切成句子（朗讀、逐句跟讀用）；縮寫像 U.S.、名字縮寫 L. 不切開 */
function sentences(p) {
  return p.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/).map(s => s.trim()).filter(Boolean)
    .reduce((out, s) => {
      // 前一句以常見縮寫結尾（Mr. Dr. U.S. etc.）就接回去
      // 英文名字的縮寫（Manni L. Perez）也一樣
      if (out.length && /(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc|No|U\.S|U\.K|[A-Z]))\.$/.test(out[out.length - 1])) out[out.length - 1] += " " + s;
      else out.push(s);
      return out;
    }, []);
}

function vocabFor(level) {
  const v = (cur.vocab && cur.vocab[level]) || [];
  return v.filter(x => x && x.w);
}

/** 段落裡把生字標出來（每個字只標第一次出現） */
function markParas(paras, words) {
  const left = new Set(words.map(w => w.toLowerCase()));
  let n = 0;
  return paras.map(p => {
    let html = sentences(p).map(s => `<span class="ns" data-s="${n++}">${esc(s)}</span>`).join(" ");
    for (const w of words) {
      if (!left.has(w.toLowerCase())) continue;
      // (?![^<]*>) ：不要比對到 HTML 標籤裡面（例如 class="ns"）
      const re = new RegExp(`(^|[^A-Za-z])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![A-Za-z])(?![^<]*>)`, "i");
      if (re.test(html)) {
        html = html.replace(re, (m, a, b) => `${a}<mark class="nw">${b}</mark>`);
        left.delete(w.toLowerCase());
      }
    }
    return `<p>${html}</p>`;
  }).join("");
}

function fmtDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  const wk = "日一二三四五六"[new Date(y, m - 1, day).getDay()];
  return `${m}/${day}（${wk}）`;
}

function paint() {
  const root = hooks.root;
  const rec = log()[cur.date] || {};
  const words = vocabFor(view.level);
  const simpleKey = `englishtalk.newsSimple.${cur.date}.${view.level}`;
  let simple = null;
  try { simple = JSON.parse(localStorage.getItem(simpleKey) || "null"); } catch (e) {}
  const showSimple = view.simple && simple;
  const have = new Set(Store.vocab().map(v => v.word.toLowerCase()));
  const items = (index.items || []);

  root.innerHTML = `
    <div class="nw-head">
      <span class="nw-date">${fmtDate(cur.date)}</span>
      <span class="tag">${cur.region === "taiwan" ? "台灣" : "國際"}</span>
      <span class="tag">${cur.words} 字</span>
      ${rec.score != null ? `<span class="tag spoken">測驗 ${rec.score}/3</span>` : ""}
      <div class="spacer"></div>
      ${(() => { const st = newsStats(); return st.total ? `<span class="nw-streak" title="連續閱讀天數／讀過幾篇">🔥 ${st.streak} 天・${st.total} 篇</span>` : ""; })()}
    </div>
    <h2 class="nw-title">${esc(cur.title)}</h2>

    <div class="nw-tools">
      <label class="nw-lv">生字程度
        <select data-level>${LEVELS.map(l => `<option ${l === view.level ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
      <div class="spacer"></div>
      ${showSimple
        ? `<button class="btn sm" type="button" data-orig>看原文</button>`
        : `<button class="btn sm ghost" type="button" data-simple ${view.busy ? "disabled" : ""}>${view.busy ? "改寫中…" : "太難？AI 簡化版"}</button>`}
    </div>
    <div class="nw-tools">
      <button class="btn sm ${view.reading ? "primary" : ""}" type="button" data-read>${view.reading ? "⏹ 停止" : "🔊 朗讀全文"}</button>
      <button class="btn sm ${view.lines ? "primary" : "ghost"}" type="button" data-lines>${view.lines ? "看整篇" : "逐句跟讀"}</button>
    </div>

    ${showSimple ? `<div class="nw-warn">這是 AI 依你的程度改寫的版本，可能有錯，內容以原文為準。</div>` : ""}
    ${view.lines
      ? `<ol class="nw-lines ${showSimple ? "simple" : ""}">${(showSimple ? simple : cur.paragraphs).flatMap(sentences).map((s, i) => `
          <li><span class="ns" data-s="${i}">${esc(s)}</span>
            <span class="nl-acts"><button class="mini" type="button" data-say="${i}" aria-label="唸這句">🔊</button>
            <button class="mini" type="button" data-shadow="${i}">🎤 跟讀</button></span></li>`).join("")}</ol>`
      : `<article class="nw-body ${showSimple ? "simple" : ""}">${markParas(showSimple ? simple : cur.paragraphs, words.map(x => x.w))}</article>`}

    <p class="nw-src">原文：Wikipedia〈<a href="${esc(cur.source.url)}" target="_blank" rel="noopener">${esc(cur.source.title)}</a>〉
      ${esc(cur.source.revisedAt.slice(0, 10))} 版本・<a href="${esc(cur.source.licenseUrl)}" target="_blank" rel="noopener">${esc(cur.source.license)}</a>。
      點文章裡的任何字都可以查。</p>

    <section class="card nw-vocab">
      <div class="nw-sec-head"><h3>生字（${esc(view.level)}）</h3>
        ${words.some(x => !have.has(x.lemma.toLowerCase())) ? `<button class="btn sm" type="button" data-addall>全部加入</button>` : ""}</div>
      ${words.length ? words.map((x, i) => {
        const inBook = have.has(x.lemma.toLowerCase());
        return `<div class="nw-word">
          <div><b>${esc(x.lemma)}</b>${x.lemma.toLowerCase() !== x.w.toLowerCase() ? `<small class="muted">（文中：${esc(x.w)}）</small>` : ""}
            <div class="muted">${x.pos ? `<span class="sense-pos">${esc(x.pos)}</span>` : ""}${esc(x.zh)}</div></div>
          <button class="btn sm ${inBook ? "" : "primary"}" type="button" data-add="${i}" ${inBook ? "disabled" : ""}>${inBook ? "✓ 已加入" : "＋ 加入"}</button>
        </div>`;
      }).join("") : `<p class="muted note">這個程度沒有挑到生字。</p>`}
    </section>

    <section class="card nw-quiz">
      <h3>閱讀測驗</h3>
      ${view.quiz || rec.answers ? quizHTML(rec) : `<p class="muted note">讀完再做，3 題。</p>
        <button class="btn primary" type="button" data-startquiz>我讀完了</button>`}
    </section>

    <section class="card nw-sum">
      <h3>用英文寫一兩句摘要</h3>
      ${rec.summary && rec.summary.fb ? summaryHTML(rec.summary) : `
        <textarea class="nw-sumtext" rows="3" placeholder="例：A new video game broke sales records when it came out this week.">${esc((rec.summary && rec.summary.text) || "")}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn sm primary" type="button" data-sum ${view.sumBusy ? "disabled" : ""}>${view.sumBusy ? "批改中…" : "送出批改"}</button>
          <span class="note" style="margin:0">AI 批改，會用到你的 API 額度。</span></div>`}
    </section>

    <section class="card nw-chat">
      <h3>跟 AI 聊這則新聞</h3>
      <p class="muted note">用說的聊，AI 會問你的看法，也會用到今天的生字。</p>
      <button class="btn" type="button" data-chat>💬 開始聊</button>
    </section>

    ${items.length > 1 ? `<details class="card nw-past"><summary>以前的新聞</summary>
      <div class="nw-list">${items.map(x => {
        const r = log()[x.date] || {};
        return `<button type="button" class="nw-item ${x.date === cur.date ? "on" : ""}" data-day="${esc(x.date)}">
          <span class="nw-date">${fmtDate(x.date)}</span><span class="nw-t">${esc(x.title)}</span>
          <span class="muted">${r.score != null ? `${r.score}/3` : r.read ? "讀過" : ""}</span></button>`;
      }).join("")}</div></details>` : ""}`;

  bind(simpleKey);
}

function quizHTML(rec) {
  const ans = rec.answers || [];
  return cur.questions.map((q, i) => {
    const picked = ans[i];
    const done = picked != null;
    return `<div class="nq ${done ? (picked === q.answer ? "ok" : "bad") : ""}">
      <p class="nq-q"><b>${i + 1}.</b> ${esc(q.q)}</p>
      <div class="nq-opts">${q.options.map((o, j) => {
        let cls = "";
        if (done) cls = j === q.answer ? "ok" : j === picked ? "bad" : "dim";
        return `<button type="button" class="qz-opt ${cls}" data-q="${i}" data-o="${j}" ${done ? "disabled" : ""}>
          <kbd>${"ABCD"[j]}</kbd><span>${esc(o)}</span></button>`;
      }).join("")}</div>
      ${done ? `<div class="nq-why">${picked === q.answer ? "✓ 答對" : "✗ 答錯"}${q.why ? `：${esc(q.why)}` : ""}
        <blockquote>${esc(q.evidence)}</blockquote></div>` : ""}
    </div>`;
  }).join("") + (ans.filter(x => x != null).length === cur.questions.length
    ? `<p class="nq-score">答對 ${rec.score}/${cur.questions.length}</p>` : "");
}

function summaryHTML(sm) {
  const fb = sm.fb;
  return `<p class="nw-mine">${esc(sm.text)}</p>
    <div class="nw-fb ${fb.accurate ? "ok" : "warn"}">
      <p><b>${fb.accurate ? "✓ 內容符合文章" : "⚠ 跟文章有出入"}</b>${fb.note ? `：${esc(fb.note)}` : ""}</p>
      ${fb.corrected && fb.corrected !== sm.text ? `<p><span class="muted">文法修正</span><br>${esc(fb.corrected)}</p>` : ""}
      ${fb.better ? `<p><span class="muted">更自然的寫法</span><br>${esc(fb.better)}</p>` : ""}
      <p class="note" style="margin:6px 0 0">AI 批改，僅供參考。</p>
    </div>
    <button class="btn sm ghost" type="button" data-sumagain>再寫一次</button>`;
}

async function reviewSummary(text) {
  const prompt = `A Taiwanese English learner (level ${view.level}) read this news article and wrote a short summary.
Article:
"""${cur.paragraphs.join("\n\n")}"""
Learner's summary: """${text}"""
Check it. Return ONLY JSON:
{"accurate": true|false (does it match the article's facts and main point?),
 "note": "one short sentence in Traditional Chinese (Taiwan usage): what's good or what doesn't match the article",
 "corrected": "the learner's summary with only grammar/word mistakes fixed (keep their meaning and wording otherwise; same text if no mistakes)",
 "better": "a more natural 1–2 sentence summary at about ${view.level} level, using only facts from the article"}`;
  const raw = await complete(prompt, { json: true, maxTokens: 600, geminiJson: true, purpose: "grammar" });
  const d = JSON.parse(String(raw).replace(/^```(json)?|```$/g, "").trim());
  return { accurate: d.accurate === true, note: String(d.note || ""), corrected: String(d.corrected || ""), better: String(d.better || "") };
}

/** 朗讀：一句一句唸，唸到哪句就標到哪句 */
async function readAll() {
  const els = [...hooks.root.querySelectorAll(".ns")];
  view.reading = true;
  for (let i = Math.max(0, view.readAt); i < els.length && view.reading; i++) {
    view.readAt = i;
    hooks.root.querySelectorAll(".ns.speaking").forEach(x => x.classList.remove("speaking"));
    const el = hooks.root.querySelector(`.ns[data-s="${i}"]`);
    if (!el) break;
    el.classList.add("speaking");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await TTS.speak(el.textContent, undefined, null);
  }
  const finished = view.reading;
  view.reading = false;
  view.readAt = -1;
  hooks.root.querySelectorAll(".ns.speaking").forEach(x => x.classList.remove("speaking"));
  if (finished) markRead();
  paintTools();
}

/** 只重畫朗讀按鈕（不打斷正在唸的那句） */
function paintTools() {
  const b = hooks.root.querySelector("[data-read]");
  if (!b) return;
  b.textContent = view.reading ? "⏹ 停止" : "🔊 朗讀全文";
  b.classList.toggle("primary", view.reading);
}

function markRead() {
  const r = (log()[cur.date] ||= {});
  if (!r.read) { r.read = true; Store.save(true); hooks.onVocabChanged(); }
}

function stopReading() {
  if (!view.reading) return;
  view.reading = false;
  TTS.stop();
}

/** 離開新聞分頁時呼叫：停止朗讀 */
export function leaveNews() { stopReading(); view.readAt = -1; }

function bind(simpleKey) {
  const root = hooks.root;
  const $ = (s) => root.querySelector(s);
  const rec = () => (log()[cur.date] ||= {});

  $("[data-level]").addEventListener("change", (e) => { view.level = e.target.value; paint(); });

  const orig = $("[data-orig]");
  if (orig) orig.addEventListener("click", () => { view.simple = false; paint(); });
  const simp = $("[data-simple]");
  if (simp) simp.addEventListener("click", async () => {
    try {
      if (localStorage.getItem(simpleKey)) { view.simple = true; paint(); return; }
    } catch (e) {}
    const s = Store.settings();
    if (!(s.provider === "groq" ? s.groqKey : s.geminiKey)) { hooks.toast("要先到設定填 API 金鑰"); return; }
    view.busy = true; paint();
    try {
      const paras = await simplify(cur.paragraphs, view.level, vocabFor(view.level).map(x => x.w));
      try { localStorage.setItem(simpleKey, JSON.stringify(paras)); } catch (e) {}
      view.simple = true;
    } catch (e) {
      hooks.toast("改寫失敗：" + e.message);
    }
    view.busy = false; paint();
  });

  const addOne = (x) => V.add(x.lemma, {
    pos: x.pos === "phr." ? "" : x.pos, zh: x.zh,
    // 例句是另外造的一般句子（不是新聞原文）；沒有的話之後「自動補齊」會補
    example: x.ex || "", exampleZh: x.exZh || "", tags: [`新聞-${cur.date}`],
  });
  root.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => {
    const x = vocabFor(view.level)[Number(b.dataset.add)];
    if (!x) return;
    addOne(x);
    Store.save(true);
    hooks.toast(`已加入 ${x.lemma}`);
    hooks.onVocabChanged();
    paint();
  }));
  const all = $("[data-addall]");
  if (all) all.addEventListener("click", () => {
    let n = 0;
    for (const x of vocabFor(view.level)) if (addOne(x).isNew) n++;
    Store.save(true);
    hooks.toast(n ? `加入了 ${n} 個字` : "都已經在單字本裡");
    hooks.onVocabChanged();
    paint();
  });

  $("[data-read]").addEventListener("click", () => {
    if (view.reading) { stopReading(); paintTools(); return; }
    readAll();
  });
  $("[data-lines]").addEventListener("click", () => { stopReading(); view.readAt = -1; view.lines = !view.lines; paint(); });
  const lineText = (i) => { const el = root.querySelector(`.ns[data-s="${i}"]`); return el ? el.textContent : ""; };
  root.querySelectorAll("[data-say]").forEach(b => b.addEventListener("click", () => { stopReading(); TTS.stop(); TTS.speak(lineText(b.dataset.say), undefined, null); }));
  root.querySelectorAll("[data-shadow]").forEach(b => b.addEventListener("click", () => { stopReading(); markRead(); openShadow(lineText(b.dataset.shadow)); }));

  const sumBtn = $("[data-sum]");
  if (sumBtn) sumBtn.addEventListener("click", async () => {
    const text = $(".nw-sumtext").value.trim();
    if (text.split(/\s+/).length < 4) { hooks.toast("至少寫一句完整的英文"); return; }
    const s = Store.settings();
    if (!(s.provider === "groq" ? s.groqKey : s.geminiKey)) { hooks.toast("請先到設定填 API 金鑰"); return; }
    rec().summary = { text };
    view.sumBusy = true; paint();
    try {
      rec().summary = { text, fb: await reviewSummary(text), at: Date.now() };
      markRead();
    } catch (e) {
      hooks.toast("批改失敗：" + e.message);
    }
    view.sumBusy = false;
    Store.save(true);
    paint();
  });
  const again = $("[data-sumagain]");
  if (again) again.addEventListener("click", () => { rec().summary = { text: rec().summary.text }; paint(); });

  $("[data-chat]").addEventListener("click", () => {
    stopReading();
    markRead();
    hooks.chatAbout({
      title: cur.title,
      text: cur.paragraphs.join("\n\n").slice(0, 3000),
      words: vocabFor(view.level).map(x => x.lemma),
    });
  });

  const sq = $("[data-startquiz]");
  if (sq) sq.addEventListener("click", () => {
    view.quiz = true;
    rec().read = true;
    Store.save(true);
    hooks.onVocabChanged();   // 更新分頁上的「新」
    paint();
    hooks.root.querySelector(".nw-quiz").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  root.querySelectorAll(".nq .qz-opt").forEach(b => b.addEventListener("click", () => {
    const r = rec();
    r.read = true;
    r.answers = r.answers || [];
    r.answers[Number(b.dataset.q)] = Number(b.dataset.o);
    const done = r.answers.filter(x => x != null).length;
    if (done === cur.questions.length) {
      r.score = cur.questions.reduce((a, q, i) => a + (r.answers[i] === q.answer ? 1 : 0), 0);
      r.at = Date.now();
    }
    Store.save(true);
    paint();
  }));

  root.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    stopReading(); view.readAt = -1;
    view.quiz = false; view.simple = false; view.lines = false;
    renderNews(b.dataset.day);
    hooks.root.closest(".scroll").scrollTop = 0;
  }));
}

/* ---------- AI 簡化版（使用者自己的金鑰） ---------- */

async function simplify(paras, level, keep) {
  const target = level === "C1" ? "B2" : level === "B2" ? "B1" : "A2";
  const prompt = `Rewrite this news text in simpler English for a CEFR ${target} learner.
STRICT RULES:
- Keep every fact exactly as in the original: names, numbers, dates, places, who did what.
- Do NOT add any information, explanation, background, opinion or guess that is not in the text.
- If a sentence can't be simplified without changing its meaning, keep it as it is.
- Keep these words somewhere in the text if they appear in the original: ${keep.join(", ") || "(none)"}.
- Keep the same paragraph structure. Return ONLY JSON: {"paragraphs": ["...", "..."]}

Original:
${paras.join("\n\n")}`;
  const raw = await complete(prompt, { json: true, maxTokens: 2400, geminiJson: true, purpose: "lookup" });
  let d = null;
  try { d = JSON.parse(String(raw).replace(/^```(json)?|```$/g, "").trim()); } catch (e) {}
  const out = d && Array.isArray(d.paragraphs) ? d.paragraphs.map(s => String(s).trim()).filter(Boolean) : null;
  if (!out || !out.length) throw new Error("模型沒有回傳文章");
  return out;
}

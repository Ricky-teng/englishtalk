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

const LEVELS = ["A2", "B1", "B2", "C1"];
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let hooks = { toast: () => {}, onVocabChanged: () => {}, root: null };
let index = null;                 // news/index.json
const cache = new Map();          // 日期 → 文章
let cur = null;                   // 目前看的文章
let view = { level: "", simple: false, quiz: false, busy: false };

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

function vocabFor(level) {
  const v = (cur.vocab && cur.vocab[level]) || [];
  return v.filter(x => x && x.w);
}

/** 段落裡把生字標出來（每個字只標第一次出現） */
function markParas(paras, words) {
  const left = new Set(words.map(w => w.toLowerCase()));
  return paras.map(p => {
    let html = esc(p);
    for (const w of words) {
      if (!left.has(w.toLowerCase())) continue;
      const re = new RegExp(`(^|[^A-Za-z])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![A-Za-z])`, "i");
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

    ${showSimple ? `<div class="nw-warn">這是 AI 依你的程度改寫的版本，可能有錯，內容以原文為準。</div>` : ""}
    <article class="nw-body ${showSimple ? "simple" : ""}">${markParas(showSimple ? simple : cur.paragraphs, words.map(x => x.w))}</article>

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
    example: x.ex || "", tags: [`新聞-${cur.date}`],
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
    view.quiz = false; view.simple = false;
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

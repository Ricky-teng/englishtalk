/**
 * lookup.js — 全站點字查詢
 *
 * 網站上任何地方的英文單字都可以點：AI 的話、你自己說的話、單字本、例句、
 * 複習卡背面、挖字結果、對話紀錄、跟讀視窗，連查詢彈窗裡的例句也可以再點。
 *
 * 做法：不把每個字都包成 <span>（那樣要改每一個畫面，而且之後新增的畫面會漏掉），
 * 而是在點擊的當下，用 caretPositionFromPoint 找出游標底下那個文字節點與位置，
 * 往左右延伸出完整的單字。所以不管畫面是什麼時候、用什麼方式畫出來的，都自動支援。
 *
 * 另外：
 *   - 滑鼠移過去會用 CSS Highlight API 淡淡標出那個字（不動 DOM，不影響版面）
 *   - 反白一段 2~4 個字的片語（例如 carry out）會出現「查詢」小按鈕
 *   - 在對話框（dialog）裡點字，彈窗會跟著移進那個對話框，才不會被蓋住
 */

import * as Store from "./store.js";
import * as V from "./vocab.js";
import * as TTS from "./tts.js";
import { openShadow } from "./shadow.js";

let hooks = { toast: () => {}, onVocabChanged: () => {} };
let pop = null;
let bubble = null;
let popWord = "";
let popContext = "";

/* 這些地方不做點字查詢：輸入框、按鈕、連結、設定頁、音標、標籤文字… */
const SKIP = [
  "input", "textarea", "select", "button", "a", "label", "option",
  "[contenteditable]", ".no-lookup", "header", "#dlgSettings",
  ".who", ".wp-ipa", ".vipa", ".fc-ipa", ".badge", ".pill", "code", "kbd",
].join(",");

const WORD_CH = /[A-Za-z'’\-]/;

export function initLookup(h) {
  hooks = { ...hooks, ...h };
  pop = document.getElementById("wordPop");

  bubble = document.createElement("button");
  bubble.className = "sel-bubble";
  bubble.hidden = true;
  bubble.type = "button";
  document.body.appendChild(bubble);
  bubble.addEventListener("mousedown", (e) => e.preventDefault());   // 不要讓點按鈕把反白清掉
  bubble.addEventListener("click", () => {
    const phrase = bubble.dataset.phrase;
    const rect = JSON.parse(bubble.dataset.rect);
    bubble.hidden = true;
    window.getSelection().removeAllRanges();
    openLookup(phrase, { rect, context: bubble.dataset.context || "", anchor: null });
  });

  document.addEventListener("click", onClick);
  document.addEventListener("mousemove", onMove, { passive: true });
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeLookup(); bubble.hidden = true; }
  });
  // 捲動時把浮動元件收起來，免得位置對不上
  document.addEventListener("scroll", () => { bubble.hidden = true; }, true);
}

/* =========================================================================
   找出游標底下的單字
   ========================================================================= */

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/**
 * 回傳 {word, range, rect, node} 或 null。
 * caret API 在空白處也會吸附到最近的字，所以最後還要確認滑鼠真的落在字的方框裡。
 */
export function wordAtPoint(x, y) {
  const c = caretAt(x, y);
  if (!c || !c.node || c.node.nodeType !== Node.TEXT_NODE) return null;
  const el = c.node.parentElement;
  if (!el || el.closest(SKIP)) return null;

  const text = c.node.data;
  let s = c.offset, e = c.offset;
  while (s > 0 && WORD_CH.test(text[s - 1])) s--;
  while (e < text.length && WORD_CH.test(text[e])) e++;
  // 去掉頭尾的撇號與連字號（'hello' → hello）
  while (s < e && /['’\-]/.test(text[s])) s++;
  while (e > s && /['’\-]/.test(text[e - 1])) e--;
  if (e - s < 2) return null;

  let word = text.slice(s, e).replace(/’/g, "'");
  if (/^[A-Z]{2,5}$/.test(word)) return null;          // AI、API、CSV 這類縮寫不查
  if (/'s$/i.test(word)) word = word.slice(0, -2);      // teacher's → teacher

  const range = document.createRange();
  range.setStart(c.node, s);
  range.setEnd(c.node, e);
  const rects = [...range.getClientRects()];
  const pad = 2;
  const inside = rects.some(r => x >= r.left - pad && x <= r.right + pad
                              && y >= r.top - pad && y <= r.bottom + pad);
  if (!inside) return null;
  return { word, range, rect: rects[0], node: c.node };
}

/** 從這個字所在的區塊，抓出它所在的那一句，當作查詢的語境 */
function sentenceAround(node, word) {
  const block = node.parentElement.closest(".body, p, li, .vex, .fc-ex, .wp-ex, .gap-better, .s-line, .sh-target, div") || node.parentElement;
  const all = (block.textContent || "").replace(/\s+/g, " ").trim();
  const parts = all.split(/(?<=[.!?])\s+/);
  const hit = parts.find(p => p.toLowerCase().includes(word.toLowerCase()));
  return (hit || all).slice(0, 300);
}

/* =========================================================================
   事件
   ========================================================================= */

function onClick(e) {
  // 彈窗裡的按鈕自己處理
  if (e.target.closest("#wordPop button, .sel-bubble")) return;

  // 剛剛是拖曳反白，不是單純點一下 —— 交給反白小按鈕
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().includes(" ")) return;

  const hit = wordAtPoint(e.clientX, e.clientY);
  if (hit && pop.contains(hit.node.parentElement)) {
    // 在彈窗裡點例句的字：原地換內容，不要跳位置
    openLookup(hit.word, { context: sentenceAround(hit.node, hit.word) });
    return;
  }
  if (hit) {
    openLookup(hit.word, {
      rect: hit.rect,
      context: sentenceAround(hit.node, hit.word),
      anchor: hit.node.parentElement,
    });
    return;
  }
  if (pop && !pop.hidden && !pop.contains(e.target)) closeLookup();
}

let moveRaf = 0;
let lastCursorEl = null;
function onMove(e) {
  if (moveRaf) return;
  const x = e.clientX, y = e.clientY;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const hit = wordAtPoint(x, y);
    if (lastCursorEl) { lastCursorEl.style.cursor = ""; lastCursorEl = null; }
    if (window.CSS && CSS.highlights) {
      if (hit) CSS.highlights.set("lookup-hover", new Highlight(hit.range));
      else CSS.highlights.delete("lookup-hover");
    }
    if (hit) {
      lastCursorEl = hit.node.parentElement;
      lastCursorEl.style.cursor = "pointer";
    }
  });
}

/** 反白 2~4 個英文字的片語時，顯示「查詢」小按鈕 */
function onMouseUp() {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().replace(/\s+/g, " ").trim() : "";
    if (!text || !/^[A-Za-z][A-Za-z'’\- ]*[A-Za-z]$/.test(text)
        || text.split(" ").length < 2 || text.split(" ").length > 4) {
      bubble.hidden = true;
      return;
    }
    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!host || host.closest(SKIP)) { bubble.hidden = true; return; }

    const r = range.getBoundingClientRect();
    bubble.textContent = `🔍 查詢「${text}」`;
    bubble.dataset.phrase = text;
    bubble.dataset.context = (host.textContent || "").slice(0, 300);
    bubble.dataset.rect = JSON.stringify({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width });
    moveInto(bubble, host);
    bubble.hidden = false;
    const bw = bubble.offsetWidth;
    bubble.style.left = Math.min(Math.max(r.left + r.width / 2 - bw / 2, 8), window.innerWidth - bw - 8) + "px";
    bubble.style.top = Math.max(r.top - 40, 8) + "px";
  }, 0);
}

/** 如果觸發點在一個開著的 <dialog> 裡，就把浮動元件搬進去，才不會被對話框蓋住 */
function moveInto(node, anchor) {
  const d = anchor && anchor.closest ? anchor.closest("dialog[open]") : null;
  const target = d || document.body;
  if (node.parentElement !== target) target.appendChild(node);
}

/* =========================================================================
   彈窗
   ========================================================================= */

export function closeLookup() {
  if (pop) pop.hidden = true;
  if (window.CSS && CSS.highlights) CSS.highlights.delete("lookup-hover");
}

/**
 * 打開查詢彈窗。
 * @param {string} word
 * @param {Object} o  {rect, context, anchor}；在彈窗內部點字時 rect 為 null，彈窗原地換內容
 */
export function openLookup(word, o = {}) {
  if (o.rect) {
    moveInto(pop, o.anchor);
    pop.hidden = false;
    pop.innerHTML = "";
    const pw = pop.offsetWidth || 330;
    const r = o.rect;
    pop.style.left = Math.min(Math.max(r.left - pw / 2 + (r.width || 0) / 2, 12),
                              window.innerWidth - pw - 12) + "px";
    const below = r.bottom + 8;
    pop.style.top = (below + 300 > window.innerHeight ? Math.max(r.top - 300, 12) : below) + "px";
  }
  pop.hidden = false;
  loadWord(word, o.context || "");
}

async function loadWord(word, context) {
  popWord = word;
  popContext = context;
  pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(word)}</span></div>
                   <p class="wp-zh muted">查詢中…</p>`;

  const existing = V.find(word);
  if (existing && existing.zh) { paint(existing, true); return; }

  try {
    const d = await V.lookup(word, context);
    if (popWord !== word) return;
    paint(d, !!V.find(d.word));
  } catch (e) {
    if (popWord !== word) return;
    pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(word)}</span></div>
                     <p class="wp-zh">查詢失敗：${esc(e.message)}</p>
                     <div class="wp-actions">
                       <button class="btn sm ghost" data-act="speak">🔊</button>
                       <button class="btn sm primary" data-act="retry">↻ 重試</button>
                       <button class="btn sm" data-act="addraw">先加入，之後再補</button>
                     </div>`;
    pop.querySelector('[data-act="speak"]').addEventListener("click", () => TTS.speak(word, undefined, null));
    pop.querySelector('[data-act="retry"]').addEventListener("click", () => loadWord(word, context));
    pop.querySelector('[data-act="addraw"]').addEventListener("click", () => {
      V.add(word);
      closeLookup();
      hooks.onVocabChanged(word);
      hooks.toast(`已加入「${word}」`);
    });
  }
}

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

/**
 * 詞形（decided · deciding…）與詞性變化（decision n.、decisive adj.…）。
 * @param {boolean} clickable  彈窗裡可以點，點了原地換成那個字
 * 也給單字本列表與翻卡背面用。
 */
export function formsHTML(d, clickable = true) {
  let forms = Array.isArray(d.forms) ? d.forms : [];
  // 規則動詞的過去式和過去分詞一樣（decided / decided），合成一個省空間
  const past = forms.find(f => f.k === "past"), pp = forms.find(f => f.k === "pp");
  if (past && pp && past.w.toLowerCase() === pp.w.toLowerCase()) {
    forms = forms.filter(f => f !== pp).map(f => f === past ? { k: "pastpp", w: f.w } : f);
  }
  const fam = Array.isArray(d.family) ? d.family : [];
  if (!forms.length && !fam.length) return "";
  const saved = new Set(Store.vocab().map(v => v.word.toLowerCase()));
  const tag = clickable ? "button" : "span";
  const formRow = forms.length ? `<div class="wp-rel wf-row"><span class="wp-rel-label">詞形</span>
      <div class="wf-list">${forms.map(f => `<span class="wf"><small>${esc(f.k === "pastpp" ? "過去式／分詞" : (V.FORM_LABELS[f.k] || f.k))}</small>${esc(f.w)}</span>`).join("")}</div></div>` : "";
  const famRow = fam.length ? `<div class="wp-rel"><span class="wp-rel-label">詞性</span>
      <div class="chips">${fam.map(x => `<${tag} class="chip fam${saved.has(x.w.toLowerCase()) ? " saved" : ""}"${clickable ? ` data-lookup="${esc(x.w)}"` : ""}>`
        + `${x.pos ? `<b class="fam-pos">${esc(x.pos)}</b>` : ""}${esc(x.w)}${x.zh ? `<i>${esc(x.zh)}</i>` : ""}</${tag}>`).join("")}</div></div>` : "";
  return `<div class="wp-forms">${formRow}${famRow}</div>`;
}

function paint(d, already) {
  if (!Array.isArray(d.family)) {
    // 單字本的卡還沒有、但查詢快取已經有 → 直接拿來用，不用再查
    const hit = Store.cacheGet(d.word);
    if (hit && Array.isArray(hit.family)) d = { ...d, forms: hit.forms, family: hit.family };
  }
  const card = V.find(d.word);
  const stats = card && (card.reps || card.produced)
    ? `<div class="wp-stats">複習 ${card.reps || 0} 次 · 說出 ${card.produced || 0} 次${card.due ? ` · 下次 ${card.due}` : ""}</div>`
    : "";

  pop.innerHTML = `
    <div class="wp-head">
      <span class="wp-word">${esc(d.word)}</span>
      ${d.phonetic ? `<span class="wp-ipa">${esc(d.phonetic)}</span>` : ""}
      ${d.pos ? `<span class="wp-pos">${esc(d.pos)}</span>` : ""}
    </div>
    ${(card && V.sensesOf(card).length > 1)
      ? `<ol class="wp-zh senses">${V.sensesOf(card).map(x => `<li>${x.pos ? `<span class="sense-pos">${esc(V.posShort(x.pos))}</span>` : ""}${esc(x.zh)}</li>`).join("")}</ol>`
      : d.zh ? `<p class="wp-zh">${esc(d.zh)}</p>` : ""}
    ${Array.isArray(d.family) ? formsHTML(d) : `<div class="wp-forms wp-forms-wait muted">詞性變化查詢中…</div>`}
    ${d.example ? `<div class="wp-ex">${esc(d.example)}<br><span class="muted">${esc(d.exampleZh || "")}</span></div>` : ""}
    ${relatedHTML("近義", "syn", d.synonyms)}
    ${relatedHTML("反義", "ant", d.antonyms)}
    ${stats}
    <div class="wp-actions">
      <button class="btn sm ghost" data-act="speak" title="唸這個字">🔊</button>
      ${d.example ? `<button class="btn sm ghost" data-act="shadow" title="跟讀例句">🎤 跟讀</button>` : ""}
      <button class="btn sm ghost" data-act="refetch" title="這不是這句話裡的意思？重新查一次">↻</button>
      ${already ? `<button class="btn sm" disabled>已在單字本</button>`
                : `<button class="btn sm primary" data-act="add">加入單字本</button>`}
    </div>`;

  const on = (act, fn) => {
    const b = pop.querySelector(`[data-act="${act}"]`);
    if (b) b.addEventListener("click", fn);
  };
  on("speak", () => TTS.speak(d.word, undefined, null));
  on("shadow", () => { closeLookup(); openShadow(d.example); });
  on("refetch", async () => {
    V.forgetLookup(d.word);
    pop.innerHTML = `<div class="wp-head"><span class="wp-word">${esc(d.word)}</span></div>
                     <p class="wp-zh muted">重新查詢中…</p>`;
    try {
      const fresh = await V.lookup(d.word, popContext, true);
      if (popWord === d.word) paint(fresh, !!V.find(d.word));
    } catch (e) {
      if (popWord === d.word) paint(d, already);
    }
  });
  on("add", () => {
    V.add(d.word, d);
    closeLookup();
    hooks.onVocabChanged(d.word);
    hooks.toast(`已加入「${d.word}」，之後會出現在複習`);
  });

  // 近義／反義詞、詞性變化：原地換成那個字，可以一路探索下去
  bindChips(pop);

  // 舊的快取或單字本沒有詞性變化 → 補查一次（之後永久快取，同一個字不會再查）
  if (!Array.isArray(d.family)) {
    const word = d.word;
    V.fetchForms([word]).then(() => {
      const fresh = V.find(word) || Store.cacheGet(word) || {};
      const box = pop.querySelector(".wp-forms-wait");
      if (popWord !== word && popWord !== d.word) return;
      if (box) { box.outerHTML = formsHTML(fresh); bindChips(pop); }
    }).catch(() => {
      const box = pop.querySelector(".wp-forms-wait");
      if (box) box.remove();
    });
  }
}

function bindChips(root) {
  root.querySelectorAll("[data-lookup]:not([data-bound])").forEach(btn => {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => loadWord(btn.dataset.lookup, ""));
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

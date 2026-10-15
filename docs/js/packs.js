/**
 * packs.js — 公共單字包
 *
 * 網站內建的課本單字表（docs/packs/），任何人都能一鍵加進自己的單字本，不花 API 額度。
 * 加入後每個字會帶上該課的標籤（例如「龍騰B1-L1」），複習頁可以只練某一課。
 * 已經在單字本裡的字不會重複新增，只會補上標籤與空白欄位。
 *
 * 單字包的內容由 tools/packs/build.py 產生；要新增一本書不用改這支程式。
 */

import * as Store from "./store.js";
import * as V from "./vocab.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let dlg = null;
let hooks = { toast: () => {}, onChanged: () => {} };
let index = null;               // packs/index.json
const unitCache = new Map();    // file → 單元內容
let openBook = null;            // 目前打開的書 id

export function initPacks(h) { hooks = { ...hooks, ...h }; }

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`讀取失敗（${r.status}）`);
  return r.json();
}

async function loadIndex() {
  if (!index) index = await getJSON("packs/index.json");
  return index;
}

async function loadUnit(u) {
  if (!unitCache.has(u.file)) unitCache.set(u.file, await getJSON("packs/" + u.file));
  return unitCache.get(u.file);
}

/** 這一課已經有幾個字在單字本裡、而且帶著這課的標籤 */
function addedCount(u, unit) {
  const have = new Map(Store.vocab().map(v => [v.word.toLowerCase(), v]));
  const items = unit ? unit.items.map(x => x.w) : null;
  if (!items) {
    // 還沒載入內容時，用標籤數量估
    return Store.vocab().filter(v => (v.tags || []).includes(u.tag)).length;
  }
  return items.filter(w => { const v = have.get(w.toLowerCase()); return v && (v.tags || []).includes(u.tag); }).length;
}

/** 把一課加進單字本，回傳新增了幾個字 */
async function addUnit(u) {
  const unit = await loadUnit(u);
  let added = 0;
  for (const it of unit.items) {
    const { isNew } = V.add(it.w, { pos: it.pos === "phr." ? "" : it.pos, zh: it.zh, tags: [unit.tag] });
    if (isNew) added++;
  }
  Store.save(true);
  return { added, total: unit.items.length };
}

export async function openPacks() {
  if (!dlg) build();
  dlg.showModal();
  openBook = null;
  await paint();
}

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "modal packs";
  dlg.id = "dlgPacks";
  dlg.innerHTML = `
    <div class="m-head">
      <h2>📦 公共單字包</h2>
      <p class="note" style="margin:0">課本單字整理好了，一鍵加進單字本。免費、不用 API。
        加入的字會帶上課次標籤，複習時可以只練某一課。</p>
    </div>
    <div class="m-body pk-body"></div>
    <div class="m-foot"><button class="btn primary" type="button" data-close autofocus>完成</button></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
}

async function paint() {
  const body = dlg.querySelector(".pk-body");
  if (!index) body.innerHTML = `<p class="muted note">載入中…</p>`;
  try {
    await loadIndex();
  } catch (e) {
    body.innerHTML = `<p class="note">單字包載入失敗：${esc(e.message)}。請確認有連上網路後再試一次。</p>`;
    return;
  }
  if (!openBook) return paintBooks(body);
  paintUnits(body, index.packs.find(p => p.id === openBook));
}

/** 第一層：有哪些書 */
function paintBooks(body) {
  body.innerHTML = `<div class="pk-books">${index.packs.map(p => {
    const total = p.units.reduce((a, u) => a + u.words + u.phrases, 0);
    const done = p.units.reduce((a, u) => a + addedCount(u), 0);
    return `<button type="button" class="pk-book" data-book="${esc(p.id)}">
      <span class="pk-ci">${/^(live|abc|cnn|allplus|ivy)-|magazine/i.test(p.id) ? "📰" : "📘"}</span>
      <span class="pk-bt"><b>${esc(p.title)}</b><small>${esc(p.subtitle || "")}・${p.units.length} 個單元・${total} 個字</small>
        ${done ? `<small class="pk-done">已加入 ${done} 個</small>` : ""}</span>
      <span class="pk-go">›</span></button>`;
  }).join("")}</div>
  <p class="note">想要其他版本或其他冊？之後會陸續加上。也可以用「＋ 新增單字」或「批次貼上」自己加。</p>`;
  body.querySelectorAll("[data-book]").forEach(b => b.addEventListener("click", () => { openBook = b.dataset.book; paint(); }));
}

/** 第二層：一本書的每一課 */
function paintUnits(body, p) {
  body.innerHTML = `
    <button type="button" class="mini pk-back">‹ 所有單字包</button>
    <div class="pk-head"><b>${esc(p.title)}</b><span class="muted">${esc(p.subtitle || "")}</span></div>
    <p class="note pk-note">${esc(p.note || "")}
      ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.linkText || "原始資料")} ↗</a>` : ""}</p>
    <div class="pk-all"><button class="btn sm" type="button" data-all>全部 ${p.units.length} 課一次加入</button></div>
    <div class="pk-units"></div>`;
  body.querySelector(".pk-back").addEventListener("click", () => { openBook = null; paint(); });

  const list = body.querySelector(".pk-units");
  for (const u of p.units) {
    const row = document.createElement("div");
    row.className = "pk-unit";
    list.appendChild(row);
    paintUnit(row, u);
  }

  body.querySelector("[data-all]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    let added = 0;
    try {
      for (const u of p.units) added += (await addUnit(u)).added;
      hooks.toast(`已加入 ${added} 個新字（已經有的字只補上課次標籤）`);
      hooks.onChanged();
    } catch (err) {
      hooks.toast("加入失敗：" + err.message);
    }
    btn.disabled = false;
    paint();
  });
}

function paintUnit(row, u) {
  const unit = unitCache.get(u.file);
  const total = u.words + u.phrases;
  const done = addedCount(u, unit);
  const full = done >= total;
  row.innerHTML = `
    <div class="pk-uh no-lookup">
      <span class="pk-code">${esc(u.id)}</span>
      <span class="pk-ut"><b>${esc(u.title)}</b>
        <small>${u.words} 個單字${u.phrases ? `＋${u.phrases} 個片語` : ""}${u.verified ? "" : "・<span class=\"pk-warn\">可能不完整</span>"}</small></span>
      <button class="btn sm ${full ? "" : "primary"}" type="button" data-add ${full ? "disabled" : ""}>
        ${full ? "✓ 已加入" : done ? `補齊（已有 ${done}/${total}）` : "＋ 加入"}</button>
    </div>
    <details class="pk-more"><summary class="no-lookup">${esc(u.preview.join("、"))}…</summary><div class="pk-list muted">載入中…</div></details>`;

  row.querySelector("[data-add]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "加入中…";
    try {
      const r = await addUnit(u);
      hooks.toast(r.added ? `「${u.id} ${u.title}」加入了 ${r.added} 個新字` : `「${u.id}」的字本來就都在單字本裡了，已補上課次標籤`);
      hooks.onChanged();
    } catch (err) {
      hooks.toast("加入失敗：" + err.message);
    }
    paintUnit(row, u);
  });

  // 展開才載入完整字表
  row.querySelector("details").addEventListener("toggle", async (e) => {
    if (!e.target.open) return;
    const box = row.querySelector(".pk-list");
    try {
      const data = await loadUnit(u);
      box.className = "pk-list";
      box.innerHTML = data.items.map(it =>
        `<span class="pk-w"><b>${esc(it.w)}</b>${it.pos && it.pos !== "phr." ? `<i>${esc(it.pos)}</i>` : ""}<small>${esc(it.zh)}</small></span>`).join("");
    } catch (err) {
      box.textContent = "載入失敗：" + err.message;
    }
  });
}

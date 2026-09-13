/**
 * stats.js — 練習紀錄與統計
 *
 * 圖表只有一張：練習熱力圖。它的工作是「看出有沒有持續練」，屬於
 * 單一數量隨時間變化，所以用單一色相由淺到深的序列色階（不是彩虹配色），
 * 每格都有 hover 提示，並附一份表格檢視給讀螢幕或想看確切數字的人。
 */

import { load, sessions, daily, todayKey, dayKeyOffset, uid, save, bumpDaily } from "./store.js";
import { counts } from "./vocab.js";

/* ---------- 對話階段記錄 ---------- */

let active = null;

export function beginSession() {
  active = {
    id: uid(),
    start: Date.now(),
    end: 0,
    turns: 0,
    userWords: 0,
    scenario: "",
    messages: [],
  };
  return active;
}

export function recordTurn(role, content, words = 0) {
  if (!active) return;
  active.messages.push({ role, content, t: Date.now() });
  if (role === "user") {
    active.turns++;
    active.userWords += words;
    bumpDaily({ turns: 1, userWords: words });
  }
}

/** 每隔一段時間呼叫，累積實際練習秒數（比用起訖時間相減準，因為中間可能放著沒動） */
export function tickSeconds(sec) {
  if (!active) return;
  bumpDaily({ seconds: sec });
}

export function endSession() {
  if (!active) return null;
  active.end = Date.now();
  if (active.messages.length >= 2) {
    sessions().push(active);
    // 只留最近 200 場，避免 localStorage 爆掉
    const list = sessions();
    if (list.length > 200) list.splice(0, list.length - 200);
    save(true);
  }
  const done = active;
  active = null;
  return done;
}

export function currentSession() { return active; }

/* ---------- 彙總 ---------- */

export function streak() {
  const d = daily();
  let n = 0;
  for (let i = 0; ; i++) {
    const k = dayKeyOffset(-i);
    const row = d[k];
    const practised = row && (row.seconds > 60 || row.turns > 0 || row.reviews > 0);
    if (!practised) {
      if (i === 0) continue;   // 今天還沒練不算斷
      break;
    }
    n++;
    if (i > 400) break;
  }
  return n;
}

export function totals() {
  const d = daily();
  let seconds = 0, turns = 0, userWords = 0, reviews = 0, days = 0;
  for (const row of Object.values(d)) {
    seconds += row.seconds || 0;
    turns += row.turns || 0;
    userWords += row.userWords || 0;
    reviews += row.reviews || 0;
    if ((row.seconds || 0) > 60 || (row.turns || 0) > 0) days++;
  }
  return { seconds, turns, userWords, reviews, days, sessions: sessions().length };
}

export function thisWeek() {
  const d = daily();
  let seconds = 0, turns = 0, userWords = 0;
  for (let i = 0; i < 7; i++) {
    const row = d[dayKeyOffset(-i)];
    if (!row) continue;
    seconds += row.seconds || 0;
    turns += row.turns || 0;
    userWords += row.userWords || 0;
  }
  return { seconds, turns, userWords };
}

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + " 秒";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return h + " 小時 " + m + " 分";
  return Math.round(sec / 60) + " 分鐘";
}

/* ---------- 熱力圖 ---------- */

// 序列色階：單一藍色相，由淺到深＝從沒練到練很多。
// 第 0 階是「沒有資料」的中性灰，不是藍色最淺階，避免「零」看起來像「有一點」。
const RAMP_LIGHT = ["#e9e9e5", "#b7d3f6", "#86b6ef", "#3987e5", "#1c5cab"];
const RAMP_DARK  = ["#26262b", "#104281", "#184f95", "#256abf", "#3987e5"];

/** 把當天的練習秒數分到 0~4 階 */
function bucket(sec) {
  if (!sec || sec < 60) return 0;
  if (sec < 300) return 1;      // < 5 分鐘
  if (sec < 900) return 2;      // < 15 分鐘
  if (sec < 1800) return 3;     // < 30 分鐘
  return 4;
}

const BUCKET_LABEL = ["沒有練習", "不到 5 分鐘", "5–15 分鐘", "15–30 分鐘", "30 分鐘以上"];

/**
 * 畫出最近 weeks 週的練習熱力圖。
 * @returns {HTMLElement}
 */
export function renderHeatmap(weeks = 26) {
  const d = daily();
  const wrap = document.createElement("div");
  wrap.className = "heatmap-wrap";

  // 從今天往回推到最近的週日，讓每一欄都是完整的一週
  const today = new Date();
  const endPad = 6 - today.getDay();
  const lastCol = new Date(today);
  lastCol.setDate(lastCol.getDate() + endPad);

  const cols = [];
  let cursor = new Date(lastCol);
  cursor.setDate(cursor.getDate() - (weeks * 7 - 1));

  const monthMarks = [];
  for (let c = 0; c < weeks; c++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const dt = new Date(cursor);
      const key = fmtKey(dt);
      col.push({ key, date: new Date(dt), row: d[key] || null,
                 future: dt > today });
      cursor.setDate(cursor.getDate() + 1);
    }
    // 該欄第一天若是該月 1~7 號，就在上方標月份
    const first = col[0].date;
    if (first.getDate() <= 7) monthMarks.push({ col: c, label: (first.getMonth() + 1) + "月" });
    cols.push(col);
  }

  // 月份標籤
  const monthRow = document.createElement("div");
  monthRow.className = "hm-months";
  monthRow.style.gridTemplateColumns = `repeat(${weeks}, var(--hm-cell))`;
  for (let c = 0; c < weeks; c++) {
    const el = document.createElement("span");
    const mark = monthMarks.find(m => m.col === c);
    el.textContent = mark ? mark.label : "";
    monthRow.appendChild(el);
  }

  const grid = document.createElement("div");
  grid.className = "hm-grid";
  grid.style.gridTemplateColumns = `repeat(${weeks}, var(--hm-cell))`;
  grid.setAttribute("role", "img");
  grid.setAttribute("aria-label", `最近 ${weeks} 週的每日練習時間熱力圖`);

  for (const col of cols) {
    const colEl = document.createElement("div");
    colEl.className = "hm-col";
    for (const cell of col) {
      const el = document.createElement("div");
      el.className = "hm-cell";
      if (cell.future) {
        el.classList.add("hm-future");
      } else {
        const sec = cell.row ? (cell.row.seconds || 0) : 0;
        const b = bucket(sec);
        el.dataset.level = String(b);
        const parts = [cell.key, BUCKET_LABEL[b]];
        if (cell.row) {
          if (cell.row.turns) parts.push(cell.row.turns + " 回合");
          if (cell.row.reviews) parts.push("複習 " + cell.row.reviews + " 字");
        }
        el.dataset.tip = parts.join("　");
        el.tabIndex = -1;
      }
      colEl.appendChild(el);
    }
    grid.appendChild(colEl);
  }

  // 星期標籤（只標一三五，免得太擠）
  const dayCol = document.createElement("div");
  dayCol.className = "hm-days";
  ["", "一", "", "三", "", "五", ""].forEach(t => {
    const s = document.createElement("span");
    s.textContent = t;
    dayCol.appendChild(s);
  });

  const body = document.createElement("div");
  body.className = "hm-body";
  body.appendChild(dayCol);

  const scroll = document.createElement("div");
  scroll.className = "hm-scroll";
  scroll.appendChild(monthRow);
  scroll.appendChild(grid);
  body.appendChild(scroll);
  wrap.appendChild(body);

  // 圖例
  const legend = document.createElement("div");
  legend.className = "hm-legend";
  legend.innerHTML = "<span>少</span>";
  for (let i = 0; i < 5; i++) {
    const s = document.createElement("i");
    s.dataset.level = String(i);
    s.title = BUCKET_LABEL[i];
    legend.appendChild(s);
  }
  const more = document.createElement("span");
  more.textContent = "多";
  legend.appendChild(more);
  wrap.appendChild(legend);

  // hover 提示
  const tip = document.createElement("div");
  tip.className = "hm-tip";
  tip.hidden = true;
  wrap.appendChild(tip);

  grid.addEventListener("mousemove", (e) => {
    const cell = e.target.closest(".hm-cell");
    if (!cell || !cell.dataset.tip) { tip.hidden = true; return; }
    tip.textContent = cell.dataset.tip;
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(cr.left - wr.left - 60, 0), wr.width - 150) + "px";
    tip.style.top = (cr.top - wr.top - 34) + "px";
  });
  grid.addEventListener("mouseleave", () => { tip.hidden = true; });

  return wrap;
}

/** 熱力圖的表格檢視：同樣的資料，但可以讀到確切數字 */
export function renderHeatmapTable(days = 30) {
  const d = daily();
  const tbl = document.createElement("table");
  tbl.className = "data-table";
  tbl.innerHTML = "<thead><tr><th>日期</th><th>練習時間</th><th>對話回合</th>"
                + "<th>開口字數</th><th>複習單字</th></tr></thead>";
  const tb = document.createElement("tbody");
  let any = false;
  for (let i = 0; i < days; i++) {
    const k = dayKeyOffset(-i);
    const row = d[k];
    if (!row) continue;
    any = true;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${k}</td><td>${fmtDuration(row.seconds)}</td>`
                 + `<td>${row.turns || 0}</td><td>${row.userWords || 0}</td>`
                 + `<td>${row.reviews || 0}</td>`;
    tb.appendChild(tr);
  }
  if (!any) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5" class="muted">最近還沒有練習紀錄</td>';
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  return tbl;
}

export { RAMP_LIGHT, RAMP_DARK, counts };

function fmtKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

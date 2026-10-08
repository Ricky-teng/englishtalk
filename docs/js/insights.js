/**
 * insights.js — 個人學習分析
 *
 * 全部用本機資料算（作答紀錄、對話逐字稿、單字本），不花 API 額度。
 * 唯一會呼叫 API 的是「AI 教練週報」，要你自己按，而且同一週只算一次（結果會快取）。
 *
 * 圖表原則：一張圖只回答一個問題；單一數列用單一色相、數值標在長條尾端；
 * 有順序的分級（新字→學習中→熟練）用同一色相由淺到深；每個長條都有 hover 說明，
 * 每張圖下面都有「看數字」表格。
 */

import * as Store from "./store.js";
import * as V from "./vocab.js";
import { complete } from "./llm.js";
import { summarize as grammarSummary } from "./grammar.js";

/* =========================================================================
   計算
   ========================================================================= */

const DAY = 86400000;
const RECOGNIZE = ["flip", "mcEn", "mcZh"];                    // 認得型題目
const PRODUCE = ["spell", "cloze", "listen", "speak"];          // 自己產出型題目
const MODE_NAME = { flip: "翻卡", mcEn: "看英選中", mcZh: "看中選英", cloze: "例句填空",
                    spell: "拼字", listen: "聽寫", speak: "用說的" };

// 對話裡常被過度使用的字，以及可以換的說法
const OVERUSED = {
  very: ["really", "extremely", "incredibly"], really: ["truly", "seriously", "genuinely"],
  good: ["great", "excellent", "decent"], bad: ["terrible", "awful", "poor"],
  nice: ["pleasant", "lovely", "enjoyable"], big: ["huge", "massive", "enormous"],
  small: ["tiny", "little", "compact"], happy: ["glad", "delighted", "thrilled"],
  sad: ["upset", "down", "disappointed"], interesting: ["fascinating", "intriguing"],
  maybe: ["perhaps", "probably"], thing: [], stuff: [], "a lot": ["plenty", "tons", "loads"],
};

export function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return y + "-W" + String(w).padStart(2, "0");
}

function mondayOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function userTurns() {
  const out = [];
  for (const s of Store.sessions()) {
    for (const m of s.messages || []) {
      if (m.role !== "user" || !m.content) continue;
      if (/^hi!?$/i.test(m.content.trim())) continue;     // 自動開場的 Hi! 不算
      out.push({ t: m.t > 1e12 ? m.t : s.start, text: m.content });
    }
  }
  return out;
}

const wordsOf = (text) => (String(text).toLowerCase().match(/[a-z][a-z']*/g) || []);

export function compute() {
  const vocab = Store.vocab();
  const log = Store.reviewLog();
  const now = Date.now();
  const today = Store.todayKey();

  // ---- 記憶保持率（最近 30 天，答對 = 品質 ≥ 3）----
  const recent = log.filter(l => now - l.t < 30 * DAY);
  const rate = (arr) => arr.length ? arr.filter(l => l.q >= 3).length / arr.length : null;
  const byMode = Object.keys(MODE_NAME).map(m => {
    const a = recent.filter(l => l.m === m);
    return { mode: m, name: MODE_NAME[m], n: a.length, rate: rate(a),
             ms: a.length ? Math.round(a.reduce((s, l) => s + (l.ms || 0), 0) / a.length) : 0 };
  }).filter(x => x.n > 0);
  const recog = recent.filter(l => RECOGNIZE.includes(l.m));
  const prod = recent.filter(l => PRODUCE.includes(l.m));
  // 只看「之前複習過」的卡，新卡第一次答錯不算忘記
  const matured = recent.filter(l => (l.r || 0) > 0);

  // ---- 單字掌握度 ----
  const mastery = {
    total: vocab.length,
    reviewed: vocab.filter(v => v.lastReview || v.reps).length,
    stable: vocab.filter(v => (v.interval || 0) >= 7).length,
    spoken: vocab.filter(v => (v.produced || 0) >= 1).length,
    fluent: vocab.filter(v => (v.produced || 0) >= 3).length,
  };
  const passiveGap = vocab.filter(v => (v.interval || 0) >= 7 && !(v.produced || 0));

  // ---- 最難的字（反覆忘記）----
  const leeches = vocab.filter(v => (v.lapses || 0) >= 2)
    .sort((a, b) => (b.lapses - a.lapses) || ((a.ef || 2.5) - (b.ef || 2.5))).slice(0, 8);

  // ---- 各課（標籤）進度 ----
  const tagMap = new Map();
  for (const v of vocab) for (const t of (v.tags || [])) {
    if (!tagMap.has(t)) tagMap.set(t, { tag: t, fresh: 0, learning: 0, mastered: 0, spoken: 0, total: 0 });
    const r = tagMap.get(t);
    r.total++;
    if (!(v.reps || 0)) r.fresh++;
    else if ((v.interval || 0) >= 21) r.mastered++;
    else r.learning++;
    if ((v.produced || 0) > 0) r.spoken++;
  }
  const tags = [...tagMap.values()].sort((a, b) => b.total - a.total).slice(0, 10);

  // ---- 未來 7 天的複習量 ----
  const forecast = [];
  for (let i = 0; i < 7; i++) {
    const k = Store.dayKeyOffset(i);
    const count = vocab.filter(v => i === 0 ? v.due <= k : v.due === k).length;
    const d = new Date(); d.setDate(d.getDate() + i);
    forecast.push({ key: k, label: i === 0 ? "今天" : i === 1 ? "明天" : "週" + "日一二三四五六"[d.getDay()], count });
  }

  // ---- 口說分析（對話逐字稿）----
  const turns = userTurns();
  const firstSeen = new Map();
  const counts = new Map();
  let tokens = 0;
  for (const tu of turns.sort((a, b) => a.t - b.t)) {
    const ws = wordsOf(tu.text);
    tokens += ws.length;
    ws.forEach((w, i) => {
      if (!firstSeen.has(w)) firstSeen.set(w, tu.t);
      counts.set(w, (counts.get(w) || 0) + 1);
      if (w === "a" && ws[i + 1] === "lot") counts.set("a lot", (counts.get("a lot") || 0) + 1);
    });
  }
  const weekStart = mondayOf(now);
  const newThisWeek = [...firstSeen.entries()].filter(([w, t]) => t >= weekStart && w.length > 3).map(([w]) => w);
  const overused = Object.keys(OVERUSED)
    .map(w => ({ w, n: counts.get(w) || 0, alts: OVERUSED[w] }))
    .filter(x => x.n >= 4).sort((a, b) => b.n - a.n).slice(0, 3);
  // 每週平均句長（最近 8 週）
  const weekly = [];
  for (let i = 7; i >= 0; i--) {
    const from = weekStart - i * 7 * DAY, to = from + 7 * DAY;
    const ts = turns.filter(t => t.t >= from && t.t < to);
    const w = ts.reduce((s, t) => s + wordsOf(t.text).length, 0);
    const d = new Date(from);
    weekly.push({ label: (d.getMonth() + 1) + "/" + d.getDate(), turns: ts.length,
                  wpt: ts.length ? +(w / ts.length).toFixed(1) : null });
  }
  const speech = { turns: turns.length, tokens, activeVocab: firstSeen.size, newThisWeek, overused, weekly };

  // ---- 最常練習的時段 ----
  const hours = new Array(24).fill(0);
  log.forEach(l => hours[new Date(l.t).getHours()]++);
  turns.forEach(t => hours[new Date(t.t).getHours()]++);
  const totalH = hours.reduce((a, b) => a + b, 0);
  const bestHour = totalH >= 20 ? hours.indexOf(Math.max(...hours)) : null;

  // ---- FSRS：此刻還記得多少（每張複習過的卡依遺忘曲線推算） ----
  const rs = vocab.map(v => V.recallNow(v)).filter(r => r != null);
  const recall = rs.length ? { n: rs.length, sum: Math.round(rs.reduce((a, b) => a + b, 0)),
                               avg: rs.reduce((a, b) => a + b, 0) / rs.length } : null;

  return {
    recall, grammar: grammarSummary(Store.sessions(), 30),
    retention: { rate: rate(matured.length >= 10 ? matured : recent), n: recent.length },
    recogRate: rate(recog), recogN: recog.length, prodRate: rate(prod), prodN: prod.length,
    byMode, mastery, passiveGap, leeches, tags, forecast, speech, bestHour,
    dueToday: forecast[0].count,
  };
}

/* =========================================================================
   個人化建議（規則產生）
   ========================================================================= */

const pct = (x) => Math.round(x * 100) + "%";
const list = (arr, n = 4) => arr.slice(0, n).map(v => v.word || v).join("、") + (arr.length > n ? "…" : "");

export function messages(d) {
  const out = [];
  const g = d.grammar;
  if (g && g.types.length && g.types[0].n >= 3) {
    const t = g.types[0], ex = t.examples[0];
    out.push({ icon: "✏️", text:
      `最近 30 天你最常錯的是「${t.label}」（${t.n} 句）` +
      (ex ? `，例如 ${ex.from || "（漏掉）"} → ${ex.to || "（刪掉）"}${ex.zh ? `：${ex.zh}` : ""}` : "") +
      `。對話時多留意這一類，會進步最快。` });
  }
  if (d.dueToday > 25) out.push({ icon: "📚", text:
    `今天有 ${d.dueToday} 個字待複習，有點多。先用「混合」做 15 個就好，其餘明天再說 —— 一次硬清完反而容易忘。`,
    action: { label: "混合複習 15 個", do: "mixed" } });

  if (d.passiveGap.length >= 3) out.push({ icon: "🗣️", text:
    `有 ${d.passiveGap.length} 個字你已經穩定認得（一週以上沒忘），但從沒在對話中說出口：${list(d.passiveGap)}。` +
    `認得不等於會用 —— 這批是最該開口練的。`,
    action: { label: "用拼字和填空逼自己想出來", do: "produce-gap" }, action2: { label: "把對話單字頻率調到「常常」", do: "freq" } });

  if (d.recogN >= 8 && d.prodN >= 8 && d.recogRate - d.prodRate >= 0.2) out.push({ icon: "⌨️", text:
    `你看得懂（認得型題目答對 ${pct(d.recogRate)}），但自己寫不出來（拼字、填空類 ${pct(d.prodRate)}）。` +
    `差距 ${Math.round((d.recogRate - d.prodRate) * 100)} 個百分點 —— 多做「拼字」和「例句填空」。`,
    action: { label: "來一輪拼字", do: "spell" } });

  if (d.leeches.length >= 2) out.push({ icon: "🔁", text:
    `這 ${d.leeches.length} 個字你忘了好幾次：${list(d.leeches)}。反覆忘記通常代表要換個記法 —— 試試例句填空，或幫它們補上近義詞。`,
    action: { label: "專攻這幾個字", do: "leeches" } });

  if (d.speech.overused.length) {
    const o = d.speech.overused[0];
    out.push({ icon: "💬", text: o.alts.length
      ? `你在對話中說了 ${o.n} 次「${o.w}」。下次試試 ${o.alts.join("、")}。`
      : `你在對話中說了 ${o.n} 次「${o.w}」—— 試著直接講出具體的名詞，句子會更清楚。` });
  }

  const w = d.speech.weekly;
  const cur = w[w.length - 1], prev = w.slice(-5, -1).filter(x => x.wpt);
  if (cur.wpt && cur.turns >= 5 && prev.length >= 2) {
    const avg = prev.reduce((s, x) => s + x.wpt, 0) / prev.length;
    const diff = cur.wpt - avg;
    if (Math.abs(diff) >= 0.8) out.push({ icon: diff > 0 ? "📈" : "📉", text: diff > 0
      ? `這週你平均每句說 ${cur.wpt} 個字，比前幾週多 ${diff.toFixed(1)} 個 —— 句子越講越完整了。`
      : `這週平均每句 ${cur.wpt} 個字，比前幾週少 ${Math.abs(diff).toFixed(1)} 個。試著多回答一個「為什麼」。` });
  }

  if (d.speech.newThisWeek.length >= 5) out.push({ icon: "🌱", text:
    `這週你在對話中第一次說出 ${d.speech.newThisWeek.length} 個字，例如 ${d.speech.newThisWeek.slice(-4).join("、")}。` });

  if (d.retention.rate != null && d.retention.n >= 20) {
    if (d.retention.rate < 0.8) out.push({ icon: "🧠", text:
      `最近 30 天的記憶保持率 ${pct(d.retention.rate)}，低於理想的 85–90%。每天少量複習比幾天一次大量有效得多。` });
    else if (d.retention.rate >= 0.9) out.push({ icon: "🧠", text:
      `最近 30 天的記憶保持率 ${pct(d.retention.rate)}，記得很牢。可以放心多加一些新字。` });
  }

  if (d.bestHour != null) out.push({ icon: "🕘", text:
    `你最常在 ${d.bestHour}:00–${d.bestHour + 1}:00 練習。固定在同一個時段，最容易養成習慣。` });

  if (!out.length) out.push({ icon: "👋", text:
    "多聊幾場、多複習幾輪之後，這裡會出現專屬於你的分析：哪些字認得卻講不出來、哪種題型最弱、句子有沒有越講越長。" });
  return out.slice(0, 6);
}

/* =========================================================================
   AI 教練週報（每週最多一次 API）
   ========================================================================= */

export async function coachReport(d, force = false) {
  const st = Store.load();
  const wk = weekKey();
  if (!force && st.coach[wk]) return st.coach[wk];

  const weekStart = mondayOf(Date.now());
  const samples = userTurns().filter(t => t.t >= weekStart).map(t => t.text)
    .filter(t => t.split(/\s+/).length >= 4).slice(-12);
  const summary = {
    vocab: d.mastery, retention30d: d.retention.rate, recognitionRate: d.recogRate, productionRate: d.prodRate,
    byMode: d.byMode.map(m => ({ mode: m.mode, n: m.n, rate: m.rate })),
    hardestWords: d.leeches.map(v => v.word), knownButNeverSpoken: d.passiveGap.slice(0, 10).map(v => v.word),
    overusedWords: d.speech.overused.map(o => `${o.w} x${o.n}`), avgWordsPerTurnByWeek: d.speech.weekly.map(w => w.wpt),
    newWordsSpokenThisWeek: d.speech.newThisWeek.slice(0, 20), level: Store.settings().level,
  };
  const prompt = `You are a warm but honest English coach for a Traditional Chinese speaking learner.
Here is their learning data for this week (JSON) and some sentences they actually said in conversation.

DATA: ${JSON.stringify(summary)}
THEIR SENTENCES:
${samples.map(s => "- " + s).join("\n") || "(no conversation this week)"}

Write a short weekly report in TRADITIONAL CHINESE (not Simplified), plain text, no markdown headings:
1. One line on what went well this week, citing a specific number from the data.
2. Two or three specific, actionable suggestions for next week, each tied to the data (name the words or modes).
3. If there are sentences: pick at most 3 of them and show "你說：… → 更自然：…" with a natural rewrite and a 10-character-or-less reason.
Keep the whole report under 220 Chinese characters plus the rewrites. Do not invent data.`;
  const text = (await complete(prompt, { maxTokens: 900 })).trim();
  st.coach[wk] = text;
  Store.save();
  return text;
}

/* =========================================================================
   畫面
   ========================================================================= */

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 單一數列的橫條圖：數值標在尾端，hover 有說明 */
function hbars(rows, { max, fmt = (v) => v, tip = () => "" } = {}) {
  const m = max || Math.max(1, ...rows.map(r => r.value || 0));
  return `<div class="hb">${rows.map(r => `
    <div class="hb-row" data-tip="${esc(tip(r))}" tabindex="0">
      <span class="hb-label">${esc(r.label)}</span>
      <span class="hb-track"><span class="hb-bar" style="width:${Math.max(0, (r.value || 0) / m * 100)}%"></span></span>
      <span class="hb-val">${esc(fmt(r.value, r))}</span>
    </div>`).join("")}</div>`;
}

/** 數字表格（每張圖都附一份，給要看確切數字或用螢幕閱讀器的人） */
function table(head, rows) {
  return `<details class="dv-table"><summary>看數字</summary><div class="table-scroll"><table class="data-table">
    <thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div></details>`;
}

export function render(container, d, act) {
  const msgs = messages(d);
  const st = Store.load();
  const cached = st.coach[weekKey()];
  const m = d.mastery;

  // 各課進度：三段有順序的堆疊條（新字 → 學習中 → 熟練）
  const tagBars = d.tags.length ? `
    <div class="dv-legend"><span><i class="lv0"></i>新字</span><span><i class="lv1"></i>學習中</span><span><i class="lv2"></i>熟練（間隔 21 天以上）</span></div>
    <div class="sb">${d.tags.map(t => {
      const seg = (n, cls, name) => n ? `<span class="sb-seg ${cls}" style="flex:${n}" data-tip="${esc(`${t.tag}・${name} ${n} 個`)}"></span>` : "";
      return `<div class="sb-row" tabindex="0" data-tip="${esc(`${t.tag}：共 ${t.total} 個，熟練 ${t.mastered}、學習中 ${t.learning}、新字 ${t.fresh}；對話中說出過 ${t.spoken} 個`)}">
        <span class="hb-label">${esc(t.tag)}</span>
        <span class="sb-track">${seg(t.fresh, "lv0", "新字")}${seg(t.learning, "lv1", "學習中")}${seg(t.mastered, "lv2", "熟練")}</span>
        <span class="hb-val">${Math.round(t.mastered / t.total * 100)}%</span></div>`;
    }).join("")}</div>
    ${table(["標籤", "新字", "學習中", "熟練", "說出過", "總數"], d.tags.map(t => [t.tag, t.fresh, t.learning, t.mastered, t.spoken, t.total]))}`
    : `<p class="muted note">幫單字加上標籤（例如「第三課」）就能在這裡看到每一課的進度。</p>`;

  const fmax = Math.max(1, ...d.forecast.map(f => f.count));
  const forecast = `<div class="vb">${d.forecast.map(f => `
      <div class="vb-col" data-tip="${esc(`${f.label}（${f.key}）：${f.count} 個字到期`)}" tabindex="0">
        <span class="vb-val">${f.count || ""}</span>
        <span class="vb-bar" style="height:${f.count / fmax * 100}%"></span>
        <span class="vb-label">${esc(f.label)}</span></div>`).join("")}</div>
    ${table(["日期", "到期字數"], d.forecast.map(f => [f.key, f.count]))}`;

  const wk = d.speech.weekly;
  const wmax = Math.max(1, ...wk.map(w => w.wpt || 0));
  const speechChart = wk.some(w => w.wpt) ? `<div class="vb">${wk.map(w => `
      <div class="vb-col" data-tip="${esc(w.wpt ? `${w.label} 那週：平均每句 ${w.wpt} 個字（${w.turns} 句）` : `${w.label} 那週沒有對話`)}" tabindex="0">
        <span class="vb-val">${w.wpt ?? ""}</span>
        <span class="vb-bar" style="${w.wpt ? `height:${w.wpt / wmax * 100}%` : "height:0;min-height:0"}"></span>
        <span class="vb-label">${esc(w.label)}</span></div>`).join("")}</div>
    ${table(["週（起始日）", "平均每句字數", "句數"], wk.map(w => [w.label, w.wpt ?? "—", w.turns]))}`
    : `<p class="muted note">開始對話之後，這裡會顯示你每週平均每句說幾個字。</p>`;

  container.innerHTML = `
    <div class="card ins-card">
      <h3>給你的分析</h3>
      <div class="ins-list">${msgs.map((x, i) => `
        <div class="ins-item"><span class="ins-icon">${x.icon}</span>
          <div><p>${esc(x.text)}</p>
          ${x.action || x.action2 ? `<div class="ins-acts">
            ${x.action ? `<button class="mini" data-act="${x.action.do}">${esc(x.action.label)}</button>` : ""}
            ${x.action2 ? `<button class="mini" data-act="${x.action2.do}">${esc(x.action2.label)}</button>` : ""}
          </div>` : ""}</div></div>`).join("")}</div>
      <div class="coach">
        <div class="coach-head"><b>🤖 AI 教練週報</b>
          <button class="btn sm" data-act="coach">${cached ? "重新產生" : "產生這週的週報"}</button></div>
        <div class="coach-body">${cached ? esc(cached) : `<span class="muted">根據上面的數據和你這週說過的句子，給你具體的建議和幾句「更自然的說法」。每週一次，只花一次 API。</span>`}</div>
      </div>
    </div>

    <div class="dv-grid">
      <div class="card">
        <h3>單字掌握度</h3>
        <p class="dv-sub">從「收進單字本」到「對話中脫口而出」，你的字卡在哪一關？</p>
        ${hbars([
          { label: "單字本", value: m.total },
          { label: "複習過", value: m.reviewed },
          { label: "穩定認得", value: m.stable },
          { label: "說出過", value: m.spoken },
          { label: "說出 3 次+", value: m.fluent },
        ], { max: m.total || 1, tip: (r) => ({
          "單字本": "單字本裡的所有字", "複習過": "至少複習過一次",
          "穩定認得": "複習間隔已經拉到 7 天以上", "說出過": "在對話或用說的複習中自己說出來過",
          "說出 3 次+": "說出來 3 次以上，算是真的會用了" }[r.label] + `：${r.value} 個`) })}
        ${d.recall ? `<div class="dv-foot">依遺忘曲線推算，複習過的 ${d.recall.n} 個字裡，你現在大約還記得 <b>${d.recall.sum}</b> 個（平均 ${pct(d.recall.avg)}）。</div>` : ""}
        ${table(["階段", "字數"], [["單字本", m.total], ["複習過", m.reviewed], ["穩定認得（間隔 7 天+）", m.stable], ["說出過", m.spoken], ["說出 3 次+", m.fluent]])}
      </div>

      <div class="card">
        <h3>各題型答對率</h3>
        <p class="dv-sub">最近 30 天。哪種題型最弱，就是你卡住的地方。</p>
        ${d.byMode.length ? hbars(d.byMode.map(x => ({ label: x.name, value: x.rate, n: x.n, ms: x.ms })),
          { max: 1, fmt: (v) => Math.round(v * 100) + "%",
            tip: (r) => `${r.label}：${r.n} 題，答對 ${Math.round(r.value * 100)}%，平均 ${(r.ms / 1000).toFixed(1)} 秒` })
          + table(["題型", "題數", "答對率", "平均秒數"], d.byMode.map(x => [x.name, x.n, Math.round(x.rate * 100) + "%", (x.ms / 1000).toFixed(1)]))
          : `<p class="muted note">複習幾輪之後就會出現。</p>`}
        ${d.retention.rate != null ? `<div class="dv-foot">記憶保持率 <b>${pct(d.retention.rate)}</b>（最近 30 天 ${d.retention.n} 次作答）</div>` : ""}
      </div>

      <div class="card">
        <h3>各課進度</h3>
        <p class="dv-sub">依標籤分組，看每一課離「熟練」還差多少。</p>
        ${tagBars}
      </div>

      <div class="card">
        <h3>未來 7 天的複習量</h3>
        <p class="dv-sub">先知道哪天會比較多，就能提早分散。</p>
        ${forecast}
      </div>

      <div class="card">
        <h3>口說：平均每句幾個字</h3>
        <p class="dv-sub">最近 8 週。句子越長，代表你越敢多講。</p>
        ${speechChart}
        <div class="dv-foot">你在對話中總共用過 <b>${d.speech.activeVocab}</b> 個不同的英文字${d.speech.newThisWeek.length ? `，這週新用了 <b>${d.speech.newThisWeek.length}</b> 個` : ""}。</div>
      </div>

      <div class="card">
        <h3>常犯的文法錯誤</h3>
        <p class="dv-sub">最近 30 天，對話中被標出修正的句子，依錯誤類型分。</p>
        ${d.grammar.types.length ? hbars(d.grammar.types.slice(0, 6).map(t => ({ label: t.label, value: t.n, ex: t.examples })),
            { max: Math.max(...d.grammar.types.map(t => t.n)),
              tip: (r) => `${r.label}：${r.value} 句` + (r.ex[0] ? `，例如 ${r.ex[0].from || "（漏掉）"} → ${r.ex[0].to || "（刪掉）"}` : "") })
          + `<div class="gx-list">${d.grammar.types.slice(0, 3).filter(t => t.examples.length).map(t => `
              <div class="gx"><span class="fx-type">${esc(t.label)}</span>${t.examples.slice(0, 2).map(e => `
                <span class="fx-ft"><s>${esc(e.from || "—")}</s> → <b>${esc(e.to || "—")}</b></span>`).join("")}</div>`).join("")}</div>`
          + table(["類型", "句數"], d.grammar.types.map(t => [t.label, t.n]))
          : `<p class="muted note">${d.grammar.checked ? "最近 30 天沒有被標出文法錯誤 👍" : "開始對話之後，這裡會統計你最常犯哪一類錯。"}</p>`}
        ${d.grammar.checked ? `<div class="dv-foot">檢查了 <b>${d.grammar.checked}</b> 句，<b>${pct(d.grammar.rate)}</b> 完全沒問題。</div>` : ""}
      </div>

      <div class="card">
        <h3>最難的字</h3>
        <p class="dv-sub">忘記兩次以上的字，忘越多次排越前面。</p>
        ${d.leeches.length ? `<div class="leech-list">${d.leeches.map(v => `
          <div class="leech"><span class="lw">${esc(v.word)}</span><span class="muted">${esc(v.zh || "")}</span>
          <span class="lc" data-tip="${esc(`忘記 ${v.lapses} 次`)}">忘 ${v.lapses} 次</span></div>`).join("")}</div>
          <button class="btn sm" data-act="leeches" style="margin-top:10px">專攻這幾個字</button>`
          : `<p class="muted note">目前沒有反覆忘記的字 👍</p>`}
        ${d.speech.overused.length ? `<h3 style="margin-top:18px">你最常用的「萬用字」</h3>
          <div class="leech-list">${d.speech.overused.map(o => `
            <div class="leech"><span class="lw">${esc(o.w)}</span><span class="lc">${o.n} 次</span>
            <span class="muted">${o.alts.length ? "試試 " + esc(o.alts.join("、")) : "換成具體的名詞"}</span></div>`).join("")}</div>` : ""}
      </div>
    </div>`;

  container.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => act(b.dataset.act, b)));
  attachTips(container);
}

/** 共用的 hover／鍵盤焦點說明框 */
function attachTips(root) {
  let tip = document.getElementById("dvTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "dvTip";
    tip.className = "hm-tip dv-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  const show = (el) => {
    const t = el.dataset.tip;
    if (!t) return;
    tip.textContent = t;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), innerWidth - w - 8) + "px";
    tip.style.top = Math.max(r.top - tip.offsetHeight - 8, 8) + "px";
  };
  root.querySelectorAll("[data-tip]").forEach(el => {
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("focus", () => show(el));
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
    el.addEventListener("blur", () => { tip.hidden = true; });
  });
}

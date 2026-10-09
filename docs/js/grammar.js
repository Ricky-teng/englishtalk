/**
 * grammar.js — 文法修正：每句話說完，就在那句話底下標出更正確的說法
 *
 * 設計原則：
 *   1. 絕不打斷對話。AI 照樣自然回話、不糾正你；修正只「寫」在你那句話底下，不念出來。
 *   2. 省額度。不是每句都各打一次 API：
 *      - 一次只有一個請求在跑，跑的期間你說的句子先排隊，下一次「一起」送出去；
 *        講得越快，合併得越多，請求數自然變少。
 *      - 太短的句子（Yes. / OK. / Sure, why not.）不送。
 *      - Gemini 改用較輕的 flash-lite 模型，它的免費額度跟對話用的模型分開算。
 *      - 碰到 429（額度暫時用完）就等一下再送，排隊的句子不會遺失；
 *        真的一直不行，對話結束時會再補檢查一次。
 *   3. 語音辨識的錯不算你的錯。提示詞明確要求忽略標點、大小寫、口語贅字與聽錯的字。
 */

import { complete, parseJSON } from "./llm.js";
import { settings, save } from "./store.js";

/** 錯誤類型：給統計用，模型只能從這幾個裡面選 */
export const TYPES = {
  tense: "時態",
  agreement: "主詞動詞一致",
  article: "冠詞",
  preposition: "介系詞",
  plural: "單複數",
  form: "詞性／詞形",
  "word-choice": "用字",
  "word-order": "語序",
  missing: "漏字",
  extra: "多餘的字",
  other: "其他",
};

const BATCH_MAX = 6;
const MIN_WORDS = 3;

const G = {
  pending: [],        // 等待檢查的句子 {text, ctx, node, msg, tries}
  busy: false,
  cooldownUntil: 0,
  timer: null,
  useMainModel: false, // flash-lite 不存在（被汰換）時，改用對話用的模型
  onChange: null,
};

export function initGrammar({ onChange } = {}) { G.onChange = onChange || null; }

export function mode() { return settings().grammarCheck || "live"; }

/** 對話重新開始時清掉排隊（還沒檢查的就不檢查了） */
export function reset() {
  for (const it of G.pending) setPending(it.node, false);
  G.pending = [];
  if (G.timer) { clearTimeout(G.timer); G.timer = null; }
}

const wordCount = (t) => (String(t).match(/[A-Za-z']+/g) || []).length;

/**
 * 把一句話排進檢查。
 * @param {string} text  你說的話
 * @param {string} ctx   這句話之前 AI 說的那句（判斷時態、指涉需要上下文）
 * @param {{root:HTMLElement, body:HTMLElement}} node  畫面上那則訊息
 * @param {Object} msg   對話紀錄裡那則訊息物件；結果會存進 msg.fix，紀錄頁也看得到
 */
export function check(text, ctx, node, msg) {
  if (mode() === "off") return;
  if (wordCount(text) < MIN_WORDS) return;
  const it = { text, ctx: String(ctx || "").slice(-240), node, msg, tries: 0 };
  G.pending.push(it);
  if (mode() === "live") { setPending(node, true); kick(); }
}

/** 有空就送下一批（即時模式由 check() 與上一批結束時觸發） */
export function kick() {
  if (G.busy || !G.pending.length) return;
  const wait = G.cooldownUntil - Date.now();
  if (wait > 0) {
    if (!G.timer) G.timer = setTimeout(() => { G.timer = null; kick(); }, wait + 50);
    return;
  }
  runBatch().then((ok) => {
    if (!G.pending.length || mode() !== "live") return;
    if (ok) setTimeout(kick, 300);
    else kick();                 // 失敗時 kick 會照冷卻時間排下一次
  });
}

/** 對話結束：把剩下的全部檢查完（「對話結束後」模式只在這裡打 API） */
export async function flushAll() {
  if (G.timer) { clearTimeout(G.timer); G.timer = null; }
  for (const it of G.pending) setPending(it.node, true);
  for (let guard = 0; guard < 6 && G.pending.length; guard++) {
    while (G.busy) await new Promise(r => setTimeout(r, 200));
    const wait = G.cooldownUntil - Date.now();
    if (wait > 0) {
      if (wait > 20000) break;            // 額度要等很久就不等了，避免總結卡一直卡著
      await new Promise(r => setTimeout(r, wait + 50));
    }
    const ok = await runBatch();
    if (!ok) break;
  }
  for (const it of G.pending) setPending(it.node, false);   // 檢查不了的就安靜收掉
  G.pending = [];
}

/** 送出一批。回傳 false 表示這次沒成功（額度、網路），句子仍留在佇列 */
async function runBatch() {
  const batch = G.pending.slice(0, BATCH_MAX);
  if (!batch.length) return true;
  G.busy = true;
  try {
    const results = await ask(batch);
    G.pending = G.pending.filter(it => !batch.includes(it));
    batch.forEach((it, i) => apply(it, results[i] || { ok: true }));
    if (G.onChange) G.onChange();
    return true;
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/404/.test(msg) && !G.useMainModel && settings().provider !== "groq") {
      G.useMainModel = true;               // 輕量模型不存在 → 下一次改用對話模型
      return true;
    }
    if (/429/.test(msg)) {
      G.cooldownUntil = Date.now() + 30000;
    } else {
      // 其他錯誤：每句最多重試一次，之後放棄，不要一直重打
      for (const it of batch) it.tries++;
      const dead = batch.filter(it => it.tries >= 2);
      for (const it of dead) setPending(it.node, false);
      G.pending = G.pending.filter(it => !dead.includes(it));
      G.cooldownUntil = Date.now() + 5000;
    }
    console.warn("[grammar]", msg);
    return false;
  } finally {
    G.busy = false;
  }
}

async function ask(batch) {
  const s = settings();
  const list = batch.map((it, i) =>
    `${i + 1}. ${it.ctx ? `(partner had just said: "${it.ctx}")\n   ` : ""}LEARNER: ${it.text}`).join("\n");

  const prompt = `You are an encouraging English teacher checking a Traditional Chinese speaker's SPOKEN English (CEFR ${s.level}). Each LEARNER line was transcribed by speech recognition.

For each numbered LEARNER line, decide whether a good teacher would correct it.

IGNORE completely (these are NOT errors):
- punctuation, capitalization, spelling of names
- fillers, false starts, repetitions (um, uh, I I think, like)
- casual but natural spoken English: contractions, "gonna", short answers and fragments that native speakers also say ("Yeah, pretty good.", "Not really.")
- anything that looks like a speech-recognition mishearing rather than the learner's mistake
- style preferences when the original is already correct

Correct ONLY real grammar or word-choice errors. Keep the learner's own words and meaning; change as little as possible.

Return ONLY a JSON array with one object per line, in order, no markdown fence:
[{"i":1,"ok":true},
 {"i":2,"ok":false,"fixed":"the whole corrected sentence","edits":[{"from":"wrong words","to":"right words","type":"preposition","zh":"繁體中文簡短說明，20字以內"}]}]

"type" must be one of: ${Object.keys(TYPES).join(", ")}.
"zh" explains the rule in Traditional Chinese (never Simplified), e.g. "星期幾前面用 on".
At most 3 edits per line. If unsure, mark ok:true.

LINES:
${list}`;

  const geminiModel = G.useMainModel ? "" : (s.grammarModel || "gemini-2.5-flash-lite");
  const raw = await complete(prompt, { maxTokens: 300 + batch.length * 220, geminiModel, geminiJson: true });
  const arr = parseJSON(raw);
  if (!Array.isArray(arr)) throw new Error("文法檢查回傳格式不正確");

  // 用 i 對回原句；模型漏回的當作沒問題
  return batch.map((it, idx) => {
    const r = arr.find(x => Number(x && x.i) === idx + 1) || arr[idx] || { ok: true };
    return normalize(it.text, r);
  });
}

const squash = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

function normalize(original, r) {
  const fixed = String(r.fixed || "").trim();
  // 改完跟原句只差標點大小寫 → 其實沒錯
  if (r.ok === true || !fixed || squash(fixed) === squash(original)) return { ok: true };
  const edits = (Array.isArray(r.edits) ? r.edits : []).slice(0, 3).map(e => ({
    from: String(e.from || "").trim(),
    to: String(e.to || "").trim(),
    type: TYPES[e.type] ? e.type : "other",
    zh: String(e.zh || "").trim().slice(0, 40),
  })).filter(e => e.from || e.to);
  return { ok: false, fixed, edits: edits.length ? edits : [{ from: "", to: "", type: "other", zh: "" }] };
}

function apply(it, fix) {
  if (it.msg) { it.msg.fix = fix; save(); }
  setPending(it.node, false);
  if (it.node && it.node.root.isConnected) renderFix(it.node.root, it.text, fix, true);
}

/* =========================================================================
   畫面
   ========================================================================= */

function setPending(node, on) {
  if (!node || !node.root) return;
  const head = node.root.querySelector(".msg-head");
  let p = node.root.querySelector(".fx-wait");
  if (on && !p && head) {
    p = document.createElement("span");
    p.className = "fx-wait";
    p.title = "正在檢查文法";
    p.textContent = "檢查中";
    head.appendChild(p);
  } else if (!on && p) p.remove();
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 逐字比對原句與修正句（LCS），標出刪掉與新增的字。
 * 比對時忽略大小寫與標點，所以只有真的換字的地方會被標出來。
 */
export function diffWords(a, b) {
  const A = String(a).trim().split(/\s+/).filter(Boolean);
  const B = String(b).trim().split(/\s+/).filter(Boolean);
  const n = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const m = A.length, k = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(k + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--)
      L[i][j] = n(A[i]) === n(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (op, w) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.w += " " + w; else out.push({ op, w });
  };
  while (i < m && j < k) {
    if (n(A[i]) === n(B[j])) { push("eq", B[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("del", A[i++]);
    else push("ins", B[j++]);
  }
  while (i < m) push("del", A[i++]);
  while (j < k) push("ins", B[j++]);
  return out;
}

/**
 * 把修正結果畫在訊息底下。
 * @param {HTMLElement} root  訊息（對話中的 .msg 或紀錄頁的一行）
 * @param {boolean} withActions  對話中才放「聽 / 跟讀」按鈕
 */
export function renderFix(root, original, fix, withActions = false) {
  if (!root || !fix) return;
  root.querySelectorAll(":scope > .fix, :scope .fx-ok").forEach(n => n.remove());
  if (fix.ok) {
    const head = root.querySelector(".msg-head") || root;
    const ok = document.createElement("span");
    ok.className = "fx-ok";
    ok.title = "文法沒問題";
    ok.textContent = "✓";
    head.appendChild(ok);
    return;
  }
  const box = document.createElement("div");
  box.className = "fix";
  const diff = diffWords(original, fix.fixed).map(p =>
    p.op === "eq" ? esc(p.w) : p.op === "del" ? `<del>${esc(p.w)}</del>` : `<ins>${esc(p.w)}</ins>`).join(" ");
  box.innerHTML = `
    <div class="fx-line"><span class="fx-tag">更好的說法</span><span class="fx-diff">${diff}</span></div>
    ${fix.edits.filter(e => e.zh || e.from || e.to).map(e => `
      <div class="fx-why"><span class="fx-type">${esc(TYPES[e.type] || "其他")}</span>
        ${e.from || e.to ? `<span class="fx-ft"><s>${esc(e.from)}</s> → <b>${esc(e.to)}</b></span>` : ""}
        ${e.zh ? `<span class="fx-zh no-lookup">${esc(e.zh)}</span>` : ""}</div>`).join("")}
    ${withActions ? `<div class="fx-acts"><button class="mini" data-fx="hear">🔊 聽正確說法</button>
      <button class="mini" data-fx="shadow">🎤 跟讀</button></div>` : ""}`;
  if (withActions) {
    box.querySelectorAll("[data-fx]").forEach(b => b.addEventListener("click", () => {
      root.dispatchEvent(new CustomEvent("fix:" + b.dataset.fx, { bubbles: true, detail: fix.fixed }));
    }));
  }
  root.appendChild(box);
}

/* =========================================================================
   統計：最近 N 天最常犯哪一類錯
   ========================================================================= */

export function summarize(sessionList, days = 30) {
  const since = Date.now() - days * 86400000;
  let checked = 0, flagged = 0;
  const by = {};
  for (const s of sessionList || []) {
    if ((s.start || 0) < since) continue;
    for (const m of s.messages || []) {
      if (m.role !== "user" || !m.fix) continue;
      checked++;
      if (m.fix.ok) continue;
      flagged++;
      const seen = new Set();
      for (const e of m.fix.edits || []) {
        if (seen.has(e.type)) continue;       // 同一句同類錯誤只算一次
        seen.add(e.type);
        const row = by[e.type] || (by[e.type] = { type: e.type, label: TYPES[e.type] || "其他", n: 0, examples: [] });
        row.n++;
        if (row.examples.length < 3 && (e.from || e.to)) row.examples.push({ from: e.from, to: e.to, zh: e.zh });
      }
    }
  }
  const types = Object.values(by).sort((a, b) => b.n - a.n);
  return { checked, flagged, rate: checked ? (checked - flagged) / checked : null, types };
}

/**
 * shadow.js — 跟讀（shadowing）發音練習
 *
 * 流程：AI 唸一句 → 你跟著唸 → 逐字比對，綠色是唸到的、紅色是漏掉或被聽錯的。
 * 完全在瀏覽器裡完成（語音合成 + 語音辨識 + 本地比對），不花任何 API 額度。
 *
 * 語音辨識聽不懂的字，通常就是發音不夠清楚的字 —— 所以雖然它不是真正的
 * 發音評分，卻是一個零成本、而且很誠實的「別人聽不聽得懂你」的指標。
 */

import * as TTS from "./tts.js";
import { listenOnce, canListen } from "./listen.js";
import { bumpDaily } from "./store.js";

let hooks = { pauseAudio: () => {}, resumeAudio: () => {} };
let dlg = null;
let sentence = "";
let listening = null;   // listenOnce 回傳的控制物件
let busy = false;

export function initShadow(h) {
  hooks = { ...hooks, ...h };
  build();
}

/* ---------- 比對：最長共同子序列（LCS）對齊 ---------- */

function tokens(text) {
  return String(text || "")
    .replace(/[’‘]/g, "'")
    .split(/\s+/)
    .map(raw => ({ raw, key: norm(raw) }))
    .filter(t => t.raw);
}

// 跟讀要比「完全一樣的字形」，不做詞幹化：
// 把 happened 唸成 happen、把 plans 唸成 plan，正是要被抓出來的發音問題（字尾 -ed、-s 被吃掉）。
// 只放寬語音辨識常見、但發音上等價的寫法。
const SAME = { okay: "ok", alright: "all right", gonna: "going to", wanna: "want to" };
function norm(w) {
  const t = w.toLowerCase().replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, "");
  return SAME[t] || t;
}

/**
 * 回傳目標句每個字有沒有被唸到。
 * 用 LCS 而不是逐位置比對：你多講或少講一個字，後面的字才不會全部被判錯。
 */
export function alignWords(target, spoken) {
  const T = tokens(target);
  const S = tokens(spoken).filter(t => t.key);
  const n = T.length, m = S.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = (T[i].key && T[i].key === S[j].key)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hit = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (T[i].key && T[i].key === S[j].key) { hit[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const scored = T.map((t, k) => ({ raw: t.raw, ok: !t.key || hit[k], counts: !!t.key }));
  const total = scored.filter(x => x.counts).length;
  const good = scored.filter(x => x.counts && x.ok).length;
  return { words: scored, score: total ? Math.round(good / total * 100) : 0 };
}

/* ---------- 介面 ---------- */

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "modal shadow-dlg";
  dlg.id = "dlgShadow";
  dlg.innerHTML = `
    <div class="m-head">
      <h2>跟讀練習</h2>
      <p class="note" style="margin:0">先聽，再跟著唸一次。紅色的字是語音辨識沒聽出來的 —— 通常就是要多練的發音。</p>
    </div>
    <div class="m-body">
      <div class="sh-target" id="shTarget"></div>
      <div class="sh-status" id="shStatus"></div>
      <div class="sh-heard" id="shHeard"></div>
      <div class="sh-score" id="shScore" hidden></div>
    </div>
    <div class="m-foot sh-foot">
      <button class="btn sm ghost" id="shPlay" title="正常速度再聽一次">🔊 再聽</button>
      <button class="btn sm ghost" id="shSlow" title="慢速播放">🐢 慢速</button>
      <button class="btn sm primary" id="shRec">🎤 跟讀</button>
      <div class="spacer"></div>
      <button class="btn sm" id="shClose">完成</button>
    </div>`;
  document.body.appendChild(dlg);

  dlg.querySelector("#shPlay").addEventListener("click", () => play(false));
  dlg.querySelector("#shSlow").addEventListener("click", () => play(true));
  dlg.querySelector("#shRec").addEventListener("click", () => record());
  dlg.querySelector("#shClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => {
    if (listening) { listening.stop(); listening = null; }
    TTS.stop();
    busy = false;
    hooks.resumeAudio();
  });
}

function $(id) { return dlg.querySelector("#" + id); }

function paintTarget(result) {
  const box = $("shTarget");
  box.textContent = "";
  const words = result ? result.words : tokens(sentence).map(t => ({ raw: t.raw, ok: null }));
  words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "sh-w" + (w.ok === true ? " ok" : w.ok === false ? " miss" : "");
    span.textContent = w.raw;
    box.appendChild(span);
    if (i < words.length - 1) box.appendChild(document.createTextNode(" "));
  });
}

function status(t) { $("shStatus").textContent = t; }

async function play(slow) {
  if (listening) { listening.stop(); listening = null; }
  status(slow ? "慢速播放中…" : "播放中…");
  await TTS.speak(sentence, undefined, null, slow ? 0.7 : undefined);
  status("輪到你了，按「跟讀」然後唸一次。");
}

async function record() {
  if (busy) return;
  if (!canListen()) {
    status("這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge。");
    return;
  }
  busy = true;
  TTS.stop();
  $("shScore").hidden = true;
  $("shHeard").textContent = "";
  paintTarget(null);
  status("🎙️ 請唸…（停頓一下就會自動結束）");
  $("shRec").disabled = true;

  listening = listenOnce({
    silenceMs: 1500,
    onInterim: (t) => { $("shHeard").textContent = "聽到：" + t; },
  });

  let spoken = "";
  try {
    spoken = await listening.promise;
  } catch (e) {
    status(e.message);
    busy = false;
    $("shRec").disabled = false;
    return;
  }
  listening = null;
  busy = false;
  $("shRec").disabled = false;

  if (!spoken) {
    status("沒有聽到聲音。確認麥克風有開，再試一次。");
    return;
  }

  const r = alignWords(sentence, spoken);
  paintTarget(r);
  $("shHeard").textContent = "聽到：" + spoken;
  const sc = $("shScore");
  sc.hidden = false;
  sc.className = "sh-score " + (r.score >= 90 ? "great" : r.score >= 70 ? "good" : "try");
  sc.innerHTML = `<b>${r.score}%</b> ` + (
    r.score >= 90 ? "太好了，幾乎每個字都被聽懂了。" :
    r.score >= 70 ? "很接近了，把紅色的字再唸清楚一點。" :
    "先按「慢速」聽一次，特別注意紅色的字。");
  status("");
  bumpDaily({ shadows: 1 });
}

/** 打開跟讀視窗。text 是要練的那句英文。 */
export async function openShadow(text) {
  sentence = String(text || "").replace(/\s+/g, " ").trim();
  if (!sentence) return;
  hooks.pauseAudio();
  $("shHeard").textContent = "";
  $("shScore").hidden = true;
  paintTarget(null);
  if (!dlg.open) dlg.showModal();
  await play(false);
}

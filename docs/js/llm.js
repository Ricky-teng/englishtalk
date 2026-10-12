/**
 * llm.js — 直接從瀏覽器呼叫 Gemini / Groq
 *
 * 架構說明：純靜態部署，沒有後端，金鑰由使用者自備並存在自己的瀏覽器。
 * 好處是你不用付任何費用、也不會被別人刷爆額度；代價是要靠供應商的 CORS 支援。
 *   - Gemini：官方 JS SDK 就是在瀏覽器跑的，CORS 開放，預設用這個。
 *   - Groq：多數情況可直連；萬一被 CORS 擋住，會丟出明確訊息請使用者改用 Gemini。
 *
 * 備援：主要的 AI 出問題（額度用完、連不上、伺服器忙、模型下架）時，自動換下一個能用的模型，
 * 對話不會斷。每次呼叫都記進 usage.js，「紀錄」頁看得到用量。
 */

import { settings } from "./store.js";
import { AUTO_TOOL, info as modelInfo } from "./models.js";
import * as Usage from "./usage.js";

/* ---------- 連線：逾時、自動重試、把錯誤翻成人話 ---------- */

const RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 網路層失敗（Failed to fetch / NetworkError / Load failed）時給的說明 */
function networkMessage(who) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "目前沒有網路連線，連上之後再試一次。";
  return who === "Groq"
    ? "連不上 Groq（已自動重試）。最常見的原因是這一分鐘的免費額度用完了 —— Groq 擋下請求時，瀏覽器常常只顯示「Failed to fetch」。等 30 秒到 1 分鐘再試；一直發生的話，到設定把「查字用的模型」設成自動，或改用 Gemini。"
    : `連不上 ${who}（已自動重試）。通常是網路一時不穩；如果一直發生，檢查廣告封鎖等擴充功能是否擋了 googleapis.com。`;
}

/* ---------- Groq：免費額度很緊，要自己排隊 ---------- */
//
// Groq 免費方案每個模型各自計算：每分鐘約 30 次請求，以及「每分鐘 token 數」（TPM），
// llama-3.1-8b-instant 只有幾千。對話、查字、文法檢查、詞性補查擠在同一分鐘，
// 很容易超過 → 429。更麻煩的是，被擋下的回應有時沒有跨來源標頭，
// 瀏覽器只會顯示「Failed to fetch」，看不出是額度問題。
// 所以這裡在送出前先自己算：這一分鐘還剩多少，不夠就等一下再送（對話優先、背景工作讓路）。

const GROQ_LIMITS = [            // 依模型名稱比對；保守取官方數字的 85%
  [/8b-instant/i, { rpm: 30, tpm: 6000 }],
  [/70b/i,        { rpm: 30, tpm: 12000 }],
  [/gpt-oss/i,    { rpm: 30, tpm: 8000 }],
];
const groqLedger = new Map();    // model → [{t, tokens}]
const groqBlocked = new Map();   // model → 伺服器說要等到幾點（429 的 retry-after）

function groqLimit(model) {
  const hit = GROQ_LIMITS.find(([re]) => re.test(model));
  const l = hit ? hit[1] : { rpm: 30, tpm: 6000 };
  return { rpm: Math.floor(l.rpm * 0.85), tpm: Math.floor(l.tpm * 0.85) };
}

/** 粗估 token：英文約 4 字元一個，中文約 1 字一個 */
export function estTokens(text) {
  const t = String(text || "");
  const cjk = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.ceil((t.length - cjk) / 4 + cjk);
}

/**
 * 等到這個模型這一分鐘還有額度再送。
 * @param {"chat"|"fg"|"bg"} priority  chat：最多等 1.5 秒就送；fg（你在等的查字）：最多 25 秒；bg（文法等背景工作）：等到有為止
 * @returns {Object} 帳本裡這筆紀錄，收到回應後用實際用量更正
 */
async function groqGate(model, tokens, priority = "fg") {
  const { rpm, tpm } = groqLimit(model);
  const maxWait = priority === "chat" ? 1500 : priority === "fg" ? 25000 : 120000;
  const start = Date.now();
  if (!groqLedger.has(model)) groqLedger.set(model, []);
  const log = groqLedger.get(model);
  for (;;) {
    const now = Date.now();
    while (log.length && now - log[0].t > 60000) log.shift();
    const used = log.reduce((a, x) => a + x.tokens, 0);
    const blocked = (groqBlocked.get(model) || 0) - now;
    const fits = log.length < rpm && (used + tokens <= tpm || !log.length);
    if (fits && blocked <= 0) break;
    if (priority === "chat-fast") {
      // 有備援可以換：這一分鐘的額度明顯不夠就直接放棄，讓對話改用備援，不要卡住
      const e = new Error("Groq 這一分鐘的免費額度快用完了（本機估算）。");
      e.status = 429; e.local = true;
      throw e;
    }
    if (now - start >= maxWait) break;
    // 要等多久：等到最舊的那筆過期，或伺服器指定的時間
    const wait = Math.max(blocked, log.length ? 60000 - (now - log[0].t) + 50 : 500);
    await sleep(Math.min(wait, 2000, Math.max(50, maxWait - (now - start))));
  }
  const entry = { t: Date.now(), tokens };
  log.push(entry);
  return entry;
}

/** 從 Groq 的回應標頭讀「還剩多少」；讀不到（瀏覽器沒開放）就算了 */
function groqReadHeaders(model, resp) {
  try {
    const ra = Number(resp.headers.get("retry-after"));
    if (resp.status === 429 && ra > 0) groqBlocked.set(model, Date.now() + ra * 1000);
    const rpd = Number(resp.headers.get("x-ratelimit-limit-requests"));
    const rem = Number(resp.headers.get("x-ratelimit-remaining-requests"));
    if (rpd > 0 && Number.isFinite(rem)) Usage.setLimit("groq", model, { rpd, remaining: rem });
    const left = Number(resp.headers.get("x-ratelimit-remaining-tokens"));
    const reset = String(resp.headers.get("x-ratelimit-reset-tokens") || "");
    const m = reset.match(/([\d.]+)(ms|s|m)/);
    if (Number.isFinite(left) && left < 600 && m) {
      const ms = Number(m[1]) * (m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : 60000);
      groqBlocked.set(model, Date.now() + Math.min(ms, 60000));
    }
  } catch (e) { /* 標頭沒有開放給瀏覽器讀 */ }
}

/**
 * 查字、新增單字、文法、詞性補查用哪個模型（kind = "tool"）；對話用 kind = "chat"。
 * 「自動」：Groq 用 llama-3.3-70b-versatile、Gemini 用 gemini-3.5-flash-lite ——
 * 中文和格式穩，而且額度跟對話用的模型分開算，背景工作不會吃掉對話的額度。
 */
export function modelFor(provider, kind) {
  const s = settings();
  const chat = provider === "groq" ? s.groqModel : s.geminiModel;
  if (kind === "chat") return chat;
  const t = (provider === "groq" ? s.groqToolModel : s.geminiToolModel) || "auto";
  if (t === "same") return chat;
  return t === "auto" ? AUTO_TOOL[provider] : t;
}
export function groqModelFor(kind) { return modelFor("groq", kind); }

/* ---------- 備援：主要的 AI 出問題時，自動換下一個 ---------- */
//
// 候選順序（只列有金鑰的）：
//   對話：主要供應商的對話模型 → 同一家另一個快的模型（額度分開算）→ 另一家的對話模型
//   查字：主要供應商的查字模型 → 主要供應商的對話模型 → 另一家的查字模型 → 另一家的對話模型
// 某個模型失敗後先「休息」一陣子（額度用完 1 分鐘、網路或伺服器問題 30 秒、模型不存在一整天），
// 這段時間直接用下一個，不用每次都先失敗一次再換；時間到了自動回到主要的。

const ALT_FAST = {   // 同一家裡可以接手對話的快速模型
  groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
  gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"],
};
const down = new Map();                      // "provider|model" → 休息到幾點
const downWhy = new Map();                   // "provider|model" → 為什麼休息（顯示用）
const keyOf = (c) => c.provider + "|" + c.model;
const isDown = (c) => (down.get(keyOf(c)) || 0) > Date.now();

function hasKey(p) { const s = settings(); return !!(p === "groq" ? s.groqKey : s.geminiKey); }

/** 這次呼叫可以用的模型，依序排好 */
export function candidates(kind, { noFailover = false } = {}) {
  const s = settings();
  const P = s.provider === "groq" ? "groq" : "gemini";
  const O = P === "groq" ? "gemini" : "groq";
  const list = [];
  const add = (p, m) => {
    if (m && hasKey(p) && !list.some(c => c.provider === p && c.model === m)) list.push({ provider: p, model: m });
  };
  add(P, modelFor(P, kind));
  if (noFailover) return list.length ? list : [{ provider: P, model: modelFor(P, kind) }];
  if (kind === "tool") add(P, modelFor(P, "chat"));
  if (s.fallback !== false) {
    if (kind === "chat") add(P, ALT_FAST[P].find(m => m !== modelFor(P, "chat")));
    add(O, modelFor(O, kind));
    if (kind === "tool") add(O, modelFor(O, "chat"));
  }
  return list;
}

/** 休息中的排到最後（全部都在休息時還是會照順序試） */
function ordered(kind, opts) {
  const list = candidates(kind, opts);
  return [...list.filter(c => !isDown(c)), ...list.filter(isDown)];
}

/** 失敗的原因 → 要休息多久、要不要換下一個 */
function classify(e) {
  if (e.noFailover) return { failover: false };
  const st = e.status;
  if (st === 429) return { failover: true, rest: 60000, reason: "額度用完" };
  if (st === 404) return { failover: true, rest: 24 * 3600000, reason: "模型不存在" };
  if (st === 401 || st === 403) return { failover: true, rest: 10 * 60000, reason: "金鑰或權限有問題" };
  if (st === 413) return { failover: true, rest: 0, reason: "內容太長" };
  if (st >= 500) return { failover: true, rest: 30000, reason: "伺服器忙" };
  if (e.net) return { failover: true, rest: 30000, reason: "連不上" };
  if (st === 400) return { failover: true, rest: 0, reason: "請求被拒" };
  return { failover: true, rest: 15000, reason: "回應有問題" };
}

const nameOf = (c) => {
  const m = modelInfo(c.provider, c.model);
  return (c.provider === "groq" ? "Groq " : "") + (m ? m.name : c.model);
};

/** 目前對話實際在用哪個（給畫面顯示「備援中」） */
export const route = { chat: null, backup: false };

/** 換到備援、或回到主要的時候通知畫面（只通知對話用的，查字靜靜換就好） */
function announce(kind, c, backup, why) {
  if (kind !== "chat") return;
  const was = route.backup;
  route.chat = c; route.backup = backup;
  if (backup !== was || (backup && route.lastName !== nameOf(c))) {
    route.lastName = nameOf(c);
    window.dispatchEvent(new CustomEvent("llm:route", { detail: { backup, name: nameOf(c), why } }));
  }
}

/** 照順序試，失敗就換下一個；每一次嘗試都記進用量 */
async function runWithFailover(kind, attempt, { purpose, noFailover = false } = {}) {
  const list = ordered(kind, { noFailover });
  if (!list.length || !hasKey(list[0].provider)) {
    throw new Error("尚未設定 API 金鑰。到右上角「設定」貼上 Groq 或 Gemini 的免費金鑰。");
  }
  const primary = candidates(kind, { noFailover })[0];
  let firstErr = null;
  // 主要的還在休息 → 提示裡說的是它為什麼不能用，不是第一個試的備援
  let why = isDown(primary) ? `${nameOf(primary)}：${downWhy.get(keyOf(primary)) || "暫時不能用"}` : "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const isBackup = keyOf(c) !== keyOf(primary);
    try {
      const r = await attempt(c, { hasBackup: i < list.length - 1 });
      Usage.record({ ...c, purpose, ok: true, tokens: r.tokens, backup: isBackup });
      down.delete(keyOf(c));
      announce(kind, c, isBackup, why);
      return r.text;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const k = classify(e);
      if (!e.local) Usage.record({ ...c, purpose, ok: false, reason: k.reason || e.message.slice(0, 60) });
      if (!k.failover) throw e;
      if (k.rest) { down.set(keyOf(c), Date.now() + k.rest); downWhy.set(keyOf(c), k.reason || ""); }
      if (!firstErr) firstErr = e;
      if (!why) why = `${nameOf(c)}${k.reason ? "：" + k.reason : ""}`;
    }
  }
  if (list.length > 1) {
    const e = new Error(`${firstErr.message}（備援的 AI 也都連不上，等一下再試）`);
    e.status = firstErr.status;
    throw e;
  }
  throw firstErr;
}

/** 設定改了（換模型、換金鑰）就把「休息中」清掉，重新試 */
export function resetModelFallback() { down.clear(); noThinkCfg.clear(); noReasonCfg.clear(); }

/** 把 HTTP 錯誤轉成帶狀態碼的 Error，備援判斷要用 */
async function httpError(resp, who) {
  const e = new Error(await describeError(resp, who));
  e.status = resp.status;
  return e;
}

/**
 * fetch 加上逾時與自動重試。
 * 會重試：網路層失敗（Failed to fetch）、逾時、500/502/503/504（伺服器忙），以及一次 429。
 * 不會重試：401/403/404 這種重試也沒用的錯誤；使用者自己按停止（外部 signal）。
 * 串流請求只會在「還沒收到任何回應」之前重試，不會重複念出已經念過的句子。
 */
async function fetchRetry(url, init, { who = "Gemini", tries = 3, timeoutMs = 30000, retry429 = true, fast = false } = {}) {
  const outer = init.signal;
  let last429 = !retry429;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (outer) { if (outer.aborted) throw new DOMException("Aborted", "AbortError"); outer.addEventListener("abort", onAbort, { once: true }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      const retry = (RETRY_STATUS.has(resp.status) || (resp.status === 429 && !last429)) && i < tries - 1;
      if (!retry) return resp;      // 成功：外部的停止訊號要繼續連著，串流讀到一半才停得下來
      if (outer) outer.removeEventListener("abort", onAbort);
      if (resp.status === 429) {
        last429 = true;
        const ra = Number(resp.headers.get("retry-after"));
        await sleep(ra > 0 && ra <= 20 ? ra * 1000 + 200 : 4000);
      } else await sleep(800 * (i + 1) ** 2);
    } catch (e) {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
      if (outer && outer.aborted) throw e;                 // 使用者自己中止，直接往外丟
      if (i === tries - 1) {
        const err = new Error(timedOut ? `${who} 太久沒有回應（已重試）。網路慢或伺服器忙，等一下再試。` : networkMessage(who));
        err.net = true;
        throw err;
      }
      // Groq 被限流時，回應常常沒有跨來源標頭 → 瀏覽器只看到 Failed to fetch。等久一點再試。
      // 有備援的對話不等那麼久：快點換備援比較重要。
      await sleep(fast ? 500 : who === "Groq" ? 2500 * (i + 1) ** 2 : 700 * (i + 1) ** 2);
    }
  }
  const err = new Error(networkMessage(who));
  err.net = true;
  throw err;
}

/**
 * 思考設定：思考用掉的 token 也算在 maxOutputTokens 裡，回覆容易被截斷（JSON 不完整 →「查詢失敗」），
 * 第一句話也會變慢。對話與查字不需要深度推理，所以一律開到最低：
 *   - 2.5 Flash 系列：thinkingBudget 0（完全關掉）
 *   - 3.x：thinkingLevel 設成該模型支援的最低一級（minimal 或 low）
 *   - 其他（例如 2.5 Pro 不能關）：不指定，但多給 token 額度
 * 萬一模型不認得這個設定（400），就拿掉設定再送一次，並記住這個模型不要再帶。
 */
const noThinkCfg = new Set();
const MINIMAL_OK = /3\.5-flash|3\.6-flash|3-flash-preview/i;
function geminiThinking(model) {
  if (noThinkCfg.has(model)) return null;
  if (/2\.5-flash/i.test(model)) return { thinkingBudget: 0 };
  const m = String(model).match(/gemini-(\d+)/i);
  if (m && Number(m[1]) >= 3) return { thinkingLevel: MINIMAL_OK.test(model) ? "minimal" : "low" };
  return null;
}
function geminiGenConfig(model, maxTokens, extra = {}) {
  const think = geminiThinking(model);
  const off = think && think.thinkingBudget === 0;
  return {
    maxOutputTokens: off ? maxTokens : maxTokens + (think ? 1024 : 2048),
    ...(think ? { thinkingConfig: think } : {}),
    ...extra,
  };
}
/** 400 而且錯誤訊息提到 thinking → 這個模型不吃這個設定 */
async function thinkingRejected(model, resp) {
  if (resp.status !== 400 || noThinkCfg.has(model) || !geminiThinking(model)) return false;
  const t = await resp.clone().text().catch(() => "");
  if (/thinking/i.test(t)) { noThinkCfg.add(model); return true; }
  return false;
}

/* ---------- 系統提示 ---------- */

function systemPrompt({ level, persona, scenario, dueWords, invite }) {
  let p = `You are ${persona}. You are having a REAL-TIME SPOKEN conversation with a language \
learner whose English level is roughly ${level} (CEFR). Your output is read aloud by a \
text-to-speech engine, so it must sound like natural speech.

Hard rules:
- Reply in ENGLISH ONLY. Never use Chinese characters, emoji, markdown, bullet points, \
asterisks, parentheses, or stage directions. Plain spoken sentences only.
- Keep every reply SHORT: 1 to 3 sentences, under about 45 words.
- Sound like a person, not an assistant. Use contractions and natural reactions. React to \
what they said before adding your own bit.
- Almost always end with one light, specific follow-up question. Never two questions at once.
- Match your vocabulary and sentence length to a ${level} learner.
- If the transcript looks garbled, guess the intended meaning and keep the conversation \
flowing. Never comment on their grammar, never correct them, never mention that you are an AI.
- Write numbers and dates the way they are spoken ("twenty twenty six", not "2026").`;

  if (scenario) {
    p += `\n\nRole-play setting: ${scenario} Stay in that role for the whole conversation.`;
  }
  if (dueWords && dueWords.length) {
    // 注意這裡的語氣：是「剛好合適才用」，不是「想辦法用進去」。
    // 出現頻率由外面的機率閘門控制（有些回合根本不會走到這段），
    // 所以這段只要負責「用得自然」，不需要也不該負責「一定要用到」。
    p += `\n\nVOCABULARY (never mention any of this to the learner):
The learner happens to be studying these words: ${dueWords.join(", ")}.
If — and ONLY if — one of them fits what you were going to say anyway, use it.
Do NOT change the subject to fit a word in. Do NOT steer toward a topic where a word would \
belong. Do NOT use more than one. Using NONE of them is a perfectly good outcome: sounding like \
a real person matters far more than hitting a word. A conversation that is obviously fishing for \
vocabulary is worse than useless.`;
    if (invite) {
      p += `\nIf you do use one and it still feels natural, your follow-up question can be one \
the learner would likely answer using that same word — but only if that question is something a \
real person would actually ask here.`;
    }
  }
  return p;
}

/* ---------- 串流對話 ---------- */

/**
 * 串流產生回覆（主要的 AI 不行就自動換備援；已經開始念的回覆不會中途換，避免重複）。
 * @param {Array} messages  [{role:'user'|'assistant', content}]
 * @param {Object} opts     {scenario, dueWords, invite, signal}
 * @param {Function} onDelta 每收到一段文字就呼叫
 * @returns {Promise<string>} 完整回覆
 */
export async function chatStream(messages, opts, onDelta) {
  const s = settings();
  const sys = systemPrompt({
    level: s.level,
    persona: s.persona,
    scenario: opts.scenario,
    dueWords: opts.dueWords,
    invite: opts.invite,
  });
  return runWithFailover("chat", async (c, { hasBackup }) => {
    let got = "";
    const relay = (d) => { got += d; onDelta(d); };
    try {
      return c.provider === "groq"
        ? await groqStream(c.model, sys, messages, opts.signal, relay, hasBackup)
        : await geminiStream(c.model, sys, messages, opts.signal, relay, hasBackup);
    } catch (e) {
      // 已經念出一部分了：不換備援（會重複），把念到的當成這次的回覆
      if (got && e.name !== "AbortError") return { text: got, tokens: estTokens(sys + got) };
      throw e;
    }
  }, { purpose: "chat" });
}

async function readSSE(resp, signal, onEvent) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (signal && signal.aborted) { try { await reader.cancel(); } catch (e) {} break; }
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        onEvent(obj);
      }
    }
  }
}

async function groqStream(model, sys, messages, signal, onDelta, hasBackup) {
  const s = settings();
  const est = estTokens(sys + JSON.stringify(messages)) + 120;
  // 有備援時：額度不夠就直接換、不排隊；429 不重試；網路失敗只重試一次
  await groqGate(model, est, hasBackup ? "chat-fast" : "chat");
  const send = () => fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + s.groqKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      ...groqReasoning(model),
      temperature: 0.85,
      max_tokens: 220,
      messages: [{ role: "system", content: sys }, ...messages],
    }),
    signal,
  }, { who: "Groq", timeoutMs: hasBackup ? 12000 : 20000, tries: hasBackup ? 2 : 3, retry429: !hasBackup, fast: hasBackup });
  let resp = await send();
  groqReadHeaders(model, resp);
  if (resp.status === 400 && !noReasonCfg.has(model) && Object.keys(groqReasoning(model)).length
      && /reasoning/i.test(await resp.clone().text().catch(() => ""))) {
    noReasonCfg.add(model);            // 這個模型不吃推理參數 → 拿掉再送一次
    resp = await send();
  }
  if (!resp.ok) throw await httpError(resp, "Groq");

  let full = "", tokens = 0;
  await readSSE(resp, signal, (obj) => {
    const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (d && d.content) { full += d.content; onDelta(d.content); }
    const u = obj.usage || (obj.x_groq && obj.x_groq.usage);
    if (u && u.total_tokens) tokens = u.total_tokens;
  });
  return { text: full, tokens: tokens || est + estTokens(full) };
}

async function geminiStream(model, sys, messages, signal, onDelta, hasBackup) {
  const s = settings();
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(model) + ":streamGenerateContent?alt=sse";
  const send = () => fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: geminiGenConfig(model, 240, { temperature: 0.85 }),
    }),
    signal,
  }, { who: "Gemini", timeoutMs: hasBackup ? 12000 : 20000, tries: hasBackup ? 2 : 3, retry429: !hasBackup, fast: hasBackup });
  let resp = await send();
  if (await thinkingRejected(model, resp)) resp = await send();
  if (!resp.ok) throw await httpError(resp, "Gemini");

  let full = "", tokens = 0;
  await readSSE(resp, signal, (obj) => {
    for (const cand of (obj.candidates || [])) {
      for (const part of ((cand.content && cand.content.parts) || [])) {
        if (part.text && !part.thought) { full += part.text; onDelta(part.text); }
      }
    }
    if (obj.usageMetadata && obj.usageMetadata.totalTokenCount) tokens = obj.usageMetadata.totalTokenCount;
  });
  return { text: full, tokens: tokens || estTokens(sys + JSON.stringify(messages) + full) };
}

/* ---------- 一次性呼叫（單字查詢等，不需要串流） ---------- */

/**
 * @param {Object} o
 *   json：要求回一個 JSON 物件（兩家都支援）
 *   geminiJson：要 JSON 陣列（Gemini 開 JSON 模式；Groq 包成 {"items":[...]} 再拆開）
 *   priority：fg = 你正在等結果（查字）；bg = 背景工作（文法、補詞性），Groq 額度緊時讓路
 *   kind：tool（查字等，預設）或 chat（用對話模型，例如測試連線）
 *   purpose：用量統計的分類（chat / grammar / lookup）
 *   noFailover：不要換備援（測試連線要測的就是這一個）
 *   geminiModel：直接指定 Gemini 模型（不走備援）
 */
export async function complete(prompt, { json = false, maxTokens = 600, geminiModel = "", geminiJson = false,
                                         priority = "fg", kind = "tool", purpose = "lookup", noFailover = false } = {}) {
  const o = { json, maxTokens, geminiJson, priority };
  if (geminiModel) return (await geminiCall(geminiModel, prompt, o)).text;
  return runWithFailover(kind, (c) => c.provider === "groq" ? groqCall(c.model, prompt, o) : geminiCall(c.model, prompt, o),
                         { purpose, noFailover });
}

async function geminiCall(model, prompt, { json, maxTokens, geminiJson }) {
  const s = settings();
  if (!s.geminiKey) throw Object.assign(new Error("尚未設定 Gemini API 金鑰"), { status: 401 });
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(model) + ":generateContent";
  let budget = maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetchRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: geminiGenConfig(model, budget, {
          temperature: 0.3,
          ...(json || geminiJson ? { responseMimeType: "application/json" } : {}),
        }),
      }),
    }, { who: "Gemini" });
    if (!resp.ok) {
      if (await thinkingRejected(model, resp)) continue;
      throw await httpError(resp, "Gemini");
    }
    const d = await resp.json();
    const cand = (d.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    // 回到一半被 token 上限截斷 → 給兩倍額度再要一次（不然 JSON 不完整就會「查詢失敗」）
    if (cand.finishReason === "MAX_TOKENS" && budget === maxTokens) { budget *= 2; continue; }
    if (!text && cand.finishReason === "SAFETY") {
      throw Object.assign(new Error("Gemini 拒絕回答這個內容（安全過濾）。"), { noFailover: true });
    }
    const tokens = (d.usageMetadata && d.usageMetadata.totalTokenCount) || estTokens(prompt + text);
    return { text, tokens };
  }
  throw new Error("回應太長被截斷了，再試一次。");
}

/**
 * 推理型模型（gpt-oss、qwen）在 Groq 上可以調低思考程度、把思考過程藏起來，
 * 不然會慢、會吃額度，qwen 還可能把 <think>…</think> 混進回覆裡被念出來。
 * 參數不被接受（400）時拿掉再送，並記住。
 */
const noReasonCfg = new Set();
function groqReasoning(model) {
  if (noReasonCfg.has(model)) return {};
  if (/gpt-oss/i.test(model)) return { reasoning_effort: "low", include_reasoning: false };
  if (/qwen/i.test(model)) return { reasoning_format: "hidden" };
  return {};
}
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>\s*/g, "");

/**
 * Groq 的一次性呼叫。
 * - 先排隊（groqGate），不要一口氣把每分鐘額度用完
 * - 要 JSON 陣列時，請模型包成 {"items":[...]}，這樣就能開 Groq 的 JSON 模式（它只接受物件），回傳時再拆開
 * - JSON 模式驗證失敗（小模型偶爾會）→ 關掉 JSON 模式再要一次，交給 parseJSON 去挖
 */
async function groqCall(model, prompt, { json, maxTokens, geminiJson, priority }) {
  const s = settings();
  if (!s.groqKey) throw Object.assign(new Error("尚未設定 Groq API 金鑰"), { status: 401 });
  const wrap = geminiJson && !json;                 // 要陣列 → 包成物件
  const text = wrap ? prompt + '\n\nIMPORTANT: wrap the JSON array in an object like {"items": [ ... ]} and return only that object.' : prompt;
  // 免費方案每分鐘 token 很少，單次請求的上限不要開太大
  const maxOut = Math.min(maxTokens, 2400);
  let useJson = json || wrap;
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await groqGate(model, estTokens(text) + Math.round(maxOut * 0.6), priority);
    const resp = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + s.groqKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: maxOut,
        messages: [{ role: "user", content: text }],
        ...(useJson ? { response_format: { type: "json_object" } } : {}),
        ...groqReasoning(model),
      }),
    }, { who: "Groq" });
    groqReadHeaders(model, resp);
    if (!resp.ok) {
      const err = await httpError(resp, "Groq");
      if (resp.status === 400 && /reasoning/i.test(err.message) && !noReasonCfg.has(model)) { noReasonCfg.add(model); continue; }
      if (resp.status === 400 && useJson && /json/i.test(err.message)) { useJson = false; continue; }
      if (resp.status === 413) err.message = "這次要查的內容太長，超過 Groq 免費方案單次上限。分成少一點再試。";
      throw err;
    }
    const d = await resp.json();
    const tokens = (d.usage && d.usage.total_tokens) || estTokens(text) + 200;
    entry.tokens = tokens;                                   // 用實際用量更正帳本
    const out = stripThink((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "");
    if (!wrap) return { text: out, tokens };
    try {
      const obj = parseJSON(out);
      if (Array.isArray(obj)) return { text: JSON.stringify(obj), tokens };
      const arr = obj.items || Object.values(obj).find(Array.isArray);
      return { text: JSON.stringify(arr || []), tokens };
    } catch (e) { return { text: out, tokens }; }
  }
  throw new Error("Groq 查詢失敗，請再試一次。");
}

/** 從回應中挖出 JSON（模型偶爾會多包一層 ``` 或前後文字） */
export function parseJSON(text) {
  if (!text) throw new Error("回應是空的");
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* 繼續嘗試 */ }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("模型沒有回傳有效的 JSON");
}

/* ---------- 模型清單 ---------- */

export async function listModels(provider) {
  const s = settings();
  if (provider === "groq") {
    if (!s.groqKey) throw new Error("尚未設定 Groq API 金鑰");
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": "Bearer " + s.groqKey },
    });
    if (!r.ok) throw new Error(await describeError(r, "Groq"));
    const d = await r.json();
    return (d.data || [])
      .map(m => m.id)
      .filter(id => id && !/whisper|tts|guard|embed/i.test(id))
      .sort();
  }
  if (!s.geminiKey) throw new Error("尚未設定 Gemini API 金鑰");
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { headers: { "x-goog-api-key": s.geminiKey } });
  if (!r.ok) throw new Error(await describeError(r, "Gemini"));
  const d = await r.json();
  return (d.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => (m.name || "").replace("models/", ""))
    .filter(n => n && !/embed|image|imagen|veo/i.test(n))
    .sort();
}

/* ---------- 錯誤訊息：把 API 的原始回應翻成人話 ---------- */

async function describeError(resp, who) {
  let detail = "";
  try { detail = (await resp.text()).slice(0, 400); } catch (e) {}
  const code = resp.status;
  if (code === 401 || code === 403) {
    return `${who} 金鑰無效或沒有權限（${code}）。請到設定重新貼一次金鑰。`;
  }
  if (code === 404) {
    return `${who} 找不到這個模型（404）。請到設定按「抓取可用清單」重選一個。`;
  }
  if (code === 429) {
    return `${who} 免費額度暫時用完了（429）。等一分鐘再試，或到設定切換另一個供應商。`;
  }
  if (code >= 500) {
    return `${who} 伺服器暫時忙碌（${code}），已自動重試仍失敗。等一下再試。`;
  }
  if (code === 400 && /API key/i.test(detail)) {
    return `${who} 金鑰格式不對（400）。請到設定重新貼一次金鑰。`;
  }
  return `${who} 回應 ${code}：${detail}`;
}

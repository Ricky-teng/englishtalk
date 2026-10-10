/**
 * llm.js — 直接從瀏覽器呼叫 Gemini / Groq
 *
 * 架構說明：純靜態部署，沒有後端，金鑰由使用者自備並存在自己的瀏覽器。
 * 好處是你不用付任何費用、也不會被別人刷爆額度；代價是要靠供應商的 CORS 支援。
 *   - Gemini：官方 JS SDK 就是在瀏覽器跑的，CORS 開放，預設用這個。
 *   - Groq：多數情況可直連；萬一被 CORS 擋住，會丟出明確訊息請使用者改用 Gemini。
 */

import { settings } from "./store.js";
import { AUTO_TOOL } from "./models.js";

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
    if ((fits && blocked <= 0) || now - start >= maxWait) break;
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
 * 選的模型不能用（404／沒有權限）時自動退回對話模型，直到你在設定換模型為止。
 */
const toolFallback = { groq: false, gemini: false };
export function resetModelFallback() { toolFallback.groq = toolFallback.gemini = false; noThinkCfg.clear(); noReasonCfg.clear(); }

export function modelFor(provider, kind) {
  const s = settings();
  const chat = provider === "groq" ? s.groqModel : s.geminiModel;
  if (kind === "chat") return chat;
  const t = (provider === "groq" ? s.groqToolModel : s.geminiToolModel) || "auto";
  if (t === "same" || toolFallback[provider]) return chat;
  return t === "auto" ? AUTO_TOOL[provider] : t;
}
export function groqModelFor(kind) { return modelFor("groq", kind); }

/**
 * fetch 加上逾時與自動重試。
 * 會重試：網路層失敗（Failed to fetch）、逾時、500/502/503/504（伺服器忙），以及一次 429。
 * 不會重試：401/403/404 這種重試也沒用的錯誤；使用者自己按停止（外部 signal）。
 * 串流請求只會在「還沒收到任何回應」之前重試，不會重複念出已經念過的句子。
 */
async function fetchRetry(url, init, { who = "Gemini", tries = 3, timeoutMs = 30000 } = {}) {
  const outer = init.signal;
  let last429 = false;
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
        throw new Error(timedOut ? `${who} 太久沒有回應（已重試）。網路慢或伺服器忙，等一下再試。` : networkMessage(who));
      }
      // Groq 被限流時，回應常常沒有跨來源標頭 → 瀏覽器只看到 Failed to fetch。等久一點再試。
      await sleep(who === "Groq" ? 2500 * (i + 1) ** 2 : 700 * (i + 1) ** 2);
    }
  }
  throw new Error(networkMessage(who));
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
 * 串流產生回覆。
 * @param {Array} messages  [{role:'user'|'assistant', content}]
 * @param {Object} opts     {scenario, dueWords, signal}
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
  return s.provider === "groq"
    ? groqStream(sys, messages, opts.signal, onDelta)
    : geminiStream(sys, messages, opts.signal, onDelta);
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

async function groqStream(sys, messages, signal, onDelta) {
  const s = settings();
  if (!s.groqKey) throw new Error("尚未設定 Groq API 金鑰");

  const model = s.groqModel;
  await groqGate(model, estTokens(sys + JSON.stringify(messages)) + 120, "chat");
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
  }, { who: "Groq", timeoutMs: 20000 });
  let resp = await send();
  groqReadHeaders(model, resp);
  if (resp.status === 400 && !noReasonCfg.has(model) && Object.keys(groqReasoning(model)).length
      && /reasoning/i.test(await resp.clone().text().catch(() => ""))) {
    noReasonCfg.add(model);            // 這個模型不吃推理參數 → 拿掉再送一次
    resp = await send();
  }
  if (!resp.ok) throw new Error(await describeError(resp, "Groq"));

  let full = "";
  await readSSE(resp, signal, (obj) => {
    const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (d && d.content) { full += d.content; onDelta(d.content); }
  });
  return full;
}

async function geminiStream(sys, messages, signal, onDelta) {
  const s = settings();
  if (!s.geminiKey) throw new Error("尚未設定 Gemini API 金鑰");

  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(s.geminiModel) + ":streamGenerateContent?alt=sse";

  const send = () => fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: geminiGenConfig(s.geminiModel, 240, { temperature: 0.85 }),
    }),
    signal,
  }, { who: "Gemini", timeoutMs: 20000 });
  let resp = await send();
  if (await thinkingRejected(s.geminiModel, resp)) resp = await send();
  if (!resp.ok) throw new Error(await describeError(resp, "Gemini"));

  let full = "";
  await readSSE(resp, signal, (obj) => {
    for (const cand of (obj.candidates || [])) {
      for (const part of ((cand.content && cand.content.parts) || [])) {
        if (part.text) { full += part.text; onDelta(part.text); }
      }
    }
  });
  return full;
}

/* ---------- 一次性呼叫（單字查詢等，不需要串流） ---------- */

/**
 * @param {Object} o  json：要求回 JSON；maxTokens；
 *                    geminiModel：改用別的 Gemini 模型（例如文法檢查用較輕的 flash-lite，額度另計）
 */
export async function complete(prompt, { json = false, maxTokens = 600, geminiModel = "", geminiJson = false,
                                         priority = "fg", kind = "tool" } = {}) {
  // priority：fg = 你正在等結果（查字）；bg = 背景工作（文法、補詞性），Groq 額度緊時讓路
  // json：要求回一個 JSON 物件（兩家都支援）
  // geminiJson：只對 Gemini 開 JSON 模式（回傳是陣列時用；Groq 的 JSON 模式只接受物件）
  const s = settings();
  if (s.provider === "groq") return groqComplete(prompt, { json, maxTokens, geminiJson, priority, kind });

  if (!s.geminiKey) throw new Error("尚未設定 Gemini API 金鑰");
  let budget = maxTokens;
  for (let attempt = 0; attempt < 4; attempt++) {
    const model = geminiModel || modelFor("gemini", kind);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/"
              + encodeURIComponent(model) + ":generateContent";
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
      // 查字用的模型不能用（被汰換、或新帳號沒有權限）→ 退回對話模型
      if ((resp.status === 404 || resp.status === 403) && !geminiModel && kind === "tool"
          && model !== s.geminiModel && !toolFallback.gemini) { toolFallback.gemini = true; continue; }
      throw new Error(await describeError(resp, "Gemini"));
    }
    const d = await resp.json();
    const cand = (d.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    // 回到一半被 token 上限截斷 → 給兩倍額度再要一次（不然 JSON 不完整就會「查詢失敗」）
    if (cand.finishReason === "MAX_TOKENS" && budget === maxTokens) { budget *= 2; continue; }
    if (!text && cand.finishReason === "SAFETY") throw new Error("Gemini 拒絕回答這個內容（安全過濾）。");
    return text;
  }
  throw new Error("回應太長被截斷了，再試一次。");
}

/**
 * Groq 的一次性呼叫。
 * - 先排隊（groqGate），不要一口氣把每分鐘額度用完
 * - 要 JSON 陣列時，請模型包成 {"items":[...]}，這樣就能開 Groq 的 JSON 模式（它只接受物件），回傳時再拆開
 * - JSON 模式驗證失敗（小模型偶爾會）→ 關掉 JSON 模式再要一次，交給 parseJSON 去挖
 * - 查字用的模型不存在 → 退回對話模型
 */
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

async function groqComplete(prompt, { json, maxTokens, geminiJson, priority, kind = "tool" }) {
  const s = settings();
  if (!s.groqKey) throw new Error("尚未設定 Groq API 金鑰");
  const wrap = geminiJson && !json;                 // 要陣列 → 包成物件
  const text = wrap ? prompt + '\n\nIMPORTANT: wrap the JSON array in an object like {"items": [ ... ]} and return only that object.' : prompt;
  // 免費方案每分鐘 token 很少，單次請求的上限不要開太大
  const maxOut = Math.min(maxTokens, 2400);
  let useJson = json || wrap;
  for (let attempt = 0; attempt < 4; attempt++) {
    const model = modelFor("groq", kind);
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
      const msg = await describeError(resp, "Groq");
      if (resp.status === 400 && /reasoning/i.test(msg) && !noReasonCfg.has(model)) { noReasonCfg.add(model); continue; }
      if ((resp.status === 404 || resp.status === 403) && kind === "tool" && model !== s.groqModel && !toolFallback.groq) {
        toolFallback.groq = true; continue;
      }
      if (resp.status === 400 && useJson && /json/i.test(msg)) { useJson = false; continue; }
      if (resp.status === 413) throw new Error("這次要查的內容太長，超過 Groq 免費方案單次上限。分成少一點再試。");
      throw new Error(msg);
    }
    const d = await resp.json();
    if (d.usage && d.usage.total_tokens) entry.tokens = d.usage.total_tokens;   // 用實際用量更正帳本
    const out = stripThink((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "");
    if (!wrap) return out;
    try {
      const obj = parseJSON(out);
      if (Array.isArray(obj)) return JSON.stringify(obj);
      const arr = obj.items || Object.values(obj).find(Array.isArray);
      return JSON.stringify(arr || []);
    } catch (e) { return out; }
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

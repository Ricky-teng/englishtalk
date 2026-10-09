/**
 * llm.js — 直接從瀏覽器呼叫 Gemini / Groq
 *
 * 架構說明：純靜態部署，沒有後端，金鑰由使用者自備並存在自己的瀏覽器。
 * 好處是你不用付任何費用、也不會被別人刷爆額度；代價是要靠供應商的 CORS 支援。
 *   - Gemini：官方 JS SDK 就是在瀏覽器跑的，CORS 開放，預設用這個。
 *   - Groq：多數情況可直連；萬一被 CORS 擋住，會丟出明確訊息請使用者改用 Gemini。
 */

import { settings } from "./store.js";

/* ---------- 連線：逾時、自動重試、把錯誤翻成人話 ---------- */

const RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 網路層失敗（Failed to fetch / NetworkError / Load failed）時給的說明 */
function networkMessage(who) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "目前沒有網路連線，連上之後再試一次。";
  return who === "Groq"
    ? "連不上 Groq（已自動重試）。可能是網路不穩，或被瀏覽器的跨來源政策擋下 —— 到設定改用 Gemini 會比較穩。"
    : `連不上 ${who}（已自動重試）。通常是網路一時不穩；如果一直發生，檢查廣告封鎖等擴充功能是否擋了 googleapis.com。`;
}

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
      if (resp.status === 429) { last429 = true; await sleep(4000); } else await sleep(800 * (i + 1) ** 2);
    } catch (e) {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
      if (outer && outer.aborted) throw e;                 // 使用者自己中止，直接往外丟
      if (i === tries - 1) {
        throw new Error(timedOut ? `${who} 太久沒有回應（已重試）。網路慢或伺服器忙，等一下再試。` : networkMessage(who));
      }
      await sleep(700 * (i + 1) ** 2);
    }
  }
  throw new Error(networkMessage(who));
}

/**
 * Gemini 2.5 Flash 預設會先「思考」，思考用掉的 token 也算在 maxOutputTokens 裡：
 * 回覆容易被截斷（JSON 不完整 → 查詢失敗）、第一個字也出得慢。
 * 對話與查字都不需要深度推理，所以 2.5 Flash 系列直接關掉思考。
 * 其他模型（Pro 不能關）就多給一些 token 額度，避免被思考吃光。
 */
function geminiGenConfig(model, maxTokens, extra = {}) {
  const flash25 = /2\.5-flash/i.test(model);
  return {
    maxOutputTokens: flash25 ? maxTokens : maxTokens + 2048,
    ...(flash25 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    ...extra,
  };
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

  const resp = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + s.groqKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: s.groqModel,
      stream: true,
      temperature: 0.85,
      max_tokens: 220,
      messages: [{ role: "system", content: sys }, ...messages],
    }),
    signal,
  }, { who: "Groq", timeoutMs: 20000 });
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

  const resp = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: geminiGenConfig(s.geminiModel, 240, { temperature: 0.85 }),
    }),
    signal,
  }, { who: "Gemini", timeoutMs: 20000 });
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
export async function complete(prompt, { json = false, maxTokens = 600, geminiModel = "", geminiJson = false } = {}) {
  // json：要求回一個 JSON 物件（兩家都支援）
  // geminiJson：只對 Gemini 開 JSON 模式（回傳是陣列時用；Groq 的 JSON 模式只接受物件）
  const s = settings();
  if (s.provider === "groq") {
    if (!s.groqKey) throw new Error("尚未設定 Groq API 金鑰");
    const resp = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + s.groqKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: s.groqModel,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    }, { who: "Groq" });
    if (!resp.ok) throw new Error(await describeError(resp, "Groq"));
    const d = await resp.json();
    return d.choices[0].message.content;
  }

  if (!s.geminiKey) throw new Error("尚未設定 Gemini API 金鑰");
  const model = geminiModel || s.geminiModel;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(model) + ":generateContent";
  let budget = maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
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
    if (!resp.ok) throw new Error(await describeError(resp, "Gemini"));
    const d = await resp.json();
    const cand = (d.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map(p => p.text || "").join("");
    // 回到一半被 token 上限截斷 → 給兩倍額度再要一次（不然 JSON 不完整就會「查詢失敗」）
    if (cand.finishReason === "MAX_TOKENS" && attempt === 0) { budget *= 2; continue; }
    if (!text && cand.finishReason === "SAFETY") throw new Error("Gemini 拒絕回答這個內容（安全過濾）。");
    return text;
  }
  throw new Error("回應太長被截斷了，再試一次。");
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

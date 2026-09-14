/**
 * llm.js — 直接從瀏覽器呼叫 Gemini / Groq
 *
 * 架構說明：純靜態部署，沒有後端，金鑰由使用者自備並存在自己的瀏覽器。
 * 好處是你不用付任何費用、也不會被別人刷爆額度；代價是要靠供應商的 CORS 支援。
 *   - Gemini：官方 JS SDK 就是在瀏覽器跑的，CORS 開放，預設用這個。
 *   - Groq：多數情況可直連；萬一被 CORS 擋住，會丟出明確訊息請使用者改用 Gemini。
 */

import { settings } from "./store.js";

/* ---------- 系統提示 ---------- */

function systemPrompt({ level, persona, scenario, dueWords }) {
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
    // 不指定要用哪個字，而是給一池候選讓模型挑話題搭得上的，
    // 並要求它問一個「會讓學習者自己說出那個字」的問題 —— 產出才是學習事件。
    p += `\n\nVOCABULARY GOAL (never mention this to the learner):
The learner is studying these words: ${dueWords.join(", ")}.
Silently pick ONE, at most TWO, that genuinely fit what you are already talking about. Nudge the \
conversation toward a situation where that word belongs, use it yourself in your reply, and end \
with a question that makes it natural for the learner to use THAT SAME WORD in their answer.
Never list these words, never say you are practising vocabulary, never tell them to use a word, \
and never bend the conversation somewhere weird just to fit one in. If none of them fit right \
now, ignore this section completely and just keep the conversation natural.`;
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

  let resp;
  try {
    resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("無法連上 Groq（可能被瀏覽器的跨來源政策擋下）。請到設定改用 Gemini。");
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

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 240 },
    }),
    signal,
  });
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

export async function complete(prompt, { json = false, maxTokens = 600 } = {}) {
  const s = settings();
  if (s.provider === "groq") {
    if (!s.groqKey) throw new Error("尚未設定 Groq API 金鑰");
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + s.groqKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: s.groqModel,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!resp.ok) throw new Error(await describeError(resp, "Groq"));
    const d = await resp.json();
    return d.choices[0].message.content;
  }

  if (!s.geminiKey) throw new Error("尚未設定 Gemini API 金鑰");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/"
            + encodeURIComponent(s.geminiModel) + ":generateContent";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: maxTokens,
        ...(json ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });
  if (!resp.ok) throw new Error(await describeError(resp, "Gemini"));
  const d = await resp.json();
  const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || "").join("");
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
    return `${who} 免費額度暫時用完了（429）。等幾分鐘，或到設定切換另一個供應商。`;
  }
  return `${who} 回應 ${code}：${detail}`;
}

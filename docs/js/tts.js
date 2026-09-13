/**
 * tts.js — 語音合成，兩層策略
 *
 *  1. browser：瀏覽器內建 speechSynthesis。完全免費、無限、零延遲、離線可用。
 *     在 Edge 上可以拿到 "Microsoft ... Online (Natural)" 這類神經語音，音質很好。
 *  2. edge：直接用瀏覽器的 WebSocket 連微軟 Edge 朗讀服務（就是 edge-tts 用的協定）。
 *     音質最好且免費無限，但微軟會擋部分來源 IP；失敗時自動退回第 1 種。
 *
 * 對外只暴露一個 speak()，內部自己處理降級，呼叫端不必管用的是哪一種。
 */

import { settings } from "./store.js";

/* =========================================================================
   微軟 Edge 朗讀服務（移植自 edge-tts 的協定）
   ========================================================================= */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = "1-" + CHROMIUM_FULL_VERSION;
const WSS_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const WIN_EPOCH = 11644473600;

/** 微軟要求的防盜用 token：把「取整到 5 分鐘的 Windows 檔案時間」接上固定字串做 SHA-256 */
async function secMsGec() {
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;                 // 取整到最近的 5 分鐘
  ticks *= 1e9 / 100;                   // 換成 100 奈秒單位（Windows file time）
  const str = ticks.toFixed(0) + TRUSTED_CLIENT_TOKEN;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function connectId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, "");
}

function jsDateString() {
  // 微軟要的是 JavaScript 風格的日期字串，這裡剛好是原生格式
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

function escapeXML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 把 1.0 這種倍率換成 edge 要的 "+0%" / "-15%" 格式 */
function ratePercent(rate) {
  const pct = Math.round((Number(rate || 1) - 1) * 100);
  return (pct >= 0 ? "+" : "") + pct + "%";
}

let edgeDisabled = false;   // 連續失敗後就不再嘗試，省掉每句都等 timeout

/**
 * 用 WebSocket 取得一整句的 mp3。
 * @returns {Promise<Blob>}
 */
function edgeSynth(text, voice, rate, timeoutMs = 8000) {
  return new Promise(async (resolve, reject) => {
    let ws, timer;
    const chunks = [];
    const fail = (msg) => {
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch (e) {}
      reject(new Error(msg));
    };

    try {
      const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
                + `&ConnectionId=${connectId()}`
                + `&Sec-MS-GEC=${await secMsGec()}`
                + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
      ws = new WebSocket(url);
    } catch (e) {
      return fail("無法建立 WebSocket：" + e.message);
    }
    ws.binaryType = "arraybuffer";
    timer = setTimeout(() => fail("edge-tts 逾時"), timeoutMs);

    ws.onopen = () => {
      ws.send(
        `X-Timestamp:${jsDateString()}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
        '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      );
      const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        `<voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${ratePercent(rate)}' volume='+0%'>` +
        escapeXML(text) +
        "</prosody></voice></speak>";
      ws.send(
        `X-RequestId:${connectId()}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${jsDateString()}Z\r\n` +   // 尾巴的 Z 是微軟自己的 bug，要照抄
        "Path:ssml\r\n\r\n" + ssml
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          if (!chunks.length) return reject(new Error("沒有收到音訊"));
          resolve(new Blob(chunks, { type: "audio/mpeg" }));
        }
        return;
      }
      // 二進位訊框：前 2 bytes 是標頭長度（big-endian），標頭之後才是音訊
      const bytes = new Uint8Array(ev.data);
      if (bytes.length < 2) return;
      const headerLen = (bytes[0] << 8) | bytes[1];
      const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
      if (!/Path:audio/i.test(header)) return;
      const audio = bytes.subarray(2 + headerLen);
      if (audio.length) chunks.push(audio);
    };

    ws.onerror = () => fail("edge-tts 連線失敗（服務可能擋下了這個來源）");
    ws.onclose = (ev) => {
      if (chunks.length === 0) fail("edge-tts 連線被關閉（code " + ev.code + "）");
    };
  });
}

export const EDGE_VOICES = [
  { id: "en-US-AvaNeural",     label: "Ava — 美式女聲（自然親切）" },
  { id: "en-US-AndrewNeural",  label: "Andrew — 美式男聲（沉穩）" },
  { id: "en-US-EmmaNeural",    label: "Emma — 美式女聲（明亮）" },
  { id: "en-US-BrianNeural",   label: "Brian — 美式男聲（輕鬆）" },
  { id: "en-GB-SoniaNeural",   label: "Sonia — 英式女聲" },
  { id: "en-GB-RyanNeural",    label: "Ryan — 英式男聲" },
  { id: "en-AU-NatashaNeural", label: "Natasha — 澳洲女聲" },
];

/* =========================================================================
   瀏覽器內建語音
   ========================================================================= */

let voicesCache = [];

export function loadVoices() {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve([]);
    const grab = () => {
      const all = window.speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang));
      if (all.length) {
        // 神經語音（Natural / Online / Google）排前面，音質差很多
        all.sort((a, b) => score(b) - score(a));
        voicesCache = all;
        resolve(all);
        return true;
      }
      return false;
    };
    const score = (v) => {
      let s = 0;
      if (/natural/i.test(v.name)) s += 4;
      if (/online/i.test(v.name)) s += 3;
      if (/google/i.test(v.name)) s += 2;
      if (/en-US/i.test(v.lang)) s += 1;
      if (v.localService && !/natural|online/i.test(v.name)) s -= 2;
      return s;
    };
    if (grab()) return;
    // Chrome 第一次要等 voiceschanged
    let tries = 0;
    const t = setInterval(() => {
      if (grab() || ++tries > 20) { clearInterval(t); resolve(voicesCache); }
    }, 150);
    window.speechSynthesis.addEventListener("voiceschanged", grab, { once: true });
  });
}

export function browserVoices() { return voicesCache; }

function speakBrowser(text, onStart) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const s = settings();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = Number(s.rate) || 1;
    const want = voicesCache.find(v => v.name === s.browserVoice);
    if (want) u.voice = want;
    else if (voicesCache.length) u.voice = voicesCache[0];
    let started = false;
    u.onstart = () => { started = true; if (onStart) onStart(); };
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.speak(u);
    // 有些瀏覽器不會觸發 onstart，保險起見延遲補一次
    setTimeout(() => { if (!started && onStart) onStart(); }, 120);
  });
}

/* =========================================================================
   對外介面
   ========================================================================= */

let current = { audio: null, cancelled: false };

/** 預先合成（讓下一句可以邊播邊抓），回傳 Blob 或 null（代表要用瀏覽器語音） */
export async function prefetch(text) {
  const s = settings();
  if (s.ttsEngine !== "edge" || edgeDisabled) return null;
  try {
    return await edgeSynth(text, s.edgeVoice, s.rate);
  } catch (e) {
    console.warn("[tts] edge 失敗，改用瀏覽器語音：", e.message);
    edgeDisabled = true;
    window.dispatchEvent(new CustomEvent("tts:fallback", { detail: e.message }));
    return null;
  }
}

/**
 * 唸一句。blob 可傳入 prefetch() 的結果；沒有就即時決定。
 * @param {Function} onStart 真正開始發聲時呼叫（用來切換 UI 狀態）
 */
export async function speak(text, blob, onStart) {
  current.cancelled = false;
  if (blob === undefined) blob = await prefetch(text);
  if (current.cancelled) return;

  if (!blob) return speakBrowser(text, onStart);

  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    current.audio = a;
    const done = () => {
      URL.revokeObjectURL(url);
      if (current.audio === a) current.audio = null;
      resolve();
    };
    a.onplay = () => { if (onStart) onStart(); };
    a.onended = done;
    a.onerror = done;
    a.onpause = () => { if (!a.ended) done(); };   // 被搶話時
    a.play().catch(done);
  });
}

/** 立刻停止發聲（搶話用） */
export function stop() {
  current.cancelled = true;
  if (current.audio) { try { current.audio.pause(); } catch (e) {} current.audio = null; }
  try { window.speechSynthesis.cancel(); } catch (e) {}
}

export function edgeIsDisabled() { return edgeDisabled; }
export function resetEdge() { edgeDisabled = false; }

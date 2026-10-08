/**
 * listen.js — 一次性的語音輸入：聽你講一句話，講完自動結束並回傳文字
 *
 * 對話頁用的是 asr.js 的 Listener（持續聆聽 + 搶話）；跟讀和用說的複習
 * 只需要「聽一句」，所以另外做一個輕量版，兩邊互不干擾。
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function canListen() { return !!SR; }

/**
 * 開始聽一句。
 * @param {Object} opt
 *   onInterim(text)  辨識中的暫時結果（畫面即時顯示用）
 *   silenceMs        停頓多久算講完（預設 1.4 秒）
 *   maxMs            最長聽多久（預設 15 秒，避免忘了關）
 * @returns {{promise: Promise<string>, stop: Function}}
 */
export function listenOnce(opt = {}) {
  const silenceMs = opt.silenceMs || 1400;
  const maxMs = opt.maxMs || 15000;
  let rec = null, finalText = "", interimText = "", done = false;
  let silenceTimer = null, maxTimer = null;
  let resolveFn, rejectFn;

  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
    try { rec && rec.stop(); } catch (e) {}
    resolveFn((finalText + " " + interimText).replace(/\s+/g, " ").trim());
  };

  if (!SR) {
    rejectFn(new Error("這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge，或直接打字。"));
    return { promise, stop: () => {} };
  }

  rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (ev) => {
    interimText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interimText += r[0].transcript;
    }
    if (opt.onInterim) opt.onInterim((finalText + interimText).trim());
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(finish, silenceMs);
  };
  rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      done = true;
      clearTimeout(silenceTimer);
      clearTimeout(maxTimer);
      rejectFn(new Error("麥克風權限被拒絕，請在網址列左側允許麥克風。"));
    }
    // no-speech 之類的交給 onend 收尾
  };
  rec.onend = finish;

  try { rec.start(); } catch (e) { rejectFn(e); }
  maxTimer = setTimeout(finish, maxMs);

  return { promise, stop: finish };
}

/**
 * asr.js — 語音辨識 + 雙工（搶話）判斷
 *
 * 雙工的難處不是「同時收音」，而是「分辨麥克風收到的是人還是喇叭」。
 * 這裡用兩道獨立的判斷，任一成立就算使用者要插話：
 *   1. 音量 VAD：另開一條啟用回音消除的麥克風串流，持續超過門檻 220ms。
 *   2. 文字比對：辨識結果跟 AI 正在唸的句子重疊超過 60% 就當成回音丟掉，否則視為真人。
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isSupported() { return !!SR; }

export class Listener {
  /**
   * @param {Object} cb
   *   onInterim(text)   辨識中的暫時結果
   *   onCommit(text)    使用者停頓夠久，這一回合說完了
   *   onBargeIn()       使用者在 AI 說話時插話
   *   onLevel(rms)      音量（畫音量條用）
   *   onError(msg)
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.recog = null;
    this.running = false;
    this.alive = false;

    this.finalBuf = "";
    this.interimBuf = "";
    this.silenceTimer = null;
    this.silenceMs = 1000;

    this.speaking = false;      // AI 是否正在說話
    this.spokenText = "";       // AI 正在唸的句子（回音比對用）
    this.bargeSensitivity = 3.0;

    this.noiseFloor = 0.005;
    this.aboveSince = 0;
    this.vadStream = null;
    this.audioCtx = null;
    this.rafId = 0;
  }

  /* ---------- 麥克風音量偵測 ---------- */

  async initVAD() {
    if (this.audioCtx) return true;
    try {
      this.vadStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      const src = this.audioCtx.createMediaStreamSource(this.vadStream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);

      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);

        // 只在 AI 沒說話時更新噪音底，免得把 AI 的聲音當成環境音
        if (!this.speaking) {
          this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
          if (this.noiseFloor < 0.002) this.noiseFloor = 0.002;
        }
        if (this.cb.onLevel) this.cb.onLevel(rms);

        if (this.running && this.speaking && this.bargeSensitivity > 0) {
          const th = Math.max(this.noiseFloor * this.bargeSensitivity, 0.018);
          if (rms > th) {
            if (!this.aboveSince) this.aboveSince = performance.now();
            else if (performance.now() - this.aboveSince > 220) {
              this.aboveSince = 0;
              this._bargeIn();
            }
          } else this.aboveSince = 0;
        } else this.aboveSince = 0;

        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
      return true;
    } catch (e) {
      if (this.cb.onError) this.cb.onError("無法取得麥克風：" + e.message);
      return false;
    }
  }

  /* ---------- 辨識 ---------- */

  _build() {
    if (!SR) {
      if (this.cb.onError) {
        this.cb.onError("這個瀏覽器不支援語音辨識，請改用 Chrome 或 Edge。你仍可以打字練習。");
      }
      return null;
    }
    const r = new SR();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => { this.alive = true; };

    r.onresult = (ev) => {
      let finalAdd = "", interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalAdd += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      const candidate = (finalAdd + interim).trim();
      if (!candidate) return;

      if (this.speaking) {
        if (this._isEcho(candidate)) return;             // 喇叭回音，忽略
        if (wordCount(candidate) >= 2) this._bargeIn();  // 真的有人在講
        else return;
      }

      if (finalAdd) this.finalBuf += finalAdd;
      this.interimBuf = interim;
      if (this.cb.onInterim) this.cb.onInterim((this.finalBuf + this.interimBuf).trim());
      this._scheduleCommit();
    };

    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        if (this.cb.onError) this.cb.onError("麥克風權限被拒絕，請允許後重新整理頁面。");
        this.stop();
      }
      // no-speech / aborted / network 交給 onend 自動重啟
    };

    r.onend = () => {
      this.alive = false;
      if (this.running) {
        // Chrome 靜默一段時間會自己停，這裡無縫重啟，維持「一直在聽」
        setTimeout(() => { if (this.running && !this.alive) this._safeStart(); }, 120);
      }
    };
    return r;
  }

  _safeStart() {
    try { this.recog.start(); } catch (e) { /* 已在跑，忽略 */ }
  }

  _isEcho(text) {
    if (!this.spokenText) return false;
    const a = normWords(text);
    if (!a.length) return false;
    const b = new Set(normWords(this.spokenText));
    let hit = 0;
    for (const w of a) if (b.has(w)) hit++;
    return hit / a.length >= 0.6;
  }

  _bargeIn() {
    if (!this.speaking) return;
    this.speaking = false;
    this.spokenText = "";
    if (this.cb.onBargeIn) this.cb.onBargeIn();
  }

  _scheduleCommit() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this._commit(), this.silenceMs);
  }

  _commit() {
    this.silenceTimer = null;
    const text = (this.finalBuf + " " + this.interimBuf).trim();
    this.finalBuf = "";
    this.interimBuf = "";
    if (!text) return;
    if (this.cb.onCommit) this.cb.onCommit(text);
  }

  /* ---------- 對外 ---------- */

  async start() {
    if (this.running) return;
    await this.initVAD();
    this.recog = this._build();
    this.running = true;
    this.finalBuf = "";
    this.interimBuf = "";
    if (this.recog) this._safeStart();
  }

  stop() {
    this.running = false;
    this.speaking = false;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.recog) { try { this.recog.stop(); } catch (e) {} }
  }

  /** 釋放麥克風（離開頁面或完全結束時呼叫） */
  release() {
    this.stop();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.vadStream) this.vadStream.getTracks().forEach(t => t.stop());
    if (this.audioCtx) { try { this.audioCtx.close(); } catch (e) {} }
    this.vadStream = null;
    this.audioCtx = null;
  }

  /** 告訴聽者「AI 現在在唸這句」，用於回音過濾與搶話 */
  setSpeaking(on, text = "") {
    this.speaking = on;
    this.spokenText = on ? text : "";
    if (!on) this.aboveSince = 0;
  }

  configure({ silenceMs, bargeSensitivity }) {
    if (silenceMs != null) this.silenceMs = silenceMs;
    if (bargeSensitivity != null) this.bargeSensitivity = bargeSensitivity;
  }
}

export function wordCount(t) {
  return String(t || "").trim().split(/\s+/).filter(Boolean).length;
}

export function normWords(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/).filter(Boolean);
}

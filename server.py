# -*- coding: utf-8 -*-
"""
雙工英文對話練習 AI — 本地後端伺服器

設計目標：接近無限免費
  - 語音辨識(STT)：瀏覽器內建 Web Speech API，完全免費、無次數限制
  - 語音合成(TTS)：edge-tts（微軟 Edge 朗讀用的神經語音），免費、無金鑰、無次數限制
  - 對話模型(LLM)：Groq 或 Google Gemini 的免費額度，兩者可即時切換

為什麼要跑這支伺服器（而不是直接雙擊 index.html）：
  1. Chrome 只有在「安全來源」才會「記住」麥克風權限；http://localhost 算安全來源，
     file:// 則常常每次都重問、甚至直接失敗。
  2. API 金鑰留在本機 config.json，不會寫死在網頁裡。
  3. edge-tts 是 Python 套件，需要一個本機端點來呼叫。

啟動：python server.py      （或直接雙擊 start.bat）
"""

import json
import os
import sys
import time
import queue
import threading
import traceback
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# ---------------------------------------------------------------------------
# 基本設定
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
HOST = "127.0.0.1"
PORT = 8765

# 預設設定；config.json 內的值會覆蓋這裡
DEFAULT_CONFIG = {
    "provider": "groq",                        # groq | gemini
    "groq_api_key": "",
    "groq_model": "llama-3.1-8b-instant",      # Groq 免費層一定有、且極快的模型
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",        # Gemini 免費額度大的模型
    "voice": "en-US-AvaNeural",                # edge-tts 語音代號
    "rate": "+0%",                             # 語速，例如 "-10%" / "+15%"
    "level": "B1",                             # 使用者英文程度，影響 AI 用字難度
    "persona": "Ava, a warm and curious American friend in her late twenties",
}

# edge-tts 可選語音（前端下拉選單用）。全部免費。
VOICE_OPTIONS = [
    {"id": "en-US-AvaNeural",      "label": "Ava — 美式女聲（自然、親切）"},
    {"id": "en-US-AndrewNeural",   "label": "Andrew — 美式男聲（沉穩）"},
    {"id": "en-US-EmmaNeural",     "label": "Emma — 美式女聲（明亮）"},
    {"id": "en-US-BrianNeural",    "label": "Brian — 美式男聲（輕鬆）"},
    {"id": "en-GB-SoniaNeural",    "label": "Sonia — 英式女聲"},
    {"id": "en-GB-RyanNeural",     "label": "Ryan — 英式男聲"},
    {"id": "en-AU-NatashaNeural",  "label": "Natasha — 澳洲女聲"},
]

# 對話系統提示：自由聊天，口語、簡短、會主動接話
SYSTEM_PROMPT_TEMPLATE = """You are {persona}. You are having a REAL-TIME SPOKEN conversation \
with a language learner whose English level is roughly {level} (CEFR). Your entire output is \
read aloud by a text-to-speech engine, so it must sound like natural speech.

Hard rules:
- Reply in ENGLISH ONLY. Never use Chinese characters, emoji, markdown, bullet points, \
asterisks, parentheses, or stage directions. Plain spoken sentences only.
- Keep every reply SHORT: 1 to 3 sentences, under about 45 words. This is a conversation, \
not a monologue.
- Sound like a person, not an assistant. Use contractions, natural fillers occasionally \
(well, yeah, honestly, I mean), and react to what they said before adding your own bit.
- Almost always end with a light, specific follow-up question so the learner keeps talking. \
Do not ask two questions at once.
- Match your vocabulary and sentence length to a {level} learner. Stay natural, just simpler.
- If their English is broken or the transcript looks garbled, guess the intended meaning and \
keep the conversation flowing. Never comment on their grammar, never correct them, never \
mention that you are an AI or that speech recognition is involved.
- Numbers, dates and abbreviations should be written the way they are spoken \
(say "twenty twenty six", not "2026").
"""


# ---------------------------------------------------------------------------
# 設定檔讀寫（原子寫入：暫存檔 + os.replace）
# ---------------------------------------------------------------------------

def load_config():
    """讀取 config.json，缺少的欄位用預設值補齊。"""
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                for k, v in data.items():
                    if k in cfg and isinstance(v, str):
                        cfg[k] = v
        except Exception:
            print("[warn] config.json 解析失敗，改用預設值")
            traceback.print_exc()
    return cfg


def save_config(cfg):
    """原子寫入設定檔，避免寫到一半斷電造成檔案毀損。"""
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, CONFIG_PATH)   # 原子替換


CONFIG_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# LLM：串流呼叫 Groq / Gemini
# ---------------------------------------------------------------------------

# Groq API 前面掛了 Cloudflare，預設的 Python-urllib User-Agent 會被
# 「瀏覽器簽章封鎖」規則擋下（403 error code: 1010），所以一定要偽裝成一般客戶端。
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def _http_stream(url, payload, headers, timeout=60):
    """發出 POST 並以串流方式逐行回傳位元組（用於 SSE）。"""
    body = json.dumps(payload).encode("utf-8")
    h = {
        "User-Agent": BROWSER_UA,
        "Accept": "text/event-stream",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",   # 不要 gzip，串流才能逐行讀
        "Connection": "keep-alive",
    }
    h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def stream_groq(cfg, messages, out):
    """呼叫 Groq 的 OpenAI 相容端點，把文字增量丟進 out 佇列。"""
    key = cfg.get("groq_api_key", "").strip()
    if not key:
        out.put(("error", "尚未設定 Groq API 金鑰"))
        return

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        persona=cfg.get("persona") or DEFAULT_CONFIG["persona"],
        level=cfg.get("level") or "B1",
    )
    payload = {
        "model": cfg.get("groq_model") or DEFAULT_CONFIG["groq_model"],
        "stream": True,
        "temperature": 0.85,
        "max_tokens": 200,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
    }
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }

    resp = _http_stream("https://api.groq.com/openai/v1/chat/completions", payload, headers)
    for raw in resp:
        line = raw.decode("utf-8", "ignore").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
            delta = obj["choices"][0]["delta"].get("content")
            if delta:
                out.put(("delta", delta))
        except Exception:
            continue


def stream_gemini(cfg, messages, out):
    """呼叫 Gemini streamGenerateContent（SSE 模式），把文字增量丟進 out 佇列。"""
    key = cfg.get("gemini_api_key", "").strip()
    if not key:
        out.put(("error", "尚未設定 Gemini API 金鑰"))
        return

    model = cfg.get("gemini_model") or DEFAULT_CONFIG["gemini_model"]
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        persona=cfg.get("persona") or DEFAULT_CONFIG["persona"],
        level=cfg.get("level") or "B1",
    )

    # Gemini 的角色名稱是 user / model
    contents = []
    for m in messages:
        role = "model" if m.get("role") == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.85, "maxOutputTokens": 220},
    }
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           + model + ":streamGenerateContent?alt=sse&key=" + key)
    headers = {"Content-Type": "application/json"}

    resp = _http_stream(url, payload, headers)
    for raw in resp:
        line = raw.decode("utf-8", "ignore").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data:
            continue
        try:
            obj = json.loads(data)
            for cand in obj.get("candidates", []):
                for part in cand.get("content", {}).get("parts", []):
                    text = part.get("text")
                    if text:
                        out.put(("delta", text))
        except Exception:
            continue


def _http_get_json(url, headers=None, timeout=20):
    """一般 GET 並解析 JSON，同樣要偽裝 User-Agent 避開 Cloudflare。"""
    h = {"User-Agent": BROWSER_UA, "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def list_models(cfg, provider):
    """用使用者自己的金鑰，向供應商查詢「這把金鑰實際可用」的模型清單。
    模型會汰換，寫死名稱遲早會 404，所以改成即時查詢。"""
    if provider == "gemini":
        key = cfg.get("gemini_api_key", "").strip()
        if not key:
            raise RuntimeError("尚未設定 Gemini API 金鑰")
        data = _http_get_json(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + key)
        out = []
        for m in data.get("models", []):
            name = (m.get("name") or "").replace("models/", "")
            methods = m.get("supportedGenerationMethods") or []
            # 只留能做文字生成、且不是嵌入或圖片專用的模型
            if "generateContent" in methods and "embed" not in name and "image" not in name:
                out.append(name)
        return sorted(set(out))

    key = cfg.get("groq_api_key", "").strip()
    if not key:
        raise RuntimeError("尚未設定 Groq API 金鑰")
    data = _http_get_json("https://api.groq.com/openai/v1/models",
                          {"Authorization": "Bearer " + key})
    out = []
    for m in data.get("data", []):
        mid = m.get("id") or ""
        if not mid:
            continue
        # 排除語音、轉錄、防護類模型，只留對話用的
        if any(k in mid.lower() for k in ("whisper", "tts", "guard", "embed", "prompt-guard")):
            continue
        out.append(mid)
    return sorted(set(out))


def run_llm(cfg, provider, messages, out):
    """在背景執行緒跑 LLM 串流，結束時送出 done 或 error。"""
    try:
        if provider == "gemini":
            stream_gemini(cfg, messages, out)
        else:
            stream_groq(cfg, messages, out)
        out.put(("done", ""))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "ignore")[:400]
        except Exception:
            pass
        out.put(("error", "API 回應 %s：%s" % (e.code, detail)))
        out.put(("done", ""))
    except Exception as e:
        out.put(("error", "%s: %s" % (type(e).__name__, e)))
        out.put(("done", ""))


# ---------------------------------------------------------------------------
# TTS：edge-tts（免費、免金鑰、無次數限制）
# ---------------------------------------------------------------------------

_EDGE_TTS_OK = None   # None = 尚未檢查, True/False = 檢查結果


def edge_tts_available():
    """檢查 edge-tts 套件是否可用（只檢查一次）。"""
    global _EDGE_TTS_OK
    if _EDGE_TTS_OK is None:
        try:
            import edge_tts  # noqa: F401
            _EDGE_TTS_OK = True
        except Exception:
            _EDGE_TTS_OK = False
    return _EDGE_TTS_OK


def synth_speech(text, voice, rate):
    """用 edge-tts 合成 mp3 位元組。每次呼叫都建立獨立的事件迴圈，執行緒安全。"""
    import asyncio
    import edge_tts

    async def _run():
        chunks = []
        comm = edge_tts.Communicate(text=text, voice=voice, rate=rate)
        async for chunk in comm.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                chunks.append(chunk["data"])
        return b"".join(chunks)

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()


# ---------------------------------------------------------------------------
# HTTP 處理
# ---------------------------------------------------------------------------

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "EnglishTalk/1.0"
    protocol_version = "HTTP/1.1"

    # 讓主控台安靜一點，只印出錯誤
    def log_message(self, fmt, *args):
        pass

    # ---- 共用回應工具 -----------------------------------------------------

    def _send(self, code, content_type, body, extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _send_json(self, code, obj):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False))

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ---- GET --------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/config":
            cfg = load_config()
            self._send_json(200, {
                "provider": cfg["provider"],
                "voice": cfg["voice"],
                "rate": cfg["rate"],
                "level": cfg["level"],
                "persona": cfg["persona"],
                "groq_model": cfg["groq_model"],
                "gemini_model": cfg["gemini_model"],
                # 只回傳「有沒有設定」，不把金鑰送回前端
                "has_groq_key": bool(cfg["groq_api_key"].strip()),
                "has_gemini_key": bool(cfg["gemini_api_key"].strip()),
                "voices": VOICE_OPTIONS,
                "edge_tts": edge_tts_available(),
            })
            return

        if path == "/api/models":
            provider = "groq"
            if "?" in self.path:
                from urllib.parse import parse_qs
                q = parse_qs(self.path.split("?", 1)[1])
                provider = (q.get("provider") or ["groq"])[0]
            try:
                self._send_json(200, {"models": list_models(load_config(), provider)})
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = e.read().decode("utf-8", "ignore")[:300]
                except Exception:
                    pass
                self._send_json(200, {"error": "API %s：%s" % (e.code, detail)})
            except Exception as e:
                self._send_json(200, {"error": str(e)})
            return

        # 靜態檔案
        if path == "/":
            path = "/index.html"
        safe = os.path.normpath(path.lstrip("/")).replace("\\", "/")
        if safe.startswith("..") or safe.startswith("/"):
            self._send(403, "text/plain; charset=utf-8", "forbidden")
            return
        full = os.path.join(BASE_DIR, safe)
        if os.path.isfile(full):
            ext = os.path.splitext(full)[1].lower()
            ctype = STATIC_TYPES.get(ext, "application/octet-stream")
            with open(full, "rb") as f:
                self._send(200, ctype, f.read())
        else:
            self._send(404, "text/plain; charset=utf-8", "not found")

    # ---- POST -------------------------------------------------------------

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/settings":
                self.handle_settings()
            elif path == "/api/chat":
                self.handle_chat()
            elif path == "/api/tts":
                self.handle_tts()
            else:
                self._send(404, "text/plain; charset=utf-8", "not found")
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass   # 使用者搶話時前端會中斷連線，屬正常情況
        except Exception as e:
            traceback.print_exc()
            try:
                self._send_json(500, {"error": "%s: %s" % (type(e).__name__, e)})
            except Exception:
                pass

    def handle_settings(self):
        """儲存設定。空字串的金鑰欄位代表「不更動」，避免前端覆蓋掉已存在的金鑰。"""
        data = self._read_json()
        with CONFIG_LOCK:
            cfg = load_config()
            for k in DEFAULT_CONFIG:
                if k not in data:
                    continue
                v = data[k]
                if not isinstance(v, str):
                    continue
                if k.endswith("_api_key") and v.strip() == "":
                    continue   # 保留原金鑰
                cfg[k] = v.strip() if k.endswith("_api_key") else v
            save_config(cfg)
        self._send_json(200, {"ok": True})

    def handle_chat(self):
        """以 SSE 串流回傳 LLM 文字增量，讓前端可以邊收邊唸。"""
        data = self._read_json()
        messages = data.get("messages") or []
        cfg = load_config()
        provider = data.get("provider") or cfg["provider"]

        # 只保留必要欄位，並限制歷史長度（省 token、也避免超出免費額度）
        clean = []
        for m in messages[-24:]:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                clean.append({"role": role, "content": content[:2000]})
        if not clean:
            self._send_json(400, {"error": "沒有對話內容"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        out = queue.Queue()
        worker = threading.Thread(target=run_llm, args=(cfg, provider, clean, out), daemon=True)
        worker.start()

        while True:
            kind, value = out.get()
            if kind == "delta":
                payload = json.dumps({"delta": value}, ensure_ascii=False)
            elif kind == "error":
                payload = json.dumps({"error": value}, ensure_ascii=False)
            else:
                payload = json.dumps({"done": True})
            self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
            self.wfile.flush()
            if kind == "done":
                break
        self.close_connection = True

    def handle_tts(self):
        """把一句英文合成 mp3 回傳。"""
        data = self._read_json()
        text = (data.get("text") or "").strip()
        if not text:
            self._send_json(400, {"error": "沒有文字"})
            return
        cfg = load_config()
        voice = data.get("voice") or cfg["voice"]
        rate = data.get("rate") or cfg["rate"]

        if not edge_tts_available():
            # 前端收到這個狀態會自動改用瀏覽器內建語音，不會中斷對話
            self._send_json(503, {"error": "edge-tts 未安裝", "fallback": "browser"})
            return

        try:
            audio = synth_speech(text, voice, rate)
        except Exception as e:
            print("[tts] 失敗：%s: %s" % (type(e).__name__, e))
            self._send_json(502, {"error": str(e), "fallback": "browser"})
            return

        if not audio:
            self._send_json(502, {"error": "合成結果為空", "fallback": "browser"})
            return
        self._send(200, "audio/mpeg", audio)


# ---------------------------------------------------------------------------
# 進入點
# ---------------------------------------------------------------------------

def main():
    # 讓 Windows 主控台能正常印出中文
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.exists(CONFIG_PATH):
        save_config(dict(DEFAULT_CONFIG))
        print("[init] 已建立 config.json")

    if not edge_tts_available():
        print("[warn] 找不到 edge-tts 套件，語音會自動改用瀏覽器內建音色。")
        print("[warn] 想要更自然的聲音，請執行： pip install edge-tts")

    url = "http://localhost:%d/" % PORT
    print("=" * 56)
    print(" 雙工英文對話練習 AI 已啟動")
    print(" 請用 Chrome 或 Edge 開啟： " + url)
    print(" 關閉請按 Ctrl+C")
    print("=" * 56)

    # 延遲一下再自動開瀏覽器，確保伺服器已經在聽
    def _open():
        time.sleep(1.0)
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=_open, daemon=True).start()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已關閉。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

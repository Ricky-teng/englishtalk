"""
每日新聞：從維基百科挑一則時事，原文照登，再請 AI 標生字、出閱讀測驗。

為什麼文章不給 AI 寫：AI 改寫可能把人名、數字、因果寫錯，而共用文章一定要正確。
所以文章是維基百科條目開頭幾段的原文（指定版本，固定連結），AI 只做兩件事：
  1. 依 A2／B1／B2／C1 各挑約 5 個生字，附詞性與中文（每個字都會檢查真的出現在文章裡）
  2. 出 3 題選擇題，每題附「答案依據的原句」；程式核對原句真的在文章裡，
     再請 AI 在「不知道答案」的情況下重新作答一次，答案對不上的題目就重出

用法：
    GEMINI_API_KEY=... python tools/news/build_news.py            # 產生今天的
    python tools/news/build_news.py --dry-run                     # 只抓文章、不呼叫 AI（測試用）
環境變數：
    GEMINI_API_KEY   必填（GitHub Actions 從 Secrets 帶進來）
    GEMINI_MODEL     選填，預設 gemini-3.5-flash
    NEWS_DATE        選填，YYYY-MM-DD，預設台灣時間今天

只用 Python 標準函式庫，GitHub Actions 不用另外安裝套件。
"""
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "docs", "news")
UA = "EnglishTalkNewsBot/1.0 (https://github.com/Ricky-teng/englishtalk; learning app daily reading)"
API = "https://en.wikipedia.org/w/api.php"
TZ = dt.timezone(dt.timedelta(hours=8))           # 台灣時間
STABLE_HOURS = 12                                  # 只用至少 12 小時沒被改過的版本（剛發生的事件條目常常一直在改）
MIN_WORDS, MAX_WORDS = 140, 380                    # 文章長度（字數）
REUSE_DAYS = 45                                    # 45 天內用過的條目不再用
LEVELS = ["A2", "B1", "B2", "C1"]


# ---------------------------------------------------------------- 小工具

def atomic_write(path, data):
    """先寫暫存檔再 os.replace，避免寫到一半留下壞掉的 JSON"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def http_json(url, data=None, headers=None, tries=3, timeout=60):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 400 這類請求本身的錯，重試也沒用，直接丟出去（呼叫端可能要換設定再送）
            if e.code < 500 and e.code != 429:
                raise
            if i == tries - 1:
                raise
            print(f"  重試（{e}）", file=sys.stderr)
            time.sleep(10 * (i + 1))
        except Exception as e:  # 逾時、連線中斷：等一下再試
            if i == tries - 1:
                raise
            print(f"  重試（{e}）", file=sys.stderr)
            time.sleep(10 * (i + 1))


def wiki(**params):
    time.sleep(0.6)   # 對維基百科客氣一點：連續請求之間停一下，免得被限流（429）
    params = {"format": "json", "formatversion": "2", **params}
    return http_json(API + "?" + urllib.parse.urlencode(params))


def norm_space(s):
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- 挑新聞

def itn_titles():
    """維基百科首頁「新聞動態」（In the news）每一則的粗體連結 = 那個事件的條目"""
    t = wiki(action="parse", page="Template:In_the_news", prop="text")["parse"]["text"]
    out = []
    for m in re.finditer(r'<b><a href="/wiki/([^"#?]+)"', t):
        title = urllib.parse.unquote(m.group(1)).replace("_", " ")
        if title not in out:
            out.append(title)
    return out


def taiwan_titles(today):
    """最近 3 天「時事」頁裡提到台灣的項目，取其中像事件條目的連結（標題有年份）"""
    out = []
    for back in range(1, 4):
        d = today - dt.timedelta(days=back)
        page = f"Portal:Current events/{d.year} {d.strftime('%B')} {d.day}"
        try:
            t = wiki(action="parse", page=page, prop="text")["parse"]["text"]
        except Exception:
            continue
        for li in re.findall(r"<li>(.*?)</li>", t, flags=re.S):
            if "Taiwan" not in li:
                continue
            for m in re.finditer(r'<a href="/wiki/([^"#?]+)"', li):
                title = urllib.parse.unquote(m.group(1)).replace("_", " ")
                if re.match(r"^(19|20)\d\d ", title) and title not in out:
                    out.append(title)
    return out


def stable_revision(title):
    """回傳至少 STABLE_HOURS 小時沒被改過的最新版本 (revid, timestamp)；條目太新就回傳 None"""
    q = wiki(action="query", prop="revisions", titles=title, rvprop="ids|timestamp", rvlimit=50, redirects=1)
    pages = q["query"]["pages"]
    if not pages or "missing" in pages[0]:
        return None, None
    real_title = pages[0]["title"]
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=STABLE_HOURS)
    for rev in pages[0].get("revisions", []):   # 由新到舊
        ts = dt.datetime.fromisoformat(rev["timestamp"].replace("Z", "+00:00"))
        if ts <= cutoff:
            return real_title, rev
    return real_title, None


class LeadText(HTMLParser):
    """只留導言段落 <p> 的文字；拿掉註腳 [1]、表格、資訊框、發音、隱藏元素"""
    SKIP_TAGS = {"table", "style", "script", "sup", "figure", "math"}
    SKIP_CLASS = re.compile(r"reference|mw-editsection|noprint|mw-empty-elt|IPA|nowrap.*audio|hatnote|infobox|shortdescription")

    def __init__(self):
        super().__init__()
        self.paras, self.buf, self.in_p, self.skip = [], [], 0, 0

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class") or ""
        if self.skip or tag in self.SKIP_TAGS or self.SKIP_CLASS.search(cls) or "display:none" in (dict(attrs).get("style") or ""):
            if tag not in ("br", "img", "wbr"):
                self.skip += 1
            return
        if tag == "p":
            self.in_p += 1
            self.buf = []

    def handle_endtag(self, tag):
        if self.skip:
            if tag not in ("br", "img", "wbr"):
                self.skip -= 1
            return
        if tag == "p" and self.in_p:
            self.in_p -= 1
            text = norm_space("".join(self.buf))
            text = re.sub(r"\s+([,.;:!?)])", r"\1", text).replace("( ", "(")
            text = re.sub(r"\(\s*\)", "", text)     # 拿掉發音後留下的空括號
            if len(text.split()) >= 8:
                self.paras.append(norm_space(text))

    def handle_data(self, data):
        if self.in_p and not self.skip:
            self.buf.append(data)


def lead_paragraphs(revid):
    t = wiki(action="parse", oldid=revid, prop="text", section=0)["parse"]["text"]
    p = LeadText()
    p.feed(t)
    out, n = [], 0
    for para in p.paras:
        w = len(para.split())
        if out and n + w > MAX_WORDS:
            break
        out.append(html.unescape(para))
        n += w
    return out, n


def recent_titles():
    idx = os.path.join(OUT, "index.json")
    if not os.path.exists(idx):
        return set()
    with open(idx, encoding="utf-8") as f:
        items = json.load(f).get("items", [])
    cut = (dt.datetime.now(TZ).date() - dt.timedelta(days=REUSE_DAYS)).isoformat()
    return {x["title"] for x in items if x.get("date", "") >= cut}


def pick_story(today):
    used = recent_titles()
    # 台灣、世界輪流：日期是偶數天先找台灣
    tw = taiwan_titles(today)
    world = itn_titles()
    order = (tw + world) if today.toordinal() % 2 == 0 else (world + tw)
    for title in order:
        if title in used:
            continue
        real, rev = stable_revision(title)
        if not rev or real in used:
            print(f"  跳過 {title}（太新或用過）")
            continue
        paras, n = lead_paragraphs(rev["revid"])
        if n < MIN_WORDS:
            print(f"  跳過 {title}（只有 {n} 字）")
            continue
        return {
            "title": real,
            "region": "taiwan" if title in tw else "world",
            "paragraphs": paras,
            "words": n,
            "source": {
                "name": "Wikipedia",
                "title": real,
                "revid": rev["revid"],
                "revisedAt": rev["timestamp"],
                "url": f"https://en.wikipedia.org/w/index.php?title={urllib.parse.quote(real.replace(' ', '_'))}&oldid={rev['revid']}",
                "license": "CC BY-SA 4.0",
                "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
            },
        }
    raise SystemExit("今天找不到合適的新聞條目")


# ---------------------------------------------------------------- AI：生字與題目

def thinking_config(model):
    """少想一點：生字、出題不需要長考，想太久會逾時，也會吃掉輸出額度"""
    if "2.5" in model:
        return {"thinkingBudget": 0 if "flash" in model else 128}
    return {"thinkingLevel": "low"}


NO_THINK_CFG = set()   # 不接受思考設定的模型，記住之後就不再帶


def gemini(prompt, key, model):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent"
    cfg = {"temperature": 0.2, "maxOutputTokens": 8192, "responseMimeType": "application/json"}
    if model not in NO_THINK_CFG:
        cfg["thinkingConfig"] = thinking_config(model)
    for attempt in range(2):
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": cfg}
        try:
            # 回覆可能很長（生字＋例句），等久一點
            d = http_json(url, data=json.dumps(body).encode("utf-8"), timeout=180,
                          headers={"Content-Type": "application/json", "x-goog-api-key": key})
        except urllib.error.HTTPError as e:
            # 這個模型不接受思考設定：拿掉再送一次
            if e.code == 400 and attempt == 0 and "thinkingConfig" in cfg:
                print(f"  {model} 不接受思考設定，改用預設", file=sys.stderr)
                NO_THINK_CFG.add(model)
                cfg = {k: v for k, v in cfg.items() if k != "thinkingConfig"}
                continue
            raise
        cand = d["candidates"][0]
        parts = cand.get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if not text and cand.get("finishReason") == "MAX_TOKENS":
            raise RuntimeError("輸出被截斷（MAX_TOKENS）")
        return json.loads(text)
    raise RuntimeError("Gemini 沒有回應")


def has_word(text, w):
    return re.search(r"(?<![A-Za-z])" + re.escape(w) + r"(?![A-Za-z])", text, flags=re.I) is not None


def uses_word(sentence, w, lemma):
    """例句有沒有用到這個字（原形、文中的形態，或常見的字尾變化）"""
    if has_word(sentence, w) or has_word(sentence, lemma):
        return True
    stem = re.escape(lemma.lower().rstrip("e")[:max(3, len(lemma) - 2)])
    return re.search(r"(?<![A-Za-z])" + stem + r"[a-z]{0,4}(?![A-Za-z])", sentence.lower()) is not None


def own_example(x, text, w, lemma):
    """AI 另外造的例句：要用到這個字、不能是文章裡的句子；不合格就留空（之後網站的自動補齊會補）"""
    ex = norm_space(str(x.get("ex", "")))
    ex_zh = norm_space(str(x.get("exZh", "")))
    if not ex or not uses_word(ex, w, lemma) or ex in norm_space(text) or len(ex.split()) > 25:
        return "", ""
    return ex, ex_zh


VOCAB_PROMPT = """You are preparing a reading lesson for Taiwanese learners of English.
Here is a news text (do NOT change it):
<<<
{text}
>>>
For EACH CEFR level A2, B1, B2, C1, choose about 5 words or short phrases FROM THIS TEXT that a learner at that level
probably does not know yet but should learn (useful, not proper nouns, not numbers, not too technical).
Rules:
- "w": exactly as it appears in the text (same spelling and form)
- "lemma": dictionary form (e.g. "negotiated" -> "negotiate")
- "pos": n. v. adj. adv. prep. conj. or phr.
- "zh": short Traditional Chinese meaning IN THIS CONTEXT (Taiwan usage, never Simplified), 12 characters or fewer
- "ex": a NEW, simple, everyday example sentence (8–16 words) using the word in the same meaning.
  It must NOT come from or be about this news story (no names, places or events from the text), and must contain the word or one of its forms.
- "exZh": natural Traditional Chinese translation of "ex"
- Higher levels get harder words; levels may share a few words.
Return JSON: {{"A2":[{{"w":"","lemma":"","pos":"","zh":"","ex":"","exZh":""}}],"B1":[...],"B2":[...],"C1":[...]}}"""

QUIZ_PROMPT = """Write a 3-question multiple-choice reading test for this news text (B1–B2 learners):
<<<
{text}
>>>
Requirements:
- Question 1: main idea of the whole text. Question 2: a specific detail. Question 3: an inference or the meaning of a word/phrase in context.
- Every correct answer MUST be supported by the text; never use outside knowledge.
- 4 options each, in English, similar length, all plausible; wrong options must be clearly wrong according to the text (no trick questions, no "all of the above").
- Don't copy a sentence from the text as the correct option word-for-word; paraphrase it.
- "evidence": the exact sentence(s) from the text that prove the answer, copied character-for-character.
- "why": one short sentence in Traditional Chinese (Taiwan usage) explaining why the answer is correct.
Return JSON: {{"questions":[{{"type":"main|detail|inference","q":"","options":["","","",""],"answer":0,"evidence":"","why":""}}]}}"""

CHECK_PROMPT = """Answer this reading question using ONLY the text. Reply JSON {{"answer": <option index 0-3>, "sure": true|false}}.
Text:
<<<
{text}
>>>
Question: {q}
Options:
{opts}"""


def make_vocab(text, key, model):
    # 分兩次問（A2+B1、B2+C1）：每次的回覆短一半，比較不會逾時
    raw = {}
    for a, b in (("A2", "B1"), ("B2", "C1")):
        prompt = (VOCAB_PROMPT.format(text=text)
                  .replace("For EACH CEFR level A2, B1, B2, C1", f"For EACH CEFR level {a} and {b}")
                  .replace('"B1":[...],"B2":[...],"C1":[...]', f'"{b}":[...]')
                  .replace('{"A2":', '{"' + a + '":'))
        part = gemini(prompt, key, model)
        if isinstance(part, dict):
            raw.update({lv: part.get(lv, []) for lv in (a, b)})
    out = {}
    for lv in LEVELS:
        seen, items = set(), []
        for x in raw.get(lv, []) if isinstance(raw, dict) else []:
            w = str(x.get("w", "")).strip()
            if not w or w.lower() in seen or not has_word(text, w):
                continue   # AI 挑了文章裡沒有的字：丟掉
            seen.add(w.lower())
            lemma = str(x.get("lemma") or w).strip()
            ex, ex_zh = own_example(x, text, w, lemma)
            items.append({"w": w, "lemma": lemma, "pos": str(x.get("pos", "")).strip(),
                          "zh": str(x.get("zh", "")).strip()[:16], "ex": ex, "exZh": ex_zh})
        out[lv] = items[:6]
    return out


def make_quiz(text, key, model, tries=4):
    flat = norm_space(text)
    good = []
    for attempt in range(tries):
        raw = gemini(QUIZ_PROMPT.format(text=text), key, model)
        for q in raw.get("questions", []):
            opts = [norm_space(str(o)) for o in q.get("options", [])]
            ans = q.get("answer")
            ev = norm_space(str(q.get("evidence", "")))
            if len(opts) != 4 or len(set(o.lower() for o in opts)) != 4 or not isinstance(ans, int) or not 0 <= ans < 4:
                continue
            if not ev or ev not in flat:          # 依據的原句一定要真的在文章裡
                print(f"  丟掉一題：依據不在原文（{ev[:40]}…）")
                continue
            if any(norm_space(g["q"]).lower() == norm_space(q.get("q", "")).lower() for g in good):
                continue
            # 不給答案，請 AI 自己再作答一次；答案對不上就不用這題
            chk = gemini(CHECK_PROMPT.format(text=text, q=q.get("q", ""),
                                             opts="\n".join(f"{i}. {o}" for i, o in enumerate(opts))), key, model)
            if chk.get("answer") != ans or chk.get("sure") is False:
                print(f"  丟掉一題：重新作答不一致（{q.get('q', '')[:40]}…）")
                continue
            good.append({"type": q.get("type", ""), "q": norm_space(q.get("q", "")), "options": opts,
                         "answer": ans, "evidence": ev, "why": norm_space(str(q.get("why", "")))})
            if len(good) == 3:
                return good
    if len(good) < 3:
        raise SystemExit(f"題目只通過 {len(good)} 題，今天不發布（寧可不發也不要發錯）")
    return good


# ---------------------------------------------------------------- 主程式

def main():
    dry = "--dry-run" in sys.argv
    today = dt.date.fromisoformat(os.environ["NEWS_DATE"]) if os.environ.get("NEWS_DATE") else dt.datetime.now(TZ).date()
    path = os.path.join(OUT, f"{today.isoformat()}.json")
    if os.path.exists(path) and "--force" not in sys.argv:
        print(f"{today} 已經有了，略過（要重做加 --force）")
        return
    story = pick_story(today)
    text = "\n\n".join(story["paragraphs"])
    print(f"選到：{story['title']}（{story['words']} 字，{story['region']}）")
    if dry:
        print(text)
        return
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise SystemExit("缺少 GEMINI_API_KEY")
    model = (os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash").strip()
    story["vocab"] = make_vocab(text, key, model)
    story["questions"] = make_quiz(text, key, model)
    story["date"] = today.isoformat()
    story["generatedBy"] = {"vocabAndQuiz": model, "text": "original Wikipedia text, unchanged"}
    atomic_write(path, story)

    idx_path = os.path.join(OUT, "index.json")
    items = []
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as f:
            items = json.load(f).get("items", [])
    items = [x for x in items if x.get("date") != story["date"]]
    items.insert(0, {"date": story["date"], "title": story["title"], "region": story["region"],
                     "words": story["words"], "file": f"{story['date']}.json"})
    items.sort(key=lambda x: x["date"], reverse=True)
    atomic_write(idx_path, {"version": 1, "items": items[:120]})
    print(f"ok：{path}")


if __name__ == "__main__":
    main()

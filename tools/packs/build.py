"""
產生網站上的「公共單字包」：docs/packs/index.json 與每一課一個 JSON。

用法（在專案根目錄）：
    python tools/packs/build.py

新增一本書：在 tools/packs/data/ 放一個 .py（格式照 longteng_b1.py 的 UNITS），
再到下面的 BOOKS 加一筆設定，重新執行就好。網站不用改程式。
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "docs", "packs")

# 每一本書的說明。module 是 data/ 裡的檔名（不含 .py）
BOOKS = [
    {
        "id": "longteng-b1",
        "module": "longteng_b1",
        "title": "龍騰版 高中英文 第一冊",
        "subtitle": "高一上｜113 學年起的版本",
        "tagPrefix": "龍騰B1",
        "note": "非龍騰官方資料。L1–L9 的單字與片語依均一教育平台的各課單字清單整理；"
                "Review 1–3 找不到現行版本的官方字表，是從舊版同名單元整理的，可能不完整。"
                "中文解釋為依課文語境自行撰寫的簡短釋義，考試請以課本為準。",
    },
    {
        "id": "live-2026-10",
        "module": "live_2026_10",
        "title": "LIVE 互動英語 2026 年 10 月號",
        "subtitle": "雜誌｜No.306・每篇文章的重點單字",
        "tagPrefix": "Live2610",
        "note": "非 LiveABC 官方資料。單字依 LiveABC 官方「行動單字卡」網頁的各單元字表整理，"
                "中文解釋為依文章語境自行撰寫的簡短釋義。完整解說、例句與發音請看官方單字卡。",
        "link": "https://voccard.liveabc.com/live/2026/10",
        "linkText": "LiveABC 官方行動單字卡",
    },
    {
        "id": "abc-2026-10",
        "module": "abc_2026_10",
        "title": "ABC 互動英語 2026 年 10 月號",
        "subtitle": "雜誌｜2026 年 10 月號・每篇文章的重點單字",
        "tagPrefix": "ABC2610",
        "note": "非 LiveABC 官方資料。單字依 LiveABC 官方「行動單字卡」網頁的ABC 互動英語各單元字表整理，"
                "中文解釋為依文章語境自行撰寫的簡短釋義。完整解說、例句與發音請看官方單字卡。",
        "link": "https://voccard.liveabc.com/abc/2026/10",
        "linkText": "LiveABC 官方行動單字卡",
    },
    {
        "id": "allplus-2026-10",
        "module": "allplus_2026_10",
        "title": "ALL+ 互動英語 2026 年 10 月號",
        "subtitle": "雜誌｜2026 年 10 月號・每篇文章的重點單字",
        "tagPrefix": "ALL2610",
        "note": "非 LiveABC 官方資料。單字依 LiveABC 官方「行動單字卡」網頁的ALL+ 互動英語各單元字表整理，"
                "中文解釋為依文章語境自行撰寫的簡短釋義。完整解說、例句與發音請看官方單字卡。",
        "link": "https://voccard.liveabc.com/allplus/2026/10",
        "linkText": "LiveABC 官方行動單字卡",
    },
    {
        "id": "cnn-2026-10",
        "module": "cnn_2026_10",
        "title": "CNN 互動英語 2026 年 10 月號",
        "subtitle": "雜誌｜2026 年 10 月號・每篇文章的重點單字",
        "tagPrefix": "CNN2610",
        "note": "非 LiveABC 官方資料。單字依 LiveABC 官方「行動單字卡」網頁的CNN 互動英語各單元字表整理，"
                "中文解釋為依文章語境自行撰寫的簡短釋義。完整解說、例句與發音請看官方單字卡。",
        "link": "https://voccard.liveabc.com/cnn/2026/10",
        "linkText": "LiveABC 官方行動單字卡",
    },
    {
        "id": "ivy-analysis-2026-10",
        "module": "ivy_analysis_2026_10",
        "title": "常春藤解析英語 2026 年 10 月號",
        "subtitle": "雜誌｜2026 年 10 月號・官網免費廣播文章的單字與片語",
        "tagPrefix": "常春藤解析2610",
        "note": "非常春藤官方資料。依常春藤官網免費公開的「解析英語廣播文章」（10/1–10/30）整理每篇的 Words in Use 與 Practical Phrases，"
                "可能不是紙本雜誌的全部文章；中文解釋為依文章語境自行撰寫的簡短釋義。",
        "link": "https://www.ivy.com.tw/newsLetter/analysis_list",
        "linkText": "常春藤官網解析英語廣播文章",
    },
    {
        "id": "ivy-life-2026-10",
        "module": "ivy_life_2026_10",
        "title": "常春藤生活英語 2026 年 10 月號",
        "subtitle": "雜誌｜2026 年 10 月號・官網免費廣播文章的單字與片語",
        "tagPrefix": "常春藤生活2610",
        "note": "非常春藤官方資料。依常春藤官網免費公開的「生活英語廣播文章」（10/1–10/30）整理每篇的 Words in Use 與 Practical Phrases，"
                "可能不是紙本雜誌的全部文章；中文解釋為依文章語境自行撰寫的簡短釋義。",
        "link": "https://www.ivy.com.tw/newsLetter/life_list",
        "linkText": "常春藤官網生活英語廣播文章",
    },
]


def atomic_write(path, data):
    """先寫暫存檔再 os.replace，避免寫到一半留下壞掉的 JSON"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def load_units(module):
    spec = importlib.util.spec_from_file_location(module, os.path.join(HERE, "data", module + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.UNITS


def main():
    index = {"version": 1, "packs": []}
    for book in BOOKS:
        units_meta = []
        for code, title, verified, words, phrases in load_units(book["module"]):
            # 資料檔裡詞性標成 phr. 的也算片語（有些資料把片語和單字放在同一個清單）
            phrases = [(w, z) for w, p, z in words if p == "phr."] + list(phrases)
            words = [x for x in words if x[1] != "phr."]
            tag = f'{book["tagPrefix"]}-{code}'
            items = [{"w": w, "pos": p, "zh": z} for w, p, z in words] + \
                    [{"w": w, "pos": "phr.", "zh": z} for w, z in phrases]
            rel = f'{book["id"]}/{code}.json'
            atomic_write(os.path.join(OUT, rel), {
                "id": code, "title": title, "tag": tag, "verified": verified, "items": items,
            })
            units_meta.append({
                "id": code, "title": title, "tag": tag, "file": rel, "verified": verified,
                "words": len(words), "phrases": len(phrases),
                "preview": [w for w, _, _ in words[:6]],
            })
        meta = {k: book[k] for k in ("id", "title", "subtitle", "tagPrefix", "note", "link", "linkText") if k in book}
        index["packs"].append(meta | {"units": units_meta})
    atomic_write(os.path.join(OUT, "index.json"), index)
    total = sum(u["words"] + u["phrases"] for p in index["packs"] for u in p["units"])
    print(f"ok：{len(index['packs'])} 本書、{sum(len(p['units']) for p in index['packs'])} 個單元、{total} 筆")


if __name__ == "__main__":
    main()

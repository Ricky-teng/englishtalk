# 每日新聞

每天台灣時間早上 6 點，GitHub Actions 會執行 `tools/news/build_news.py`：

1. 從維基百科首頁「In the news」和最近的「Current events」（有台灣的優先，台灣、國際隔天輪流）挑一則事件條目
2. 取那個條目**至少 12 小時沒被改過**的版本，照抄導言的前幾段（140–380 字），**不經 AI 改寫**
3. 用 Gemini 做兩件事，並自動核對：
   - A2／B1／B2／C1 各挑約 5 個生字（不在文章裡的字會被丟掉）
   - 3 題閱讀測驗（主旨、細節、推論），每題附依據原句；原句不在文章裡、或 AI 重新作答對不上的題目會被丟掉重出；湊不滿 3 題當天就不發布
4. 存成 `docs/news/YYYY-MM-DD.json`，更新 `docs/news/index.json`，推回 main

網站上的「新聞」分頁讀這些檔案。使用者覺得太難可以按「AI 簡化版」，那是用**他自己的金鑰**改寫，畫面會標示「可能有錯，以原文為準」。

## 第一次設定（只要做一次）

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name：`GEMINI_API_KEY`
   - Secret：你的 Gemini API 金鑰（aistudio.google.com/apikey）
2. （選用）同一頁的 **Variables** 分頁新增 `GEMINI_MODEL`，例如 `gemini-3.5-flash-lite`。沒設就用 `gemini-3.5-flash`。
3. **Settings → Actions → General → Workflow permissions** 確認是「Read and write permissions」（機器人要把新聞推回 repo）。
4. 到 **Actions → daily-news → Run workflow** 手動跑一次，確認成功；之後每天會自動跑。

每天大約用 6～20 次 Gemini 請求（出題、核對），在免費額度內。

## 本機測試

```
python tools/news/build_news.py --dry-run          # 只抓文章、印出來，不呼叫 AI
GEMINI_API_KEY=... python tools/news/build_news.py  # 產生今天的（已經有了就略過，重做加 --force）
```

## 授權

文章來自維基百科，授權 CC BY-SA 4.0；每篇都附原條目的固定版本連結與授權連結。

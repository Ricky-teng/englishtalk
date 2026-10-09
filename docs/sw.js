/**
 * sw.js — 讓網站可以安裝到手機桌面，並在沒網路時也能打開
 *
 * 策略：同網域的檔案一律「網路優先」——有網路就拿最新的並順手存一份，
 * 沒網路才用存起來的版本。這樣你推新版到 GitHub 後，大家一打開就是新的，
 * 不會卡在舊快取（快取優先的 PWA 最常見的坑）。
 * 跨網域的請求（Gemini、Groq 等 API）完全不經手、不快取。
 */

const VERSION = "et-v9";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/store.js", "js/llm.js", "js/tts.js", "js/asr.js", "js/vocab.js",
  "js/stats.js", "js/lookup.js", "js/shadow.js", "js/listen.js", "js/speakreview.js",
  "js/whatsnew.js", "js/quiz.js", "js/insights.js", "js/fsrs.js", "js/grammar.js", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL).catch(() => {}))   // 少一個檔案也不要讓安裝失敗
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // API 請求不碰

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))
          .then(hit => hit || new Response("離線中，而且這個檔案還沒有被存下來。", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))
      )
  );
});

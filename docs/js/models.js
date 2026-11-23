/**
 * models.js — 模型清單與選擇器（設定頁的下拉選單 + 每個模型的優缺點說明）
 *
 * 清單是手動整理的（2026-10 官方文件）：供應商的模型會汰換，
 * 所以另外保留「抓取我帳號可用的模型」與「自己輸入」兩條路，清單過時也不會卡住。
 * 免費額度的數字以 Groq 官方表格為準；Gemini 官方沒有公開免費額度表，請以 AI Studio 顯示為準。
 */

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * fit：適合做什麼。chat = 即時對話，tool = 查字、新增單字、文法檢查
 * speed：1–3（3 最快）；brain：1–3（3 最聰明）
 */
export const CATALOG = {
  groq: [
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", fit: ["chat"], speed: 3, brain: 1,
      pros: ["回應最快，對話最順", "每日次數最多"],
      cons: ["小模型，中文和格式較不穩，查字偶爾失敗", "每分鐘額度少，和查字共用易被擋"],
      best: "對話（推薦）" },
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", fit: ["chat", "tool"], speed: 2, brain: 2,
      pros: ["中文、例句、JSON 格式穩定，查字少出錯", "英文自然，對話品質優於 8B"],
      cons: ["比 8B 慢", "每日次數少於 8B，整天聊可能用完"],
      best: "查字、新增單字、文法檢查（推薦）" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", fit: ["tool"], speed: 2, brain: 2,
      limits: "每分鐘 30 次・每分鐘 8K token・每天 1,000 次", rpd: 1000,
      pros: ["推理好，文法說明有條理", "速度尚可"],
      cons: ["回答前會先思考，延遲高、較耗額度", "對話時反應慢"],
      best: "文法檢查" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", fit: ["tool"], speed: 1, brain: 3,
      limits: "每分鐘 30 次・每分鐘 8K token・每天 1,000 次", rpd: 1000,
      pros: ["Groq 上數一數二聰明，文法和多義字判斷最準"],
      cons: ["最慢，會先思考", "每日僅 1,000 次，不適合即時對話"],
      best: "最準的查字與文法" },
    { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B（預覽版）", fit: ["tool"], speed: 2, brain: 2, preview: true,
      limits: "每分鐘 30 次・每分鐘 8K token・每天 1,000 次", rpd: 1000,
      pros: ["中文能力強，繁中解釋最自然"],
      cons: ["預覽版，Groq 可能隨時下架", "可能先思考，速度不穩"],
      best: "中文解釋（可試用）" },
  ],
  gemini: [
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", fit: ["chat", "tool"], speed: 3, brain: 1,
      pros: ["最快、最省額度，幾乎不思考", "Google 建議新專案使用"],
      cons: ["解釋較簡短，難字細微差別偶爾說不清"],
      best: "對話、文法檢查（推薦）" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", fit: ["chat", "tool"], speed: 2, brain: 2,
      pros: ["速度與品質平衡，查字和例句品質好"],
      cons: ["比 Flash-Lite 慢，免費額度通常較少"],
      best: "查字、新增單字" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", fit: ["chat", "tool"], speed: 2, brain: 3,
      pros: ["最新最聰明的 Flash，多義字和用法差別解釋最清楚"],
      cons: ["會先思考（已設最低程度），比 Lite 慢", "免費額度可能較緊"],
      best: "最好的查字品質" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", fit: ["chat", "tool"], speed: 3, brain: 1,
      pros: ["很快、很省"],
      cons: ["比 3.5 Flash-Lite 舊一代"],
      best: "3.5 Flash-Lite 的備案" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash（舊版）", fit: ["chat", "tool"], speed: 2, brain: 2,
      pros: ["舊預設，穩定"],
      cons: ["Google 已限制，僅近期用過的帳號可用，新金鑰可能被拒"],
      best: "已在使用且正常的帳號" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite（舊版）", fit: ["chat", "tool"], speed: 3, brain: 1,
      pros: ["很快"],
      cons: ["新帳號可能無法使用"],
      best: "已在使用且正常的帳號" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro（預覽版）", fit: ["tool"], speed: 1, brain: 3, preview: true,
      pros: ["推理最強"],
      cons: ["很慢、會深度思考，免費額度很少或沒有", "不適合即時對話"],
      best: "不建議用於本站" },
  ],
};

/** 「自動」實際會用哪個（查字等背景工作） */
export const AUTO_TOOL = { groq: "llama-3.3-70b-versatile", gemini: "gemini-3.5-flash-lite" };

export function info(provider, id) {
  return (CATALOG[provider] || []).find(m => m.id === id) || null;
}

const dots = (n, label) => `<span class="mc-meter" title="${label} ${n}/3">${label}
  ${[1, 2, 3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;

/** 模型說明卡 */
function cardHTML(provider, id, { kind, auto } = {}) {
  const m = info(provider, id);
  if (!m) {
    return id ? `<div class="mc"><div class="mc-head"><b>${esc(id)}</b></div>
      <p class="mc-none">這個模型不在清單中。請按「🔌 測試連線」確認能否使用。</p></div>` : "";
  }
  const warnChat = kind === "chat" && !m.fit.includes("chat");
  return `<div class="mc">
    <div class="mc-head"><b>${esc(m.name)}</b>${m.preview ? `<span class="mc-tag warn">預覽版</span>` : ""}
      ${auto ? `<span class="mc-tag">自動選用</span>` : ""}</div>
    <div class="mc-meters">${dots(m.speed, "速度")}${dots(m.brain, "聰明")}</div>
    <div class="mc-best">適合：${esc(m.best)}</div>
    ${warnChat ? `<div class="mc-warn">⚠️ 這個模型較慢，對話會卡頓。</div>` : ""}
    <ul class="mc-list pros">${m.pros.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <ul class="mc-list cons">${m.cons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${m.limits ? `<div class="mc-lim">免費額度：${esc(m.limits)}</div>` : ""}
  </div>`;
}

/**
 * 把一個 <select> 變成模型選擇器。
 * @param {Object} o
 * @param {HTMLSelectElement} o.select
 * @param {HTMLInputElement} o.custom   選「自己輸入」時出現的輸入框
 * @param {HTMLElement} o.desc          說明卡放這裡
 * @param {"groq"|"gemini"} o.provider
 * @param {"chat"|"tool"} o.kind        tool 會多「自動」「跟對話同一個」兩個選項
 * @param {Function} o.chatValue        tool 選「跟對話同一個」時，用來顯示對話模型的說明
 */
export function mountPicker(o) {
  let fetched = [];
  const build = (current) => {
    const list = CATALOG[o.provider];
    const sorted = list;
    const extra = fetched.filter(id => !info(o.provider, id));
    let html = "";
    if (o.kind === "tool") {
      html += `<option value="auto">自動（推薦）：${esc(info(o.provider, AUTO_TOOL[o.provider]).name)}</option>
               <option value="same">同對話模型</option>`;
    }
    const opt = (m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.best)}</option>`;
    const good = sorted.filter(m => m.fit.includes(o.kind)), rest = sorted.filter(m => !m.fit.includes(o.kind));
    html += `<optgroup label="${o.kind === "chat" ? "適合即時對話" : "適合查字、文法"}">${good.map(opt).join("")}</optgroup>`;
    if (rest.length) html += `<optgroup label="${o.kind === "chat" ? "較慢，不建議用於對話" : "其他"}">${rest.map(opt).join("")}</optgroup>`;
    if (extra.length) {
      html += `<optgroup label="你帳號可用的其他模型">`
        + extra.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join("") + `</optgroup>`;
    }
    if (current && current !== "auto" && current !== "same" && !info(o.provider, current) && !extra.includes(current)) {
      html += `<optgroup label="目前設定"><option value="${esc(current)}">${esc(current)}</option></optgroup>`;
    }
    html += `<option value="__custom">其他：自行輸入模型 ID…</option>`;
    o.select.innerHTML = html;
  };
  const paint = () => {
    const v = o.select.value;
    o.custom.hidden = v !== "__custom";
    const id = v === "__custom" ? o.custom.value.trim()
             : v === "auto" ? AUTO_TOOL[o.provider]
             : v === "same" ? (o.chatValue ? o.chatValue() : "") : v;
    o.desc.innerHTML = cardHTML(o.provider, id, { kind: o.kind, auto: v === "auto" });
  };
  o.select.addEventListener("change", () => { paint(); if (o.select.value === "__custom") o.custom.focus(); });
  o.custom.addEventListener("input", paint);

  return {
    set(v) {
      build(v);
      o.select.value = v || (o.kind === "tool" ? "auto" : CATALOG[o.provider][0].id);
      if (o.select.value !== (v || o.select.value)) o.select.value = "__custom";
      o.custom.value = "";
      paint();
    },
    get() {
      const v = o.select.value;
      return v === "__custom" ? o.custom.value.trim() : v;
    },
    /** 抓到帳號可用清單後加進選單 */
    addFetched(ids) {
      const cur = this.get();
      fetched = ids;
      build(cur);
      o.select.value = cur;
      if (o.select.value !== cur) { o.select.value = "__custom"; o.custom.value = cur; }
      paint();
    },
    refresh: paint,
  };
}

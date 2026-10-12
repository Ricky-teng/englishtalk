/**
 * usage.js — AI 用量紀錄
 *
 * 每一次呼叫 AI（成功或失敗）都記一筆：哪個供應商、哪個模型、做什麼用、用了多少 token。
 * 只存在本機（跟其他資料一起），按日彙總，保留最近 31 天。
 * 免費額度的上限：Groq 回應標頭讀得到時用它的數字；讀不到就用整理過的官方數字（models.js），
 * 兩者都沒有就只顯示次數，不亂猜上限。
 */

import { load, save, todayKey } from "./store.js";

const KEEP_DAYS = 31;

function root() {
  const st = load();
  if (!st.aiUsage || typeof st.aiUsage !== "object") st.aiUsage = {};
  if (!st.aiUsage.days) st.aiUsage.days = {};
  if (!st.aiUsage.limits) st.aiUsage.limits = {};
  return st.aiUsage;
}

/** 用途分類（給統計顯示） */
export const PURPOSE = { chat: "對話", grammar: "文法", lookup: "查字等" };

/**
 * 記一筆。
 * @param {Object} r  {provider, model, purpose, ok, tokens, backup, reason}
 */
export function record(r) {
  const u = root();
  const day = todayKey();
  const d = u.days[day] || (u.days[day] = {});
  const k = r.provider + "|" + r.model;
  const row = d[k] || (d[k] = { req: 0, ok: 0, fail: 0, tok: 0, backup: 0, by: {} });
  row.req++;
  if (r.ok) row.ok++; else row.fail++;
  row.tok += Math.max(0, Math.round(r.tokens || 0));
  if (r.backup && r.ok) row.backup++;
  const p = r.purpose || "lookup";
  row.by[p] = (row.by[p] || 0) + 1;
  if (!r.ok && r.reason) row.lastFail = r.reason;

  // 只留最近 31 天
  const keys = Object.keys(u.days).sort();
  while (keys.length > KEEP_DAYS) delete u.days[keys.shift()];
  save();
}

/** 供應商回報的每日上限（Groq 標頭：x-ratelimit-limit-requests / remaining-requests） */
export function setLimit(provider, model, info) {
  const u = root();
  u.limits[provider + "|" + model] = { ...info, at: Date.now() };
}

export function limitOf(provider, model) {
  const x = root().limits[provider + "|" + model];
  // 超過一天的就不準了
  return x && Date.now() - x.at < 24 * 3600 * 1000 ? x : null;
}

/** 今天每個模型的用量 [{provider, model, req, ok, fail, tok, backup, by}] */
export function today() {
  const d = root().days[todayKey()] || {};
  return Object.entries(d).map(([k, v]) => {
    const [provider, model] = k.split("|");
    return { provider, model, ...v };
  }).sort((a, b) => b.req - a.req);
}

/** 最近 n 天每天的總次數與 token [{key, req, tok, fail}] */
export function lastDays(n = 7) {
  const days = root().days;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = todayKey(dt);
    const rows = Object.values(days[key] || {});
    out.push({
      key,
      label: (dt.getMonth() + 1) + "/" + dt.getDate(),
      req: rows.reduce((a, r) => a + r.req, 0),
      tok: rows.reduce((a, r) => a + r.tok, 0),
      fail: rows.reduce((a, r) => a + r.fail, 0),
      backup: rows.reduce((a, r) => a + (r.backup || 0), 0),
    });
  }
  return out;
}

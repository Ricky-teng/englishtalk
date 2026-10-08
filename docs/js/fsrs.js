/**
 * fsrs.js — FSRS-5 間隔重複排程（Anki 23.10 之後內建的演算法）
 *
 * 跟 SM-2 的差別：
 *   SM-2 只有一個「難易度係數」，間隔一律乘上去，不管你隔了多久才複習。
 *   FSRS 為每張卡追蹤兩個量：
 *     穩定度 S（天）：記憶衰退到 90% 需要幾天
 *     難度 D（1–10）：這個字對你來說本質上有多難
 *   並用遺忘曲線算出「此刻還記得的機率 R」。逾期很久還答對 → 代表記得比預期牢，
 *   S 會長得更多；R 還很高時就複習 → S 只長一點點（提早複習沒那麼划算）。
 *   官方基準測試中，同樣的記憶率下 FSRS 需要的複習次數比 SM-2 少 20–30%。
 *
 * 參數用 FSRS-5 預設值（以大量 Anki 使用者資料訓練而來）。
 * 這裡不做個人化參數訓練：需要上千筆複習紀錄才有意義，而且運算量大。
 */

// FSRS-5 預設權重 w0–w18
const W = [
  0.40255, 1.18385, 3.173, 15.69105,   // w0–w3：第一次評分（忘記/困難/普通/簡單）後的初始穩定度
  7.1949, 0.5345,                      // w4–w5：初始難度
  1.4604, 0.0046,                      // w6：評分對難度的影響、w7：難度回歸平均的力道
  1.54575, 0.1192, 1.01925,            // w8–w10：答對時穩定度成長
  1.9395, 0.11, 0.29605, 2.2698,       // w11–w14：忘記後的穩定度
  0.2315, 2.9898,                      // w15：「困難」懲罰、w16：「簡單」加成
  0.51655, 0.6621,                     // w17–w18：同一天內重複複習
];
const DECAY = -0.5;
const FACTOR = 19 / 81;               // 讓 S 天後的 R 恰好是 0.9

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 評分：1 忘記、2 困難、3 普通、4 簡單 */
export const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

/** 經過 t 天、穩定度 S 時還記得的機率 */
export function retrievability(t, S) {
  if (!(S > 0)) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, t) / S, DECAY);
}

/** 要讓記得的機率剛好降到 r，需要隔幾天 */
export function intervalFor(S, r = 0.9) {
  return (S / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
}

function initS(G) { return Math.max(0.1, W[G - 1]); }
function initD(G) { return clamp(W[4] - Math.exp(W[5] * (G - 1)) + 1, 1, 10); }

function nextD(D, G) {
  const delta = -W[6] * (G - 3);
  const damped = D + delta * (10 - D) / 9;          // 越接近 10 越難再往上加
  return clamp(W[7] * initD(EASY) + (1 - W[7]) * damped, 1, 10);
}

function recallS(D, S, R, G) {
  const hard = G === HARD ? W[15] : 1;
  const easy = G === EASY ? W[16] : 1;
  return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9])
               * (Math.exp(W[10] * (1 - R)) - 1) * hard * easy);
}

function forgetS(D, S, R) {
  const s = W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R));
  return Math.min(s, S / Math.exp(W[17] * W[18]));  // 忘記後不可能比原本更穩
}

function sameDayS(S, G) {
  return S * Math.exp(W[17] * (G - 3 + W[18]));
}

/** 兩個 YYYY-MM-DD 之間差幾天（本地時區，避開夏令時間的小時誤差） */
export function daysBetween(fromMs, toMs = Date.now()) {
  const a = new Date(fromMs); a.setHours(12, 0, 0, 0);
  const b = new Date(toMs);   b.setHours(12, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

/**
 * 舊卡（只有 SM-2 欄位）第一次用 FSRS 排程時，推估一組 S、D。
 * SM-2 的間隔大約就是「記得率還在 90% 附近」的天數，所以拿來當 S 的起點；
 * 難易度係數 2.5（預設）→ D≈5，1.3（最難）→ D≈9。
 */
export function migrate(card) {
  if (card.fs > 0) return;
  if (!(card.reps > 0) && !card.lastReview) return;          // 新卡維持新卡
  card.fs = Math.max(1, card.interval || 1);
  card.fd = clamp(5 + (2.5 - (card.ef || 2.5)) * (4 / 1.2), 1, 10);
}

/**
 * 算出這次評分後的新狀態，不修改 card。
 * @returns {{s:number, d:number, interval:number}} interval 為 0 表示今天再出現一次
 */
export function schedule(card, G, retention = 0.9, now = Date.now()) {
  let S, D;
  const fresh = !(card.fs > 0);
  if (fresh) {
    S = initS(G);
    D = initD(G);
  } else {
    const t = card.lastReview ? daysBetween(card.lastReview, now) : 0;
    D = nextD(card.fd || 5, G);
    if (t === 0) {
      S = sameDayS(card.fs, G);
    } else {
      const R = retrievability(t, card.fs);
      S = G === AGAIN ? forgetS(card.fd || 5, card.fs, R) : recallS(card.fd || 5, card.fs, R, G);
    }
  }
  S = clamp(S, 0.1, 36500);
  const interval = G === AGAIN ? 0 : clamp(Math.round(intervalFor(S, retention)), 1, 36500);
  return { s: S, d: D, interval };
}

/**
 * 四個評分按鈕各自會排到幾天後（給翻卡畫面顯示，像 Anki 那樣）。
 * 保證 困難 ≤ 普通 < 簡單，避免出現「按簡單反而比較快再見」的怪事。
 */
export function preview(card, retention = 0.9) {
  const h = schedule(card, HARD, retention).interval;
  let g = schedule(card, GOOD, retention).interval;
  let e = schedule(card, EASY, retention).interval;
  g = Math.max(g, h);
  e = Math.max(e, g + 1);
  return { 1: 0, 2: h, 3: g, 4: e };
}

/** 卡片此刻還記得的機率（從沒複習過的回傳 null） */
export function currentR(card, now = Date.now()) {
  if (!(card.fs > 0) || !card.lastReview) return null;
  return retrievability(daysBetween(card.lastReview, now), card.fs);
}

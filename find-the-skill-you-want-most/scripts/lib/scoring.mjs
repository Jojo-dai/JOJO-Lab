// 评分。100 分制，**只排序不淘汰**。
//
// 两条硬约束（对应 plan 的第二节与第五节）：
//   1. stars 权重恒为 0，且不参与任何计算分支 —— 原因见 SCORING.md 与下面的 STARS_REASON
//   2. 安装量只接受 per-skill 值。仓库聚合值（badge）在类型上就进不来：
//      scoreInstall() 只认数字，且调用方必须显式传 {kind:'per-skill'}，
//      kind 不是 'per-skill' 直接抛错。这是刻意设计的"传错就炸"，而不是"传错静默降级"。

export const SCORER_VERSION = '0.1.0';

export const WEIGHTS = {
  relevance: 40,
  installs: 35,
  activity: 15,
  source: 10,
  stars: 0, // ← 恒为 0。不是"暂时调低"，是设计决定。
};

export const STARS_REASON =
  'star 数在这个生态里注水严重——互刷、模板仓库批量导流、awesome-* 聚合仓天然高星但无实际内容。' +
  '实测对照：deanpeters/Product-Manager-Skills 有 6,903★，但其 derisk-measurement-advisor 的真实安装量只有 585。' +
  'stars 衡量的是"仓库被看见"，安装量衡量的是"skill 被使用"——后者才对应"我想要一个好用的 skill"这个问题。' +
  '故 stars 权重恒为 0：不进排序、不进展示，只在 record 里留档供事后审计。';

export const AGGREGATE_REASON =
  'badge 返回的是整个仓库的聚合安装量，不是单个 skill 的量。' +
  '一个塞了 68 个 skill 的仓库，聚合值会天然碾压只有 3 个精品 skill 的仓库。' +
  '实测：phuryn/pm-skills 聚合 203.5K，而其 strategy-red-team 单 skill 只有 8,483、' +
  'identify-assumptions-new 只有 2,435。用聚合值排序会导致系统性误判，故类型上禁止。';

/**
 * 安装量得分。**只接受 per-skill 值。**
 * @param {number} installs
 * @param {{kind:'per-skill'|'repo-aggregate'}} proof
 */
export function scoreInstall(installs, proof) {
  if (!proof || proof.kind !== 'per-skill') {
    throw new Error(
      `scoreInstall 只接受 per-skill 安装量，收到 kind=${JSON.stringify(proof?.kind)}。\n` +
        `原因：${AGGREGATE_REASON}`
    );
  }
  const n = Number(installs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // log 压缩：头部集中（8,483 vs 2,435 相差 3.5 倍，但都在"有人用"这一档），
  // 不压缩的话头部会吞掉全部区分度。10 万安装量为满分锚点。
  const v = (WEIGHTS.installs * Math.log10(n)) / Math.log10(100000);
  return clamp(v, 0, WEIGHTS.installs);
}

/**
 * 相关性得分。关键词匹配强度是"是否切题"的唯一真实信号。
 * @returns {{score:number, matched:Array<{term:string, field:string, kind:string}>}}
 */
export function scoreRelevance(candidate, queryTerms, synonyms = {}) {
  const hay = {
    name: String(candidate.skill || '').toLowerCase(),
    description: String(candidate.description || '').toLowerCase(),
  };
  const matched = [];
  let best = 0;

  const phrases = queryTerms.filter((t) => t.includes(' '));
  const words = expand(queryTerms.filter((t) => !t.includes(' ')), synonyms);

  for (const p of phrases) {
    if (hay.description.includes(p)) matched.push({ term: p, field: 'description', kind: 'phrase' });
    if (hay.name.includes(p.replace(/\s+/g, '-'))) matched.push({ term: p, field: 'name', kind: 'phrase' });
  }
  for (const w of words) {
    if (new RegExp(`\\b${escapeRe(w)}\\b`).test(hay.description)) {
      matched.push({ term: w, field: 'description', kind: 'word' });
    }
    if (new RegExp(`(^|[-_])${escapeRe(w)}([-_]|$)`).test(hay.name)) {
      matched.push({ term: w, field: 'name', kind: 'word' });
    }
  }

  const hasPhrase = matched.some((m) => m.kind === 'phrase' && m.field === 'description');
  const hasWord = matched.some((m) => m.kind === 'word' && m.field === 'description');
  const nameHit = matched.some((m) => m.field === 'name');

  if (hasPhrase) best = 40;
  else if (hasWord) best = 25;
  else if (nameHit) best = 10;
  if (nameHit && best > 0) best = Math.min(40, best + 5);

  return { score: best, matched };
}

/** 活跃度。 */
export function scoreActivity(pushedAt, now = Date.now()) {
  if (!pushedAt) return 0;
  const days = (now - new Date(pushedAt).getTime()) / 86400000;
  if (days <= 30) return 15;
  if (days <= 90) return 10;
  if (days <= 180) return 6;
  if (days <= 365) return 3;
  return 0;
}

/** 来源可信度。 */
export function scoreSource({ awesomeListed = false, org = '' } = {}) {
  let s = 0;
  if (awesomeListed) s += 5;
  if (/^(anthropics|github|aws|google|googleworkspace|microsoft|vercel|vercel-labs|cloudflare)$/i.test(org)) s += 5;
  return s;
}

/**
 * stars 一律 0 分。
 * 这个函数存在**只为了让"stars 为什么是 0"这件事在代码里可见**，它永远返回 0。
 */
export function scoreStars() {
  return WEIGHTS.stars; // === 0
}

export function total(parts) {
  const s =
    (parts.relevance || 0) +
    (parts.installs || 0) +
    (parts.activity || 0) +
    (parts.source || 0) +
    scoreStars(parts.stars);
  return Math.round(s * 100) / 100;
}

function expand(words, synonyms) {
  const out = new Set();
  for (const w of words) {
    out.add(w);
    for (const s of synonyms[w] || []) out.add(s);
  }
  return [...out];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

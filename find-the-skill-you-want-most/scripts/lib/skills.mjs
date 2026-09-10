// skills.sh 客户端 —— 发现通道的主力。
//
// 端点实测（2026-09-10）：
//   GET https://skills.sh/api/search?q=<term>&limit=N
//   → {"query","searchType":"fuzzy","searchVersion","skills":[{id,skillId,name,installs,source}],"count","duration_ms"}
//
// 三个必须记住的坑：
//   1. **结果不按 installs 排序**（实测单调不增 = False）——必须抓回来自己排
//   2. **page / offset / sort 参数全部无效**，恒返回同一批，上限 100 条 ——覆盖面靠"多查询"而非"翻页"
//   3. **q 少于 2 字符**返回 {"error":"Query must be at least 2 characters"}（HTTP 200，不是 4xx）

import { httpGetJson, sleep } from './http.mjs';
import { TTL } from './paths.mjs';

const BASE = 'https://skills.sh/api/search';
const THROTTLE_MS = 1500; // 无速率限制响应头，仍自律

let lastCall = 0;

/**
 * 按关键词搜 skill。
 * @returns {Promise<Array<{id,owner,repo,skill,installs,source}>>}
 */
export async function searchSkills(term, { limit = 100 } = {}) {
  const q = String(term || '').trim();
  if (q.length < 2) {
    throw new Error(`skills.sh 查询至少需要 2 个字符，收到 ${q.length} 个：${JSON.stringify(q)}`);
  }

  // 自己节流：距离上次调用不足 THROTTLE_MS 就补足
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = `${BASE}?q=${encodeURIComponent(q)}&limit=${limit}`;
  const data = await httpGetJson(url, { ttl: TTL.skillsSh });

  if (data.error) throw new Error(`skills.sh 返回错误：${data.error}`);
  const raw = Array.isArray(data.skills) ? data.skills : [];

  return raw.map(normalize).filter(Boolean);
}

function normalize(e) {
  if (!e || !e.id) return null;
  const parts = String(e.id).split('/');
  if (parts.length < 3) return null;
  const skill = parts[parts.length - 1];
  const repo = parts[parts.length - 2];
  const owner = parts.slice(0, -2).join('/');
  return {
    id: e.id,
    owner,
    repo,
    skill: e.skillId || skill,
    installs: Number.isFinite(e.installs) ? e.installs : 0,
    source: e.source || `${owner}/${repo}`,
  };
}

/**
 * 一个 skill 的仓库聚合安装量（badge）。
 *
 * ⚠️ 这是**仓库聚合值，不是单个 skill 的量**。一个塞了 68 个 skill 的仓库，
 * 这个数会天然碾压只有 3 个精品 skill 的仓库。**绝不可用于排序**，
 * 只在需要"这个仓库整体多热"的概览时用，且展示时必须标注"仓库聚合"。
 */
export async function repoAggregateInstalls(owner, repo) {
  const url = `https://skills.sh/api/badge/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const d = await httpGetJson(url, { ttl: TTL.skillsSh });
    if (d.isError) return null;
    return { raw: d.message, isAggregate: true };
  } catch {
    return null;
  }
}

/** 把用户意图拆成多个查询词。skills.sh 无分页，覆盖面靠查询数。 */
const MAX_QUERIES = 30;

export function buildQueries(intent, synonyms) {
  const base = String(intent || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const queries = new Set();
  if (base.length) queries.add(base.join(' '));
  const head = base[0];
  if (head && head.length >= 2) queries.add(head);

  // 两层扩展。单层是不够的：`feasibility` → `validation` 就停了，而真正切题的
  // `assumption` / `experiment` / `red-team` 都在第二层。实测单层扩展下
  // strategy-red-team(8483 装) 一次都没被搜到过 —— 而它正是这个意图的代表 skill。
  const ring1 = new Set();
  for (const w of base) for (const s of synonyms[w] || []) ring1.add(s);

  const ring2 = new Set();
  for (const s of ring1) for (const s2 of synonyms[s] || []) ring2.add(s2);

  for (const s of ring1) queries.add(s);
  for (const s of ring2) if (!ring1.has(s)) queries.add(s);

  // 组合查询（"<同义词> <意图其余词>"）精度最高，但只在第一层做，避免组合爆炸
  const tail = base.slice(1).join(' ');
  for (const s of ring1) queries.add(`${s} ${tail}`.trim());

  // 上限：每次查询都要节流 1.5s，30 个查询 ≈ 45s。宁可慢也不能失控。
  return [...queries].filter((q) => q.length >= 2).slice(0, MAX_QUERIES);
}

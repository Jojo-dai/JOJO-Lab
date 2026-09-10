// api.github.com 客户端 —— 取件与校验通道。
//
// 传输层实测：Node fetch 直连 200；curl 走代理反而 403 —— 一律走 http.mjs，别切回 curl。
// 匿名额度：core 60/小时、search 10/分钟。contents **一个文件 = 一次调用，没有批量接口**，
// 所以"下载整个仓库"在任何情况下都不可行（anthropics/skills 里最大的 skill 有 83 个文件）。

import { httpGet, httpGetJson } from './http.mjs';
import { TTL } from './paths.mjs';

const API = 'https://api.github.com';

// GitHub 对 owner/repo 的查找本身是大小写不敏感的：
// 查 deanpeters/product-manager-skills 会返回 full_name = deanpeters/Product-Manager-Skills。
// 所以不需要特殊处理，但**必须记录返回的 full_name 作为权威大小写**。
export async function getRepo(owner, repo) {
  return httpGetJson(`${API}/repos/${owner}/${repo}`, { ttl: TTL.githubRepo });
}

/** 免费。开跑前读余量，core.remaining 太低就硬停而不是把额度抽干。 */
export async function getRateLimit() {
  const d = await httpGetJson(`${API}/rate_limit`, { ttl: TTL.rateLimit });
  return d.resources;
}

/** 全树。用于定位任意深度的 SKILL.md（实测路径不统一：skills/<n>/ 与 skills/<cat>/<n>/ 都有）。 */
export async function getTree(owner, repo, ref = 'HEAD') {
  return httpGetJson(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
    ttl: TTL.githubTree,
  });
}

/** 锁定不可变快照。溯源记录要真实 SHA，不要浮动分支名。 */
export async function getHeadCommit(owner, repo) {
  const d = await httpGetJson(`${API}/repos/${owner}/${repo}/commits/HEAD`, {
    ttl: TTL.githubContents,
  });
  return { sha: d.sha, date: d.commit?.author?.date ?? null };
}

/** 取文件内容。**一次调用一个文件**。ref 传 commit SHA 以锁定快照。 */
export async function getFileText(owner, repo, filePath, ref = 'HEAD') {
  const url = `${API}/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
  const r = await httpGet(url, {
    ttl: TTL.githubContents,
    accept: 'application/vnd.github.raw',
  });
  if (r.status >= 400) {
    const err = new Error(`HTTP ${r.status} 取 ${owner}/${repo}/${filePath}`);
    err.status = r.status;
    throw err;
  }
  return r.text;
}

/** 从全树里找出所有 SKILL.md，返回其所在目录（即一个候选单元）。大小写不敏感。 */
export function findSkillDirs(tree) {
  const out = [];
  for (const e of tree.tree || []) {
    if (e.type !== 'blob') continue;
    if (!/(^|\/)SKILL\.md$/i.test(e.path)) continue;
    const parts = e.path.split('/');
    parts.pop();
    out.push({ dir: parts.join('/'), skillMd: e.path });
  }
  return out;
}

/** 归一化：小写并去掉所有非字母数字。用于容忍 `_`/`-`/大小写差异。 */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 把 skills.sh 的 skill 名匹配到仓库里的 SKILL.md 目录。
 *
 * skills.sh 的 `skillId` 来自 skill 自己 frontmatter 的 name，**不一定等于目录名** ——
 * 实测 `lllllllama/rigorpilot-skills` 的 `ai-paper-reproduction` 就因目录名不同而漏配，
 * 被误报成"仓库里找不到"。三级递进匹配，且**末级模糊匹配要求唯一命中**：
 * 若多个目录都像，宁可返回 null 让调用方报"歧义"也不猜。
 *
 * @returns {{hit: object|null, how: 'exact'|'normalized'|'fuzzy'|null, ambiguous?: string[]}}
 */
export function matchSkillDir(dirs, skillName) {
  const want = normName(skillName);

  const exact = dirs.find(
    (d) => d.dir.toLowerCase().endsWith('/' + skillName.toLowerCase()) || d.dir.toLowerCase() === skillName.toLowerCase()
  );
  if (exact) return { hit: exact, how: 'exact' };

  const normalized = dirs.find((d) => normName(d.dir.split('/').pop()) === want);
  if (normalized) return { hit: normalized, how: 'normalized' };

  // 模糊：目录名与 skill 名互相包含。必须唯一，否则宁可判歧义。
  const fuzzy = dirs.filter((d) => {
    const base = normName(d.dir.split('/').pop());
    return base && want && (base.includes(want) || want.includes(base));
  });
  if (fuzzy.length === 1) return { hit: fuzzy[0], how: 'fuzzy' };
  if (fuzzy.length > 1) return { hit: null, how: null, ambiguous: fuzzy.map((d) => d.dir) };
  return { hit: null, how: null };
}

/**
 * T0 元数据层（**零网络调用**）：只从已经拿到的 trees / repo 数据里判风险。
 * @returns {{verdict:'ok'|'suspicious', findings:Array}}
 */
export function inspectTreeMetadata(tree, dir) {
  const findings = [];
  const prefix = dir ? dir + '/' : '';
  const files = (tree.tree || []).filter((e) => e.path.startsWith(prefix));

  // 符号链接 —— trees 里 mode 120000。绝不跟随：指向 ~/.ssh/id_rsa 的链接是真实攻击。
  const symlinks = files.filter((e) => e.mode === '120000');
  for (const s of symlinks) {
    findings.push({ severity: 'HIGH', rule: 'symlink', detail: s.path });
  }

  const blobs = files.filter((e) => e.type === 'blob');
  const bytes = blobs.reduce((a, e) => a + (e.size || 0), 0);

  return {
    verdict: findings.some((f) => f.severity === 'HIGH') ? 'suspicious' : 'ok',
    fileCount: blobs.length,
    bytes,
    symlinks: symlinks.length,
    findings,
  };
}

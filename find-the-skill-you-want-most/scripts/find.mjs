#!/usr/bin/env node
// 主编排器：发现 → 去重 → 按仓库分组 → T0/T1 扫描 → 评分 → 渲染表。
//
// 额度设计（这是本文件最重要的部分）：
//   匿名 GitHub core 只有 60 次/小时，而 contents API 是**一个文件一次调用**。
//   所以绝不能对 100 个候选逐个查 GitHub。实际做法：
//     1. 先用 skills.sh 的 per-skill 安装量在**本地**排序（零 GitHub 调用）
//     2. 按**仓库**分组 —— phuryn/pm-skills 里的 10 个 skill 只花 1 次 tree 调用
//     3. 只对前 --max-repos 个仓库做 GitHub 解析
//     4. T1 只对前 --shortlist 个候选抓 SKILL.md
//
// 缓存使得**重复跑同一条查询消耗 0 额度**（验收标准）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureStateDirs,
  REJECTED_PATH,
  appendJsonl,
  readJson,
  SKILLS_DIR,
  GSTACK_MARKER,
  OWNED_MARKER,
} from './lib/paths.mjs';
import { searchSkills, buildQueries } from './lib/skills.mjs';
import { getRepo, getTree, getFileText, getRateLimit, findSkillDirs, matchSkillDir, inspectTreeMetadata } from './lib/github.mjs';
import { parseFrontmatter, NAME_RE } from './lib/frontmatter.mjs';
import { scanText, scanFrontmatter, verdictOf, summarize, SCANNER_VERSION } from './lib/scan.mjs';
import { scoreRelevance, scoreInstall, scoreActivity, scoreSource, total, WEIGHTS, SCORER_VERSION } from './lib/scoring.mjs';
import { renderTable, renderDetail } from './lib/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNONYMS = readJson(path.join(__dirname, 'synonyms.json'), {});

const RESERVE = 5; // 永不把额度抽干
const MIN_INSTALLS = 10; // 硬门槛；skills.sh 免费给出，所以必须在花 GitHub 额度前就判掉

function parseArgs(argv) {
  const a = { intent: '', shortlist: 12, maxRepos: 12, dryRun: false, json: false, detail: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--shortlist') a.shortlist = parseInt(argv[++i], 10) || 12;
    else if (t === '--max-repos') a.maxRepos = parseInt(argv[++i], 10) || 12;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--json') a.json = true;
    else if (t === '--no-detail') a.detail = false;
    else if (!t.startsWith('--')) rest.push(t);
  }
  a.intent = rest.join(' ');
  return a;
}

/**
 * 相关性预排序 —— **零 GitHub 调用**，只用 skills.sh 已经返回的字段。
 *
 * 存在的理由：GitHub 额度只有 60 次/小时，必须花在"值得看的候选"上。而
 * "值不值得看"取决于**相关性**，不是安装量。初版没这一步，于是通用高装量 skill
 * 把额度吃光，切题的长尾 skill 一次都没被解析到。
 *
 * 信号：
 *   - 名称命中意图词（权重高）> id 命中（弱，id 里含 owner/repo 噪声）
 *   - 全短语命中额外加分（"product-feasibility" 比单词散落更可信）
 *   - 被**多词查询**命中加分 —— 多词查询本身就比单词查询更具体
 * 命中比例作为乘数，避免"命中一个词就排第一"。
 */
function prelimScore(cand, terms) {
  const name = String(cand.skill || '').toLowerCase();
  const id = String(cand.id || '').toLowerCase();
  let s = 0;
  let hits = 0;
  for (const t of terms) {
    if (name.includes(t)) {
      s += 25;
      hits++;
    } else if (id.includes(t)) {
      s += 8;
      hits++;
    }
  }
  if (terms.length > 1 && name.includes(terms.join('-'))) s += 20;
  for (const q of cand.queries || []) {
    const w = String(q).trim().split(/\s+/).length;
    if (w > 1) s += 6 * w;
  }
  // 覆盖面是**阻尼器，不是闸门**。初版写成 `return s * frac` —— 名字里没有字面命中就归零，
  // 于是 strategy-red-team（作者会在描述里写 feasibility，但名字里没有）被直接清零。
  // 名称是烂的相关性信号，真正的相关性命中要靠 T1 拿到的 description，所以这里只排序、不淘汰。
  const frac = terms.length ? hits / terms.length : 0;
  return s * (0.35 + 0.65 * frac);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.intent) {
    console.error('用法: node find.mjs "<你的需求>" [--shortlist N] [--max-repos N] [--dry-run] [--json]');
    process.exit(2);
  }
  ensureStateDirs();

  // —— 额度预检 ——
  let core = { remaining: 60, limit: 60, reset: 0 };
  try {
    const r = await getRateLimit();
    core = r.core;
  } catch (e) {
    console.error(`[warn] 读不到 rate_limit，按保守值继续：${e.message}`);
  }
  if (core.remaining <= RESERVE) {
    const reset = new Date(core.reset * 1000).toISOString();
    console.error(`GitHub core 额度只剩 ${core.remaining}（保留 ${RESERVE}），重置于 ${reset}。已停止。`);
    process.exit(3);
  }

  // —— 步骤 1：skills.sh 多查询发现 ——
  const queries = buildQueries(args.intent, SYNONYMS);
  const found = new Map(); // id -> candidate
  const queryHits = new Map(); // id -> [query]
  const errors = [];

  for (const q of queries) {
    try {
      const hits = await searchSkills(q, { limit: 100 });
      for (const h of hits) {
        if (!found.has(h.id)) found.set(h.id, { ...h, queries: [] });
        // 命中的查询词必须**在预排序之前**挂到候选上 —— prelimScore 要用它衡量查询具体度。
        // 初版把这一步留到后面才做，导致那个信号永远不触发（死代码）。
        if (!found.get(h.id).queries.includes(q)) found.get(h.id).queries.push(q);
        if (!queryHits.has(h.id)) queryHits.set(h.id, []);
        if (!queryHits.get(h.id).includes(q)) queryHits.get(h.id).push(q);
      }
    } catch (e) {
      errors.push(`${q}: ${e.message}`);
    }
  }

  // ⚠️ 关键：**先按相关性预排序，再花 GitHub 额度**。
  // 初版在这里直接按 installs 排序，结果"product feasibility"的前几名全被
  // test-driven-development 这类高装量的通用 skill 占满，真正切题的 feasibility-assessor
  // （只有 153 装）被挤出了 GitHub 预算。安装量必须是**相关候选之间**的排序键，不是筛选器。
  const terms = args.intent.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  for (const c of found.values()) c.prelim = prelimScore(c, terms);

  const all = [...found.values()].sort((a, b) => b.prelim - a.prelim || b.installs - a.installs);
  console.error(
    `[discover] 查询词 ${queries.length} 个 → 候选 ${all.length} 个；` +
      `按"相关性预排序（零调用）→ 安装量"排序，前 5 名：` +
      all.slice(0, 5).map((c) => `${c.skill}(${c.installs})`).join(', ')
  );
  for (const e of errors) console.error(`[discover][warn] ${e}`);

  // —— 步骤 1.5：零成本预筛 ——
  // `installs` 是 skills.sh 免费给的。在花 GitHub 调用**之前**就能判掉不达标的，
  // 否则会拿宝贵的 core 额度去解析一批注定死于 `<10 安装量` 的长尾（实测上一轮
  // 8 个名额里有 5 个是这么烧掉的，导致真正切题的 phuryn/pm-skills 一次都没被解析）。
  // 淘汰项照样进 rejected，不悄悄消失。
  const prefiltered = [];
  const all2 = [];
  for (const c of all) {
    if (c.installs < MIN_INSTALLS) prefiltered.push({ ...c, reason: `per-skill 安装量 ${c.installs} < ${MIN_INSTALLS}（预筛，零调用）` });
    else all2.push(c);
  }
  console.error(`[prefilter] 零调用预筛：${all2.length} 个达标，${prefiltered.length} 个安装量不足已剔除（不占 GitHub 额度）`);

  // —— 步骤 2：按仓库分组，只对前 maxRepos 个仓库查 GitHub ——
  const byRepo = new Map();
  for (const c of all2) {
    const k = `${c.owner}/${c.repo}`.toLowerCase();
    if (!byRepo.has(k)) byRepo.set(k, { owner: c.owner, repo: c.repo, items: [] });
    byRepo.get(k).items.push(c);
  }
  // 仓库排序同样以**相关性**为主键：一个仓库只要有 1 个切题的 skill 就值得花 tree 调用，
  // 哪怕它其余 67 个 skill 的安装量加起来更高。
  const repos = [...byRepo.values()].sort(
    (a, b) => Math.max(...b.items.map((i) => i.prelim)) - Math.max(...a.items.map((i) => i.prelim))
  );
  const budgetRepos = Math.max(1, Math.min(args.maxRepos, core.remaining - RESERVE - args.shortlist));
  const picked = repos.slice(0, budgetRepos);
  console.error(
    `[inspect] 候选来自 ${repos.length} 个仓库；本次解析前 ${picked.length} 个（额度 ${core.remaining}，留 ${args.shortlist} 给 T1）`
  );

  const evaluated = [];
  const rejected = [...prefiltered]; // 预筛淘汰项照样展示：用户要求"不悄悄消失"

  for (const r of picked) {
    let repoInfo, tree;
    try {
      repoInfo = await getRepo(r.owner, r.repo);
    } catch (e) {
      for (const it of r.items) rejected.push({ ...it, reason: `仓库不可达: ${e.message}` });
      continue;
    }
    try {
      tree = await getTree(r.owner, r.repo);
    } catch (e) {
      for (const it of r.items) rejected.push({ ...it, reason: `trees 不可达: ${e.message}` });
      continue;
    }

    const dirs = findSkillDirs(tree);
    const lic = repoInfo.license?.spdx_id || null;

    for (const it of r.items) {
      const m = matchSkillDir(dirs, it.skill);
      const hit = m.hit;
      if (!hit) {
        rejected.push({
          ...it,
          reason: m.ambiguous
            ? `仓库内有 ${m.ambiguous.length} 个目录都像 "${it.skill}"，歧义 → 不猜：${m.ambiguous.slice(0, 3).join(', ')}`
            : '仓库全树中找不到同名 SKILL.md 目录',
        });
        continue;
      }
      const t0 = inspectTreeMetadata(tree, hit.dir);

      if (lic === null || lic === 'NOASSERTION') {
        rejected.push({ ...it, reason: `无明确 license（${lic || 'NONE'}）`, dir: hit.dir, license: lic });
        continue;
      }
      if (it.installs < 10) {
        rejected.push({ ...it, reason: `per-skill 安装量 ${it.installs} < 10`, dir: hit.dir, license: lic });
        continue;
      }
      if (t0.verdict === 'suspicious') {
        rejected.push({ ...it, reason: 'T0 元数据层命中 HIGH（符号链接）', dir: hit.dir, license: lic, findings: t0.findings });
        continue;
      }

      evaluated.push({
        ...it,
        canonicalRepo: repoInfo.full_name,
        repoUrl: repoInfo.html_url,
        pushedAt: repoInfo.pushed_at,
        license: lic,
        dir: hit.dir,
        skillMdPath: hit.skillMd,
        t0,
        fileCount: t0.fileCount,
        estCalls: t0.fileCount + 1,
        scanT0: t0.verdict,
        scan: 'metadata-ok',
        queries: queryHits.get(it.id) || [],
      });
    }
  }

  // 同一个 bug 的第二处：T1 短名单也曾按 installs 排，等于把额度继续喂给高装量的无关项。
  evaluated.sort((a, b) => b.prelim - a.prelim || b.installs - a.installs);
  const shortlist = evaluated.slice(0, args.shortlist);

  // —— 步骤 3：T1 单文件层 —— 一次抓取同时产出 summary 和 scan 结论 ——
  for (const c of shortlist) {
    try {
      const text = await getFileText(c.canonicalRepo.split('/')[0], c.canonicalRepo.split('/')[1], c.skillMdPath);
      const fm = parseFrontmatter(text);
      c.summary = fm?.data?.description || '';
      c.fmName = fm?.data?.name || '';
      c.licenseFm = fm?.data?.license || null;

      const findings = [
        ...scanText(text, { file: 'SKILL.md' }),
        ...(fm ? scanFrontmatter(fm.data, fm.body, fm.lineOf, 'SKILL.md') : []),
      ];
      c.findings = findings;
      c.scanT1 = verdictOf(findings);
      c.scan = c.scanT1 === 'clean' ? 'clean' : c.scanT1;
      c.scanSummary = summarize(findings);
    } catch (e) {
      c.scanT1 = 'error';
      c.scan = 'error';
      c.summary = `（读取 SKILL.md 失败：${e.message}）`;
      c.findings = [];
    }
  }

  // —— 步骤 4：硬门槛（依赖 T1 结果）+ 评分 ——
  const passed = [];
  for (const c of shortlist) {
    if (!c.summary) {
      rejected.push({ id: c.id, installs: c.installs, reason: 'frontmatter 无 description', dir: c.dir });
      continue;
    }
    if (!NAME_RE.test(c.fmName)) {
      rejected.push({ id: c.id, installs: c.installs, reason: `frontmatter name 不合法: ${JSON.stringify(c.fmName)}` , dir: c.dir });
      continue;
    }
    if (c.scanT1 === 'blocked') {
      rejected.push({ id: c.id, installs: c.installs, reason: 'T1 扫描命中 HIGH，已从可选集合移除', dir: c.dir, findings: c.findings });
      continue;
    }
    const terms = args.intent.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    const rel = scoreRelevance(c, terms, SYNONYMS);
    const parts = {
      relevance: rel.score,
      installs: scoreInstall(c.installs, { kind: 'per-skill' }), // ← 只有 per-skill 进得来
      activity: scoreActivity(c.pushedAt),
      source: scoreSource({ org: c.owner }),
      stars: 0,
    };
    c.matched = rel.matched;
    c.parts = parts;
    c.score = total(parts);
    passed.push(c);
  }

  // —— 输出 ——
  passed.sort((a, b) => b.score - a.score);

  if (args.json) {
    console.log(JSON.stringify({ intent: args.intent, queries, results: passed, rejected }, null, 2));
  } else {
    console.log(renderTable(passed));
    if (args.detail && passed.length) {
      console.log('\n' + '='.repeat(78));
      passed.slice(0, args.shortlist).forEach((c, i) => {
        console.log(`\n[${i + 1}] ` + renderDetail(c));
      });
    }
    if (rejected.length) {
      console.log('\n' + '='.repeat(78));
      console.log(`被淘汰 ${rejected.length} 项（同样列出，不悄悄消失）：`);
      // 按安装量降序展示：预筛淘汰可能有几百条，会把 T1 BLOCKED / NOASSERTION 这类
      // 真正有信息量的淘汰挤出视野。高安装量的淘汰项才是值得看的。
      const shown = [...rejected].sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0)).slice(0, 25);
      for (const r of shown) {
        console.log(`  - ${r.id || r.dir}  (${r.installs ?? '?'})  →  ${r.reason}`);
      }
    }
    console.log(
      `\n扫描器 v${SCANNER_VERSION} / 评分器 v${SCORER_VERSION}   权重 ${JSON.stringify(WEIGHTS)}（stars 恒为 0，不进展示）`
    );
  }

  if (!args.dryRun) {
    for (const r of rejected) appendJsonl(REJECTED_PATH, { at: new Date().toISOString(), ...r });
  }

  // —— 冲突预检：这些名字已在本地存在吗？——
  const clashes = passed.filter((c) => fs.existsSync(path.join(SKILLS_DIR, c.fmName)));
  if (clashes.length) {
    console.log('\n注意：以下名字在 ~/.claude/skills/ 下已存在，安装前需走冲突闸门：');
    for (const c of clashes) {
      const d = path.join(SKILLS_DIR, c.fmName);
      const isGstack = fs.existsSync(path.join(d, GSTACK_MARKER));
      const isOurs = fs.existsSync(path.join(d, OWNED_MARKER));
      console.log(`  - ${c.fmName}  ${isGstack ? '【gstack 所有 → 拒绝覆盖】' : isOurs ? '【本工具装过 → 可更新】' : '【来历不明 → 需显式确认】'}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});

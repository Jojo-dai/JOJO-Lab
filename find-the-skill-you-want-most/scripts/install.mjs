#!/usr/bin/env node
// 安装器：调用官方 `skills` CLI（github.com/vercel-labs/skills，MIT）落盘，然后自校验 + 写溯源记录。
//
// 为什么走 npx 而不是自己逐文件下：
//   contents API 是**一个文件一次调用**、匿名只有 60 次/小时，装一个 83 文件的 skill 就爆额度。
//   CLI 走的是 git clone，不消耗 API 额度。代价是某些网络下 clone 需要代理。
//
// 代理**不硬编码**，从环境变量读（见下方 PROXY）。挂代理的方式是用
// GIT_CONFIG_COUNT/KEY/VALUE 环境变量传一次性的 git 配置，**不改全局 git config**。
// 没有代理时完全不设这些变量 —— 直连能通的网络不该被强加代理。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  SKILLS_DIR,
  STATE_DIR,
  RECORDS_DIR,
  INSTALLED_PATH,
  OWNED_MARKER,
  GSTACK_MARKER,
  GSTACK_BANNER_PATTERNS,
  appendJsonl,
  readJson,
  ensureStateDirs,
} from './lib/paths.mjs';
import { scanText, verdictOf, summarize, SCANNER_VERSION } from './lib/scan.mjs';

const CLI_PKG = 'skills@1.5.25'; // 锁定版本，不用 @latest

/**
 * git 代理**只能从环境变量读，绝不硬编码**。
 *
 * `git clone github.com` 在某些网络下会超时，此时挂代理是唯一出路。但代理地址是
 * **每台机器不同的**。曾经这里写死了一个开发机上的本地代理地址，后果是：
 * 任何其他人跑这个工具，git 流量都会被强制导向他们本机的那个端口 ——
 * 没这个代理就直接失败，有则会把流量导去意外的地方。
 *
 * 现在留空即不挂代理。优先 `FIND_SKILL_GIT_PROXY`（本工具专用，便于覆盖），
 * 其次遵循通用的 `HTTPS_PROXY` / `HTTP_PROXY` 约定（含小写变体，Unix 惯例）。
 */
const PROXY =
  process.env.FIND_SKILL_GIT_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';

function cliEnv() {
  const env = {
    ...process.env,
    // 遥测默认关闭。CLI 会把安装事件上报给 skills.sh —— 那正是"安装量"这个数据的来源，
    // 但我们不替用户做这个决定，除非显式指定。
    ...(process.env.FIND_SKILL_TELEMETRY === '1' ? {} : { DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' }),
  };
  if (PROXY) {
    // 只作用于本次调用，不写全局 git config
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'http.proxy';
    env.GIT_CONFIG_VALUE_0 = PROXY;
    env.GIT_CONFIG_KEY_1 = 'https.proxy';
    env.GIT_CONFIG_VALUE_1 = PROXY;
  }
  return env;
}

function runCli(args, { quiet = true } = {}) {
  const isWin = process.platform === 'win32';
  const cmdline = `npx --yes ${CLI_PKG} ${args.map(shellQuote).join(' ')}`;
  let r;
  if (isWin) {
    // Windows 上 npx 是 .cmd 批处理，Node 的 spawn 无法直接执行它 —— 报的是 EINVAL 而非
    // ENOENT，所以"直连失败再退 shell"的写法永远退不到。必须一开始就走 shell。
    r = spawnSync(cmdline, { env: cliEnv(), encoding: 'utf8', shell: true, timeout: 300000 });
  } else {
    r = spawnSync('npx', ['--yes', CLI_PKG, ...args], { env: cliEnv(), encoding: 'utf8', timeout: 300000 });
    if (r.error && r.error.code === 'ENOENT') {
      r = spawnSync(cmdline, { env: cliEnv(), encoding: 'utf8', shell: true, timeout: 300000 });
    }
  }
  if (!quiet && r.stdout) process.stderr.write(r.stdout);
  return r;
}

function shellQuote(s) {
  return /^[A-Za-z0-9._/@:-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`;
}

/**
 * HIGH 命中时的逃生口判定。
 *
 * 抽成纯函数是为了**可测** —— 这段逻辑原本只能靠真的下载一个带高危内容的 skill
 * 才能触达，等于线上代码没有测试覆盖。安全分支尤其不能这样。
 *
 * 规则：`--confirm` 的值必须与 skill 名**逐字相同**。不给、给错、给空，一律不放行。
 * 严格相等而非大小写不敏感/去空格 —— 确认动作的意义就在于"你准确知道自己在装什么"。
 *
 * @returns {boolean} 是否允许覆盖 HIGH 判定并保留
 */
export function overrideAllowed(confirmValue, skillName) {
  if (typeof confirmValue !== 'string' || typeof skillName !== 'string') return false;
  if (confirmValue === '' || skillName === '') return false;
  return confirmValue === skillName;
}

/** 冲突闸门 —— 与 gstack 同源的"所有权"哲学：不碰任何无法证明是自己装的东西。 */
export function conflictCheck(skillName) {
  const dest = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(dest)) return { ok: true, kind: 'new' };

  if (fs.existsSync(path.join(dest, GSTACK_MARKER))) {
    return { ok: false, kind: 'gstack', dest, msg: '该目录带 .gstack-owned 标记，属 gstack。覆盖会破坏 gstack，且 gstack 下次 ./setup 会反过来删掉我们的副本。' };
  }
  try {
    const st = fs.lstatSync(path.join(dest, 'SKILL.md'));
    if (st.isSymbolicLink()) return { ok: false, kind: 'symlink', dest, msg: 'SKILL.md 是符号链接，拒绝跟随。' };
  } catch {
    /* 没有 SKILL.md，继续判 */
  }

  // 目录内的标记是**最可靠**的所有权证据 —— 它跟着目录走，不依赖 records/ 还在不在，
  // 也不依赖 state 目录路径没变过。初版只查 records/<name>.json，结果把本工具
  // 早先装的 skill（有 installed.jsonl 记录、但当时没写目录标记）误判成"来历不明"，
  // 更新被自己挡住。两道都查：标记优先，记录兜底。
  if (fs.existsSync(path.join(dest, OWNED_MARKER))) {
    return { ok: true, kind: 'ours', dest, msg: '目录带本工具标记，按更新处理。' };
  }
  const rec = path.join(RECORDS_DIR, skillName + '.json');
  if (fs.existsSync(rec)) return { ok: true, kind: 'ours', dest, msg: '本工具装过（有记录），按更新处理。' };

  return { ok: false, kind: 'unknown', dest, msg: '目录已存在但来历不明，未经显式确认不覆盖。可加前缀另装。' };
}

function hashDir(dir) {
  const files = [];
  const walk = (d, base = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === OWNED_MARKER) continue;
      const full = path.join(d, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        const buf = fs.readFileSync(full);
        files.push({ path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
      }
    }
  };
  walk(dir);
  const overall = crypto
    .createHash('sha256')
    .update(files.map((f) => f.sha256).join(''))
    .digest('hex');
  return { files, overall };
}

/** T2 全目录层：扫描已落盘的实际字节。导出以便用本地夹具测试（不碰真实恶意仓库）。 */
export function scanDir(dir) {
  const codeExt = /\.(sh|bash|ps1|py|js|mjs|cjs|ts|rb|go|rs|pl|php)$/i;
  const findings = [];
  const skipped = [];
  let scanned = 0;

  const walk = (d, base = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isSymbolicLink()) {
        findings.push({ severity: 'HIGH', rule: 'symlink', file: rel, line: null, snippet: '(symlink)', why: '安装产物里出现符号链接，绝不跟随' });
        continue;
      }
      if (e.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (/\.(md|markdown)$/i.test(e.name) || codeExt.test(e.name) || (e.name.endsWith('.json') && /hooks/i.test(fs.readFileSync(full, 'utf8').slice(0, 4000)))) {
        try {
          findings.push(...scanText(fs.readFileSync(full, 'utf8'), { file: rel }));
          scanned++;
        } catch {
          skipped.push(rel);
        }
      } else if (!/\.(txt|ya?ml|toml)$/i.test(e.name)) {
        skipped.push(rel);
      }
    }
  };
  walk(dir);
  return { findings, scanned, skipped, verdict: verdictOf(findings) };
}

async function main() {
  const argv = process.argv.slice(2);

  // 参数解析要区分"开关"和"带值的选项" —— `--confirm <name>` 的取值不能再被当成
  // 位置参数，否则 `install.mjs a/b c --confirm c` 里那个 c 会混进 [repoArg, skillArg]。
  const KNOWN = new Set(['--yes', '--force-unknown', '--confirm', '--prefix']);
  const TAKES_VALUE = new Set(['--confirm', '--prefix']);
  const flags = new Set();
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    if (!KNOWN.has(a)) {
      console.error(`未知参数: ${a}`);
      console.error(`可用: ${[...KNOWN].join(' ')}`);
      console.error('注意：本命令不支持 --dry-run —— 它总是真的安装。预演请用 find.mjs --dry-run。');
      process.exit(2);
    }
    flags.add(a);
    if (TAKES_VALUE.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} 需要一个值。`);
        process.exit(2);
      }
      opts[a] = v;
    }
  }
  const [repoArg, skillArg] = pos;

  if (!repoArg || !skillArg) {
    console.error('用法: node install.mjs <owner/repo> <skill-name> [--yes] [--prefix <p>] [--force-unknown]');
    console.error('      node install.mjs <owner/repo> <skill-name> --confirm <skill-name>   # 仅在 T2 扫出 HIGH 时需要');
    process.exit(2);
  }
  ensureStateDirs();

  const [owner, repo] = repoArg.split('/');
  const skill = skillArg;

  // —— 冲突闸门 ——
  const cc = conflictCheck(skill);
  if (!cc.ok && !flags.has('--force-unknown')) {
    if (cc.kind === 'ours') {
      /* 已处理 */
    } else {
      console.error(`[拒绝] ${cc.msg}`);
      console.error(`  目录: ${cc.dest}`);
      if (cc.kind === 'gstack') console.error(`  备选: 换一个名字安装（需手工改 frontmatter 的 name）`);
      if (flags.has('--prefix')) {
        const pref = opts['--prefix'] || 'x';
        console.error(`  提示: 你已指定 --prefix ${pref}，但 CLI 不支持改名安装，需先落盘再改名。`);
      }
      process.exit(4);
    }
  } else if (cc.kind === 'ours') {
    console.error(`[更新] ${skill} 是本工具装过的，按更新处理。`);
  }

  // —— 调官方 CLI 安装 ——
  console.error(`[install] npx ${CLI_PKG} add ${owner}/${repo} -s ${skill} -g --copy -y`);
  const r = runCli(['add', `${owner}/${repo}`, '-s', skill, '-g', '--copy', '-y']);
  if (r.status !== 0) {
    console.error(`[失败] CLI 退出码 ${r.status}`);
    if (r.stderr) console.error(r.stderr.slice(-2000));
    process.exit(r.status || 1);
  }

  // —— 定位落盘位置 ——
  const candidates = [path.join(SKILLS_DIR, skill), path.join(SKILLS_DIR, skill.toLowerCase())];
  const dest = candidates.find((d) => fs.existsSync(path.join(d, 'SKILL.md')));
  if (!dest) {
    console.error(`[失败] CLI 报成功，但在 ${path.join(SKILLS_DIR, skill)} 下找不到 SKILL.md。`);
    console.error('        CLI 可能装到了别的位置，请手工确认后再决定是否重试。');
    process.exit(5);
  }

  // —— gstack 横幅哨兵：我们的产物里绝不允许出现 gstack 的生成横幅 ——
  const md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
  for (const pat of GSTACK_BANNER_PATTERNS) {
    if (pat.test(md)) {
      console.error(`[中止] SKILL.md 含 gstack 生成横幅（${pat}）—— 会被 gstack 认作自己的并覆盖/搬走。`);
      process.exit(6);
    }
  }

  // —— T2 全目录扫描 ——
  const t2 = scanDir(dest);
  let overridden = false; // 是否被 --confirm 强行覆盖了 HIGH 判定（须写进溯源）
  if (t2.verdict === 'blocked') {
    console.error('\n[T2 命中 HIGH — 已落盘但尚未被 Claude 加载，现立即移除]');
    for (const f of t2.findings.filter((x) => x.severity === 'HIGH')) {
      console.error(`  ${f.file}:${f.line ?? '-'}  [${f.rule}]  ${f.why}`);
      if (f.snippet) console.error(`      ${f.snippet}`);
    }
    console.error('\n选项：(a) 放弃（默认）；(b) 强行保留 —— 需把 skill 全名原样传给 --confirm。');
    console.error(`     用法: --confirm ${skill}`);
    // 逃生口要求**名字逐字匹配**。初版只检查 `--i-understand` 这个布尔开关，
    // 于是提示语承诺的"逐字输入全名确认"是句空话 —— 加个开关就能装高危内容。
    // 现在名字对不上就一律删除：想让这次覆盖发生，你必须明确知道自己在装什么。
    const confirmed = opts['--confirm'];
    if (!overrideAllowed(confirmed, skill)) {
      if (confirmed !== undefined) {
        console.error(`\n  --confirm 的值与 skill 名不符：`);
        console.error(`    你给的    ${JSON.stringify(confirmed)}`);
        console.error(`    实际是    ${JSON.stringify(skill)}`);
      }
      runCli(['remove', '-g', '-s', skill, '-y']);
      console.error('  已移除。');
      process.exit(7);
    }
    overridden = true;
    console.error(`  --confirm ${skill} 名字匹配，保留并留痕。`);
  }

  // —— 写溯源标记 + 记录 ——
  const { files, overall } = hashDir(dest);
  const now = new Date().toISOString();
  const record = {
    schema: 'find-skill/record/v1',
    skill,
    // 覆盖发生时状态就不再是干净的 'installed' —— 否则"永久留痕"无从谈起：
    // 记录里只有 installed、扫描只是 t2Verdict:blocked，没人看得出这是被人工放行的。
    status: overridden ? 'installed-blocked-overridden' : 'installed',
    source: { repo: `${owner}/${repo}`, repoUrl: `https://github.com/${owner}/${repo}`, subpath: skill },
    install: { method: `npx ${CLI_PKG} add`, at: now, dest },
    scan: {
      scanner: SCANNER_VERSION,
      t2Verdict: t2.verdict,
      scannedFiles: t2.scanned,
      skipped: t2.skipped,
      findings: t2.findings,
      summary: summarize(t2.findings),
      ...(overridden ? { overriddenByUser: true, overrideAt: now, overrideNote: 'T2 判 HIGH，用户以 --confirm <skill> 逐字确认后强行安装' } : {}),
    },
    integrity: { contentSha256: overall, marker: OWNED_MARKER },
    files,
    history: [{ event: overridden ? 'install-blocked-overridden-by-user' : 'install', at: now }],
  };

  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RECORDS_DIR, skill + '.json'), JSON.stringify(record, null, 2), 'utf8');
  appendJsonl(INSTALLED_PATH, {
    at: now,
    event: overridden ? 'install-blocked-overridden-by-user' : 'install',
    skill,
    repo: record.source.repo,
    verdict: t2.verdict,
    files: files.length,
  });

  fs.writeFileSync(
    path.join(dest, OWNED_MARKER),
    JSON.stringify({ by: 'find-the-skill-you-want-most', repo: record.source.repo, at: now, record: path.join(RECORDS_DIR, skill + '.json') }, null, 2),
    'utf8'
  );

  console.log(`已安装: ${skill}`);
  console.log(`  位置      ${dest}`);
  console.log(`  文件      ${files.length} 个，共 ${files.reduce((a, f) => a + f.bytes, 0)} 字节`);
  console.log(`  内容哈希  ${overall.slice(0, 16)}…`);
  console.log(`  T2 扫描   ${t2.verdict}（扫 ${t2.scanned} 个文件${t2.skipped.length ? `，跳过 ${t2.skipped.length} 个二进制/非文本` : ''}）`);
  if (overridden) console.log(`  ⚠ 覆盖    用户以 --confirm 强行放行了 HIGH 判定，已记入溯源记录`);
  console.log(`  记录      ${path.join(RECORDS_DIR, skill + '.json')}`);
  console.log(`\n重启 Claude Code 后即可作为 /${skill} 调用。`);
}

// 只在**直接执行**时跑 main —— 被 import 时保持静默，否则本模块无法被 selftest 引用
// （一 import 就真的去装东西，安全分支也就永远测不到）。
const isDirectRun = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error('FATAL:', e.stack || e.message);
    process.exit(1);
  });
}

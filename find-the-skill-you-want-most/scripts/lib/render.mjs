// 候选表渲染。
//
// 刻意**不输出 stars 列**，也不展开各维度权重占比 —— 权重只写在 SCORING.md 里供审计。
// 表里出现的一律是可直接核对的硬事实：安装量、license、最后提交、扫描结论、来源。

import { oneLine } from './frontmatter.mjs';

const SCAN_BADGE = {
  clean: 'clean',
  'metadata-ok': 'meta-ok',
  suspicious: 'SUSPICIOUS',
  blocked: 'BLOCKED',
  pending: 'pending',
};

function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t.slice(0, n - 1) + '…' : t + ' '.repeat(n - t.length);
}

function padL(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t : ' '.repeat(n - t.length) + t;
}

export function renderTable(rows, { title = '候选 skill' } = {}) {
  if (!rows.length) return `（${title}：无）`;

  const cols = [
    { k: '#', w: 3, r: true },
    { k: 'skill', w: 26 },
    { k: 'installs', w: 10, r: true },
    { k: 'summary', w: 46 },
    { k: 'lic', w: 12 },
    { k: 'pushed', w: 8 },
    // 12 而不是 10：'SUSPICIOUS' 正好 10 字符，宽度相等时 pad() 会截成 'SUSPICIOU…'。
    { k: 'scan', w: 12 },
    { k: 'score', w: 6, r: true },
  ];

  const head = cols.map((c) => (c.r ? padL(c.k, c.w) : pad(c.k, c.w))).join('  ');
  const sep = cols.map((c) => '-'.repeat(c.w)).join('  ');
  const lines = [head, sep];

  rows.forEach((r, i) => {
    const cells = [
      padL(String(i + 1), 3),
      pad(r.skill, 26),
      padL(fmtNum(r.installs), 10),
      pad(oneLine(r.summary, 44), 46),
      pad(r.license || '—', 12),
      pad((r.pushedAt || '—').slice(0, 7), 8),
      pad(SCAN_BADGE[r.scan] || r.scan || '?', 12),
      padL(r.score ?? '—', 6),
    ];
    lines.push(cells.join('  '));
  });

  const src = rows.map((r, i) => `  ${padL(String(i + 1), 3)}  ${r.source_path || r.source || ''}`);
  return `${title}\n\n${lines.join('\n')}\n\n来源路径：\n${src.join('\n')}`;
}

export function renderDetail(r) {
  const out = [];
  out.push(`${r.skill}   ${fmtNum(r.installs)} installs   ${r.license || '无 license'}`);
  out.push(`  来源        ${r.source_path || r.source}`);
  out.push(`  仓库        ${r.repo_url || '-'}`);
  out.push(`  最后提交    ${r.pushedAt || '-'}`);
  if (r.matched?.length) {
    const m = r.matched.slice(0, 6).map((x) => `${x.term}@${x.field}`);
    out.push(`  命中        ${m.join(', ')}`);
  }
  out.push(`  扫描        T0=${r.scanT0 || '?'}  T1=${r.scanT1 || '?'}  文件数=${r.fileCount ?? '?'}`);
  out.push(`  安装成本    est_calls=${r.estCalls ?? '?'}`);
  if (r.findings?.length) {
    for (const f of r.findings.slice(0, 10)) {
      out.push(`    [${f.severity}] ${f.rule} ${f.file}:${f.line ?? '-'} — ${f.why}`);
      if (f.snippet) out.push(`        ${f.snippet}`);
    }
  }
  return out.join('\n');
}

export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/** 强制自检：渲染产物里绝不允许出现 stars 列。 */
export function assertNoStars(text) {
  const bad = /(^|\s)(★|stars?)(\s|$)/i.test(text);
  if (bad) throw new Error('渲染产物里出现了 stars —— 违反权重恒为 0 的约束');
  return true;
}

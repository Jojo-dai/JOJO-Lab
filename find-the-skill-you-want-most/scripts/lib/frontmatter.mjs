// 极简 YAML frontmatter 解析器。零依赖。
// 只覆盖 skill frontmatter 实际用得到的子集：标量、引号、行内数组、块标量（| 与 >）、CRLF。
// 解析器的每一个判断都要能追溯到具体行 —— 因为你要求"匹配器不能是黑箱"。

export function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  const src = text.replace(/^﻿/, ''); // BOM
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;

  const rawFm = m[1];
  const body = src.slice(m[0].length);
  const lines = rawFm.split(/\r?\n/);
  const data = {};
  const lineOf = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    let val = kv[2];
    lineOf[key] = i + 2; // +1 行号从1起，+1 跳过开头的 ---

    // 块标量：key: |  或  key: >
    if (/^[|>][-+]?\d*[ \t]*$/.test(val.trim())) {
      const fold = val.trim()[0] === '>';
      const block = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        block.push(lines[j].replace(/^\s{2}/, ''));
        j++;
      }
      i = j - 1;
      data[key] = fold ? block.join(' ').trim() : block.join('\n').trim();
      continue;
    }

    val = val.trim();

    // YAML 块列表：
    //   allowed-tools:
    //     - Bash
    //     - Read
    // 这是**最常见**的写法（gstack 全套、610 个 skill 里 165 个用块列表写 triggers）。
    // 初版漏了这条分支，空值一律返回 ""，导致 scanFrontmatter 的 broad-tools-plus-io
    // 规则在这类 frontmatter 上**静默失效** —— 一个漏报的安全控制。
    // selftest 当时只喂了行内数组写法，所以 49/49 全绿却没照出这个洞。
    if (val === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^\s*-\s+/, '').trim()));
        j++;
      }
      if (items.length) {
        i = j - 1;
        data[key] = items;
        continue;
      }
      // 不是列表（可能是嵌套映射，如 hooks:\n  PostToolUse: xxx）。
      // 保留空串：hooks 的检测靠 hasOwnProperty，不依赖值，所以仍然安全。
      data[key] = '';
      continue;
    }

    // 行内数组 [a, b, c]
    if (/^\[.*\]$/.test(val)) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '');
      continue;
    }
    data[key] = unquote(val);
  }

  return { data, body, raw: rawFm, lineOf };
}

function unquote(s) {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      const inner = s.slice(1, -1);
      return a === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
    }
  }
  return s;
}

/** 取描述首句并压平空白 —— 沿用 gstack llms.txt 的 oneLine() 约定，与你现有 skill 展示风格一致。 */
export function oneLine(desc, maxLen = 96) {
  let s = String(desc || '')
    .replace(/\s+/g, ' ')
    .trim();
  const stop = s.search(/[.。!?！？]\s/);
  if (stop > 0 && stop < maxLen * 2) s = s.slice(0, stop + 1);
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

export const NAME_RE = /^[a-z][a-z0-9-]*$/;

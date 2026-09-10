// 路径与常量。所有脚本共用——绝不在别处硬编码路径。
// Windows 注意：一律用 path.join，绝不用字符串拼 '/'，避免 C:\ 里的反斜杠被 shell 当转义。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const HOME = os.homedir();

export const SKILL_NAME = 'find-the-skill-you-want-most';

// 只读产物（可安全重装）
export const SKILL_ROOT = path.join(HOME, '.claude', 'skills', SKILL_NAME);

// 可变状态，刻意放在 skills 目录之外：Claude Code 只扫描 ~/.claude/skills/，
// 放外面既不污染技能树，也让 skill 本身能干净重装而历史不丢。
export const STATE_DIR = path.join(HOME, '.claude', 'find-skill');

export const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
export const CACHE_DIR = path.join(STATE_DIR, 'cache');
export const BLOB_DIR = path.join(CACHE_DIR, 'blobs');
export const META_DIR = path.join(CACHE_DIR, 'meta');
export const RECORDS_DIR = path.join(STATE_DIR, 'records');
export const STAGING_DIR = path.join(STATE_DIR, 'staging');

export const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
export const EGRESS_PATH = path.join(STATE_DIR, 'egress.jsonl');
export const INSTALLED_PATH = path.join(STATE_DIR, 'installed.jsonl');
export const REJECTED_PATH = path.join(STATE_DIR, 'rejected.jsonl');
export const INSTALLED_MD = path.join(STATE_DIR, 'INSTALLED.md');

// 溯源标记。绝不写 .gstack-owned —— gstack 见到该标记会认作自己的并删掉整个目录。
export const OWNED_MARKER = '.find-skill-owned';
export const GSTACK_MARKER = '.gstack-owned';

// 已知会被 gstack 的弱证明逻辑认领的横幅文字，本 skill 的产物里绝不允许出现
export const GSTACK_BANNER_PATTERNS = [
  /AUTO-GENERATED from .*\.tmpl/i,
  /Regenerate:\s*bun run gen:skill-docs/i,
];

export const HOSTS = {
  SKILLS_SH: 'skills.sh',
  GITHUB_API: 'api.github.com',
};

// 缓存 TTL（毫秒）
export const TTL = {
  skillsSh: 12 * 60 * 60 * 1000,
  githubRepo: 24 * 60 * 60 * 1000,
  githubTree: 7 * 24 * 60 * 60 * 1000,
  githubContents: 30 * 24 * 60 * 60 * 1000,
  rateLimit: 60 * 1000,
};

export function ensureStateDirs() {
  for (const d of [STATE_DIR, CACHE_DIR, BLOB_DIR, META_DIR, RECORDS_DIR, STAGING_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

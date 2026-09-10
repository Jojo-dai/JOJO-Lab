// 唯一网络出口。所有出站请求都必须经这里 —— 便于记账、缓存、重试。
//
// 传输层实测结论（2026-09-10，本机）：
//   - Node 24 的 fetch **直连** api.github.com 与 skills.sh 均 200，且不读 HTTP_PROXY/HTTPS_PROXY
//     （Node 的 fetch 默认忽略代理环境变量，除非显式传 dispatcher）
//   - curl 挂上本地代理打 api.github.com 反而 403，所以**不要**为了"更稳"切回 curl
// 因此这里不需要 --noproxy 之类的开关：纯 Node 就是直连。
//
// 注意这与 install.mjs 不同：那边走 `git clone`，某些网络下**必须**挂代理才能通，
// 所以那边从环境变量读代理而这里不读。两条路径的传输层需求本来就不一样。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BLOB_DIR, META_DIR, EGRESS_PATH, appendJsonl, ensureStateDirs } from './paths.mjs';

const UA = 'find-the-skill-you-want-most/0.1 (+https://github.com/vercel-labs/skills)';

function keyOf(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function metaPath(url) {
  return path.join(META_DIR, keyOf(url) + '.json');
}

function blobPath(sha) {
  return path.join(BLOB_DIR, sha);
}

/**
 * 带缓存与记账的 GET。
 * @param {string} url
 * @param {{ttl?:number, accept?:string, throttleMs?:number, retries?:number}} opts
 * @returns {Promise<{status:number, text:string, fromCache:boolean, bytes:number}>}
 */
export async function httpGet(url, opts = {}) {
  ensureStateDirs();
  const { ttl = 0, accept = null, throttleMs = 0, retries = 2 } = opts;
  const u = new URL(url);
  const mp = metaPath(url);
  const now = Date.now();

  // —— 缓存命中判定（TTL 内直接返回，0 出站、0 额度）——
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch {
    meta = null;
  }
  if (meta && ttl > 0 && now - meta.fetchedAt < ttl && meta.blobSha) {
    const bp = blobPath(meta.blobSha);
    if (fs.existsSync(bp)) {
      const text = fs.readFileSync(bp, 'utf8');
      logEgress(url, meta.status, text.length, 'hit');
      return { status: meta.status, text, fromCache: true, bytes: text.length };
    }
  }

  if (throttleMs > 0) await sleep(throttleMs);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 记账发生在**发送前**：即使请求失败也留痕
      logEgress(url, null, 0, 'miss');

      const headers = { 'user-agent': UA };
      if (accept) headers.accept = accept;
      if (meta?.etag) headers['if-none-match'] = meta.etag;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);

      // 304：内容未变，刷新 TTL 即可，**不计额度**
      if (res.status === 304 && meta?.blobSha) {
        const bp = blobPath(meta.blobSha);
        if (fs.existsSync(bp)) {
          const text = fs.readFileSync(bp, 'utf8');
          meta.fetchedAt = now;
          fs.writeFileSync(mp, JSON.stringify(meta), 'utf8');
          logEgress(url, 304, text.length, 'revalidated');
          return { status: meta.status, text, fromCache: true, bytes: text.length };
        }
      }

      const text = await res.text();

      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }

      // 成功（或 4xx —— 4xx 也要缓存，避免反复撞同一面墙烧额度）
      if (res.status < 500) {
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        fs.writeFileSync(blobPath(sha), text, 'utf8');
        const newMeta = {
          url,
          status: res.status,
          etag: res.headers.get('etag') || null,
          fetchedAt: now,
          blobSha: sha,
        };
        fs.writeFileSync(mp, JSON.stringify(newMeta), 'utf8');
        logEgress(url, res.status, text.length, 'fetched');
        return { status: res.status, text, fromCache: false, bytes: text.length };
      }

      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr ?? new Error('request failed');
}

export async function httpGetJson(url, opts = {}) {
  const r = await httpGet(url, { ...opts, accept: opts.accept ?? 'application/json' });
  if (r.status >= 400) {
    const err = new Error(`HTTP ${r.status} for ${url}`);
    err.status = r.status;
    err.body = r.text;
    throw err;
  }
  return { ...JSON.parse(r.text), __fromCache: r.fromCache };
}

function logEgress(url, status, bytes, cache) {
  try {
    const u = new URL(url);
    appendJsonl(EGRESS_PATH, {
      at: new Date().toISOString(),
      host: u.host,
      path: u.pathname + u.search,
      status,
      bytes,
      cache,
    });
  } catch {
    /* 记账失败绝不影响主流程 */
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

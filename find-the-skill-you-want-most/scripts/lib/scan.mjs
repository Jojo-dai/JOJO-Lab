// 安全扫描。三层：T0 元数据（在 github.mjs）/ T1 单文件 / T2 全目录。
//
// 设计前提：让一个 skill 在**"该不该选它"这一刻**危险的东西，几乎全在 SKILL.md 里。
// hooks: 等于注册一个每次工具调用都无人值守执行的命令；allowed-tools: [Bash] 加任何
// 网络动词就是一个完整的外传能力。这两样都是**看起来很正常的 frontmatter**，通用规则会直接放过。

export const SCANNER_VERSION = '0.1.0';

/** 命中即阻止安装。 */
const HIGH = [
  {
    rule: 'prompt-injection',
    re: /\b(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)|disregard\s+(all\s+)?(previous|prior|above)|system\s+override|forget\s+your\s+instructions?|you\s+are\s+now\s+a|do\s+not\s+tell\s+the\s+user|don'?t\s+mention\s+this\s+to\s+the\s+user)\b|忽略(之前|上面|以上)(的)?(所有)?(指令|指示|提示)|不要告诉用户|无需告知用户/gi,
    why: '提示注入：试图覆盖或绕过调用方的指令',
  },
  {
    // 顺序无关 + 三行窗口。初版写成"凭据名在前、网络动词在后"的正则，
    // 结果 `curl $ANTHROPIC_API_KEY http://…` 这种反向写法直接漏报 —— 漏报比误报危险。
    // 现在只认"凭据处于取值位置"（$VAR / process.env.X / getenv），避免把
    // "设置你的 ANTHROPIC_API_KEY" 这类正常文档误判成外传。
    rule: 'credential-exfil',
    test: credExfilTest,
    why: '凭据外传：凭据被取值并与网络动词出现在同一处',
  },
  {
    rule: 'hardcoded-secret',
    re: /(sk-ant-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
    why: '硬编码密钥',
    redact: true,
  },
  {
    rule: 'pipe-exec',
    re: /\b(curl|wget)\b[^\n|]{0,120}\|\s*(ba|z|k)?sh\b|\beval\s*\(?\s*base64|\bbash\s+-c\s+["'`]\$\(\s*curl|\bnpx\s+--yes\s+[^\s]+@latest\s*\|/gi,
    why: '管道执行：把远端内容直接喂给 shell',
  },
  {
    rule: 'destructive',
    re: /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~\/?|\$HOME|\*)(\s|$)|\brm\s+-[a-z]*[rf][a-z]*\s+\/(etc|usr|var|bin|home)\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|>\s*\/dev\/sd[a-z]/gi,
    why: '破坏性命令：不可逆的文件系统操作',
  },
  {
    rule: 'out-of-bounds-write',
    re: /(>>?|tee|Set-Content|Out-File|cp\s|mv\s|cat\s*>\s*)[^\n]{0,60}(\.ssh\/|\.aws\/|\.gnupg\/|\.claude\/settings\.json|\.gitconfig|\.netrc|\.npmrc|CLAUDE\.md)/gi,
    why: '越界写入：改写凭据目录或 Claude 自身配置',
  },
];

/** 展示 + 显式确认后可装。 */
const MEDIUM = [
  { rule: 'network-verb', re: /\b(curl|wget|Invoke-WebRequest|requests\.get|requests\.post|fetch\(|axios\.|http\.get)\b/gi, why: '存在网络访问' },
  { rule: 'env-access', re: /\b(process\.env|os\.environ|getenv\(|\$env:)/gi, why: '读取环境变量（可能含凭据）' },
  { rule: 'dynamic-exec', re: /\b(eval|exec|Function\(|subprocess\.|child_process|os\.system|popen|spawnSync|execSync)\b/g, why: '动态执行代码' },
  { rule: 'unpinned-install', re: /\b(npx\s+(?!-)[^\s@]+(?!@[\d.]+)\b|pip\s+install\s+(?!-r)[^\s=<>]+(?![=<>]=?))|npm\s+i(nstall)?\s+(?!-)[^\s@]+(?!@[\d.]+)/g, why: '安装未锁定版本的外部包' },
];

/** 仅展示。 */
const LOW = [
  { rule: 'plaintext-http', re: /http:\/\/(?!localhost|127\.0\.0\.1)/g, why: '明文 HTTP' },
  { rule: 'base64-usage', re: /\bbase64\b/gi, why: '使用 base64（常用于混淆）' },
];

const MAX_HITS_PER_RULE = 5;
const WINDOW = 3; // 三行窗口

// 凭据必须处于"取值位置"才算外传嫌疑：$VAR / ${VAR} / process.env.X / os.environ / getenv()
const CRED_IN_VALUE_POSITION =
  /(\$\{?[A-Za-z_][A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\}?|process\.env\.[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)|os\.environ(\.get)?\(?["']?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)|getenv\(["'][A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)|printenv\s+[A-Za-z0-9_]*(KEY|TOKEN|SECRET))/i;

const NET_VERB =
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|requests\.(get|post|put)|urllib|http\.client|axios|got\(|node-fetch|fetch\(|netcat|\bnc\b|\bscp\b|\bsftp\b|\bftp\b)/i;

function credExfilTest(line, lineNo, allLines) {
  const windowText = allLines.slice(Math.max(0, lineNo - WINDOW + 1), lineNo + 1).join(' ');
  if (!CRED_IN_VALUE_POSITION.test(windowText)) return null;
  if (!NET_VERB.test(windowText)) return null;
  return line.trim();
}

/**
 * T1/T2 通用文本扫描。
 * @param {string} text
 * @param {{file?:string, kind?:'md'|'code'|'json'}} opts
 */
export function scanText(text, { file = '<unknown>', kind = 'md' } = {}) {
  const out = [];
  for (const [rules, sev] of [
    [HIGH, 'HIGH'],
    [MEDIUM, 'MEDIUM'],
    [LOW, 'LOW'],
  ]) {
    const lines = String(text).split(/\r?\n/);
    for (const r of rules) {
      let hits = 0;
      for (let i = 0; i < lines.length && hits < MAX_HITS_PER_RULE; i++) {
        let snippet = null;
        let redacted = false;

        if (typeof r.test === 'function') {
          // 自定义判定（可跨行取窗口），返回命中片段或 null
          const got = r.test(lines[i], i, lines);
          if (!got) continue;
          snippet = got;
        } else {
          const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
          const m = re.exec(lines[i]);
          if (!m) continue;
          snippet = m[0];
          redacted = !!r.redact;
        }

        hits++;
        out.push({
          severity: sev,
          rule: r.rule,
          file,
          line: i + 1,
          snippet: redacted ? redact(snippet) : clip(snippet, 110),
          why: r.why,
        });
      }
    }
  }
  return out;
}

/**
 * frontmatter 专有的两条规则 —— 本方案相对通用扫描器的核心增量。
 * @param {object} fmData parseFrontmatter().data
 * @param {string} bodyText 去掉 frontmatter 后的正文
 * @param {object} lineOf  parseFrontmatter().lineOf（用于给出准确行号）
 */
export function scanFrontmatter(fmData, bodyText, lineOf = {}, file = 'SKILL.md') {
  const out = [];

  // 规则 1：hooks 声明。等于注册一个每次工具调用都会无人值守执行的命令。
  if (fmData && Object.prototype.hasOwnProperty.call(fmData, 'hooks')) {
    out.push({
      severity: 'HIGH',
      rule: 'frontmatter-hooks',
      file,
      line: lineOf.hooks ?? null,
      snippet: clip(String(fmData.hooks), 110),
      why: 'frontmatter 声明了 hooks：等于注册一个每次工具调用都无人值守执行的命令',
    });
  }

  // 规则 2：过宽的 allowed-tools + 正文里的网络/写入能力 = 完整外传链
  const at = fmData?.['allowed-tools'];
  if (at !== undefined) {
    const list = Array.isArray(at) ? at : String(at).split(/[,\s]+/);
    const broad = list.filter((t) => /^(\*|bash|write|edit|notebookedit|webfetch|websearch)$/i.test(String(t).trim()));
    if (broad.length) {
      // 先剥掉**文件描述符重定向**再判"写入"。`2>&1` / `2>/dev/null` / `&>/dev/null`
      // 是 fd 操作，不是文件写入，却几乎每个 Bash skill 都有 ——
      // 初版正则 `>>?\s*\S` 会把它们全判成写入，于是实测 gstack 的 /browse（完全正常的
      // skill）被判 blocked。把几乎所有正常 skill 都拦下的控制等于没有控制，用户只会学会无视它。
      const noFd = String(bodyText)
        .replace(/\d*>>?\s*&\s*\d+/g, ' ')
        .replace(/\d*>>?\s*\/dev\/null/g, ' ')
        .replace(/\d*>&\s*\d+/g, ' ');
      const hasNetOrWrite = /\b(curl|wget|fetch|http|requests\.|axios|nc\s|scp\s|ssh\s)\b|>>?\s*[^\s&|]|\btee\b/i.test(noFd);
      out.push({
        // 降级为 MEDIUM。理由：`Bash` + 任何网络/写入动词是**绝大多数正常 skill** 的形态，
        // 单凭这一点不足以判高危。真正危险的组合已经被更精准的 HIGH 规则覆盖 ——
        // credential-exfil（读凭据 + 外发）、out-of-bounds-write（写凭据目录/Claude 配置）、
        // frontmatter-hooks（无人值守执行）。这条保留为"值得看一眼"的信号。
        severity: 'MEDIUM',
        rule: hasNetOrWrite ? 'broad-tools-plus-io' : 'broad-allowed-tools',
        file,
        line: lineOf['allowed-tools'] ?? null,
        snippet: `allowed-tools: ${list.join(', ')}`,
        why: hasNetOrWrite
          ? `allowed-tools 过宽（${broad.join(', ')}）且正文含网络/写入操作 —— 值得人工看一眼，但不单独构成高危`
          : `allowed-tools 过宽（${broad.join(', ')}）`,
      });
    }
  }

  return out;
}

export function verdictOf(findings) {
  if (findings.some((f) => f.severity === 'HIGH')) return 'blocked';
  if (findings.some((f) => f.severity === 'MEDIUM')) return 'suspicious';
  return 'clean';
}

export function summarize(findings) {
  return {
    HIGH: findings.filter((f) => f.severity === 'HIGH').length,
    MEDIUM: findings.filter((f) => f.severity === 'MEDIUM').length,
    LOW: findings.filter((f) => f.severity === 'LOW').length,
  };
}

function redact(s) {
  const t = String(s);
  if (t.length <= 12) return t[0] + '***';
  return t.slice(0, 8) + '…[' + (t.length - 8) + ' chars redacted]';
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

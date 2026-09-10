# 评分口径（审计用）

本文件是**唯一**写明各维度权重的地方。候选表里**不展开权重占比** —— 表格只呈现
可直接核对的硬事实（安装量、license、最后提交、扫描结论、来源）。
需要追溯"为什么 A 排在 B 前面"时，看这里。

评分器版本 `SCORER_VERSION = 0.1.0`。**只排序，不淘汰** —— 淘汰由硬门槛负责。

---

## 权重

| 维度 | 权重 | 实现 |
|---|---|---|
| 相关性 | **40** | `scoreRelevance()` |
| 安装量（per-skill） | **35** | `scoreInstall()` |
| 活跃度 | **15** | `scoreActivity()` |
| 来源可信度 | **10** | `scoreSource()` |
| **stars** | **0** | `scoreStars()` —— 恒返回 0 |
| 合计 | 100 | `total()` |

---

## 相关性 — 40 分

| 命中方式 | 得分 |
|---|---|
| 精确短语 | 40 |
| 全部词命中 | 25 |
| 部分词命中 | 10 |
| 名称命中额外 | +5（封顶 40） |

比对对象是 `skill description + skill name` 的拼接串，经 `synonyms.json` 扩展。
匹配前统一小写、去标点。

**每次必须记录"哪个词命中了哪个字段"**（`matched: [{term, field}]`）—— 要可追溯，
匹配器就不能是黑箱。

> **注意**：预排序阶段（`prelimScore`，零 GitHub 调用）用的是**更弱**的信号 ——
> 只有名称与查询词。它**只排序、不淘汰**，因为 skill 名是烂的相关性信号：
> `strategy-red-team` 的名字里既没有 "product" 也没有 "feasibility"，
> 但它的描述明明白白是产品可行性工具。真正的相关性命中要靠 T1 拿到的 description。

---

## 安装量 — 35 分

```
scoreInstall(n) = min(35, 35 · log10(n) / log10(100000))
```

log 压缩的理由：安装量头部集中、长尾噪声大。线性计分会让头部 3 个 skill
吃掉整个排序，尾部完全无法区分。

### ⚠️ 粒度约束（本文件最重要的一条）

**必须用 `search.skills[].installs`（per-skill），禁用 `/api/badge/{owner}/{repo}`
（仓库聚合）。**

`scoreInstall(installs, proof)` 在 `proof.kind !== 'per-skill'` 时**抛错**，
不是静默降级。聚合值在**类型上**进不了评分函数：

```js
scoreInstall(203500, { kind: 'repo-aggregate' })  // → throws
scoreInstall(203500)                              // → throws（缺 proof）
scoreInstall(203500, undefined)                   // → throws
scoreInstall( 8483, { kind: 'per-skill' })        // → OK
```

`selftest.mjs` 有对应断言，包括一条**粒度断言**：把 badge 聚合值混进候选集合，
断言排序结果不受影响。

**为什么必须做成代码约束**：仓库聚合量 = 该仓所有 skill 之和。一个塞了 68 个 skill
的仓库，聚合量天然碾压一个只有 3 个精品的仓库。本轮实操中我正是据此错误地把
`phuryn`(203.5K) 判为比 `deanpeters`(113.8K)"高一个数量级" —— 而真实的 per-skill
对照是 `strategy-red-team` 8,483 vs `lean-ux-canvas` 1,988，**同一档次，不是数量级差距**。

---

## 活跃度 — 15 分

| `pushed_at` 距今 | 得分 |
|---|---|
| ≤ 30 天 | 15 |
| ≤ 90 天 | 10 |
| ≤ 180 天 | 6 |
| ≤ 365 天 | 3 |
| 更早 | 0 |

---

## 来源可信度 — 10 分

| 条件 | 得分 |
|---|---|
| 被 awesome-list 收录 | +5 |
| 知名组织（anthropics / github / aws / google / microsoft 等） | +5 |

---

## stars — 权重 0，且不展示

### 为什么是 0（这是刻意的决定，不是遗漏）

Claude skill 生态的 star 数**注水严重**：

- **互刷** —— skill 仓库之间互相 star
- **模板仓库批量导流** —— 从模板一键生成的仓库天然带上原仓库的曝光
- **`awesome-*` 聚合仓天然高星但无实际内容** —— 一个只放链接的清单可以有几千星

**实测对照**：

| 仓库 | stars | 其 skill 的真实安装量 |
|---|---|---|
| `deanpeters/Product-Manager-Skills` | **6,903★** | `derisk-measurement-advisor` 仅 **585** |
| ComfyUI 类仓库 | 数千★ | 对应 skill 无人安装 |

**核心判断**：**stars 衡量"仓库被看见"，安装量衡量"skill 被使用"。**
用户问的是"我想要一个**好用**的 skill" —— 那对应的是后者，不是前者。
`awesome-*` 清单给出 5,000 星，只能说明它被收藏了，不能说明里面的 skill 有人跑过。

### 落实方式

- `WEIGHTS.stars = 0`，`total()` 里 stars 项**被显式忽略**（传 `999999` 进去结果仍是 100）
- `scoreStars()` **无论传什么参数都返回 0** —— 签名保留是为了让"这里曾有这个维度"
  这件事在代码里可见，而不是凭空消失
- `renderTable()` **没有 stars 列**
- `assertNoStars(text)` 在渲染产物里发现 `★` 或 `stars` 字样就**抛错**，
  `selftest.mjs` 断言它能抓到违规

### stars 的去处

**仅记录在 `records/<skill>.json` 里供事后审计**，不参与排序、不进展示。
这样将来若要重新评估这个决定，历史数据还在。

---

## 淘汰 ≠ 评分

评分**只排序**。淘汰由硬门槛负责，且**每条都记录原因并展示**：

GitHub 可达 → frontmatter 可解析且 `description` 非空 → `name` 匹配
`/^[a-z][a-z0-9-]*$/` → 有明确 license（非 `NOASSERTION`）→ per-skill `installs >= 10`
→ T1 未判 BLOCKED。

同样，**预筛**（`installs < 10`，零 GitHub 调用）淘汰的项也进 `rejected` 清单 ——
用户要求"淘汰项不悄悄消失"，几百条噪声也不隐藏，只是按安装量降序展示，
让 `T1 BLOCKED` 这类真正有信息量的淘汰项留在视野里。

---

## 已知局限

- **相关性与安装量在本生态反相关**：切题的 skill 往往只有几十到几百安装量，
  高装量的多为通用工程类。因此**不设分数阈值**，只排序 + 摊开淘汰理由。
- **`NOASSERTION` 误杀**：该生态常见，硬门槛会淘汰不少可用仓库。
- **无 LLM 参与**：全部是确定性 HTTP + 正则。同一输入必得同一排序、同一结论 ——
  这是可追溯性的技术保证，代价是无法做语义匹配（见相关性命中一节）。

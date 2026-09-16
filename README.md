# JOJO-Lab

Claude Code skill 集合仓。目前收录 **3** 个。**一个 skill 一页，互不干扰。**

| skill | 一句话 |
|---|---|
| [**find-the-skill-you-want-most**](find-the-skill-you-want-most/) | 找到、审查并安装最合适的 Claude Code skill —— 按**真实 per-skill 安装量**排序，三层安全扫描，只在你明确确认后安装 |
| [**smart-minutes**](smart-minutes/) | 落地**会议纪要 agent** —— 录线下/线上会议 → 本地存储 → 自动提炼要点，**并且给出置信度**，判错了看得见、一键能改 |
| [**build-the-agent-you-most-want**](build-the-agent-you-most-want/) | 把模糊的 agent 想法**逼成方案再做出来** —— 苏格拉底式追问 → 张小龙式反驳 → 落地方案 → 执行并留痕 → 反思复盘 |

**点 skill 名进各自的页面**，每页就是那个 skill 的完整文档。

---

## 仓库结构

```
JOJO-Lab/
├── README.md                          ← 本页，只是索引
├── LICENSE                            MIT
├── find-the-skill-you-want-most/
│   ├── README.md                      ← 展示页
│   ├── SKILL.md                       ← 入口
│   ├── SCORING.md                     ← 评分口径（审计用）
│   └── scripts/                       ← 全部实现，零依赖，只用 node: 内置模块
├── smart-minutes/
│   ├── README.md                      ← 展示页
│   ├── SKILL.md                       ← 落地顺序 + 置信度设计
│   └── PITFALLS.md                    ← 坑表，按症状查
└── build-the-agent-you-most-want/
    ├── README.md                      ← 展示页
    ├── SKILL.md                       ← 入口：七阶段全流程
    ├── QUESTION-BANK.md               ← 阶段 1 提问银行
    ├── STEELMAN.md                    ← 阶段 2 三轮反驳协议
    ├── PLAN-TEMPLATE.md               ← 阶段 3 方案骨架
    └── LANDING.md                     ← 阶段 5-6 落地 + 留痕 + 复盘
```

> **为什么一个 skill 一页。** 多个 skill 的完整文档摊在同一页上，读的人分不清
> 哪段属于哪个 skill，改一个 skill 也要动公共文件。拆开之后：
> 加新 skill 只需**新建目录 + 一个 `README.md`**，再在根页表格里加一行 ——
> **不用改动任何已有 skill 的文档**。

---

## 安装

**一个 skill 一个链接。** 把下面任意一行**原样发给你的 agent**，它就能自己装 ——
不需要你事先 clone 这个仓库：

| skill | 发给 agent 的一行 |
|---|---|
| **find-the-skill-you-want-most** | `帮我安装这个 skill：https://github.com/Jojo-dai/JOJO-Lab/tree/main/find-the-skill-you-want-most` |
| **smart-minutes** | `帮我安装这个 skill：https://github.com/Jojo-dai/JOJO-Lab/tree/main/smart-minutes` |
| **build-the-agent-you-most-want** | `帮我安装这个 skill：https://github.com/Jojo-dai/JOJO-Lab/tree/main/build-the-agent-you-most-want` |

或者自己一条命令跑完（把 `<skill>` 换成上表的目录名）：

```bash
npx --yes skills@1.5.25 add Jojo-dai/JOJO-Lab -s <skill> -g --copy -y
```

> `-s <skill>` **必须指定** —— 这个仓库里有多个 skill，不指定会把它们**全装上**。

装完**重启 Claude Code**。每个 skill 页顶部还有**手工安装方式**（含 Windows
PowerShell 版本）和各自的依赖说明。

> ⚠️ `~/.claude/skills/` 只认「**目录名 = skill 名**」。目录名与 `SKILL.md` 里的
> `name:` 不一致时，Claude Code **扫不到它，而且不报错** —— 表现只是"没反应"。

---

## License

[MIT](LICENSE)

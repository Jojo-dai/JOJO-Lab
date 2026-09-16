# JOJO-Lab

Claude Code skill 集合仓。目前收录 **2** 个。**一个 skill 一页，互不干扰。**

| skill | 一句话 |
|---|---|
| [**find-the-skill-you-want-most**](find-the-skill-you-want-most/) | 找到、审查并安装最合适的 Claude Code skill —— 按**真实 per-skill 安装量**排序，三层安全扫描，只在你明确确认后安装 |
| [**smart-minutes**](smart-minutes/) | 落地**会议纪要 agent** —— 录线下/线上会议 → 本地存储 → 自动提炼要点，**并且给出置信度**，判错了看得见、一键能改 |

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
└── smart-minutes/
    ├── README.md                      ← 展示页
    ├── SKILL.md                       ← 落地顺序 + 置信度设计
    └── PITFALLS.md                    ← 坑表，按症状查
```

> **为什么一个 skill 一页。** 多个 skill 的完整文档摊在同一页上，读的人分不清
> 哪段属于哪个 skill，改一个 skill 也要动公共文件。拆开之后：
> 加新 skill 只需**新建目录 + 一个 `README.md`**，再在根页表格里加一行 ——
> **不用改动任何已有 skill 的文档**。
>
> ⚠️ `~/.claude/skills/` 只认「**目录名 = skill 名**」，所以子目录名必须与
> `SKILL.md` 里 `name:` 字段**完全一致**。

---

## 安装

**方式一：走 `npx skills`**（推荐）

```bash
npx skills add Jojo-dai/JOJO-Lab
```

**方式二：手工放进 skills 目录**

`~/.claude/skills/` 只认「目录名 = skill 名」，而 clone 下来的目录叫 `JOJO-Lab`，
所以要多一步把子目录挪出去：

```bash
cd ~/.claude/skills
git clone https://github.com/Jojo-dai/JOJO-Lab.git _jojolab-tmp
mv _jojolab-tmp/smart-minutes ./          # 换成你要的那一个
rm -rf _jojolab-tmp
```

装完**重启 Claude Code**，即可作为 `/smart-minutes` 调用，或直接说
"帮我落地一个会议纪要 agent"。

**要求**：只有 `find-the-skill-you-want-most` 需要 Node.js ≥ 20
（开发与验证在 v24.14.1 上完成，无需 token，无需 `jq`）。
`smart-minutes` 是**纯 Markdown**，没有任何运行时依赖。

---

## License

[MIT](LICENSE)

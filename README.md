# dsh-taste

> 你只管说要做什么，剩下的它自己会想。

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 用的界面设计插件。装上以后，每个会话自动获得一套**设计工作规则** + 6 个 `design_*` 工具，背后站着两套真东西：

| 资产 | 是什么 | 来源 |
|---|---|---|
| **impeccable 引擎** | 25 条设计方法论（`critique` / `shape` / `polish` / `harden` …）+ **61 条确定性反模式扫描器** | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) |
| **DESIGN.md 风格库** | **84 套**真实站点的设计语言说明书，带精确颜色 / 字体 / 间距 token | [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) |

---

## 它解决什么

普通 AI 做界面，三个老毛病：

1. **要你说清风格** —— 你不说，它给你紫渐变 + 圆角卡片 + 一堆阴影。
2. **凭感觉点评** —— "这里可以更现代一点"，改完还是烂。
3. **每次重来** —— 上一页的色彩体系，下一页就丢了。

dsh-taste 的对策分别是：**主动给方案**、**扫描器打分**、**DESIGN.md 当合同**。

---

## 怎么用（一句话就够）

```
给 xx 做一个落地页，要高级一点
```

它不会反问你风格，而是**一次给出 2~4 个气质完全不同的方案**，每个都引用一套真实站点的设计语言，并说清「长什么样 / 什么颜色字体 / **代价是什么**」：

```
需求：给一个 AI 笔记产品做落地页，要高级一点

给你 3 个方向（气质各不相同）：

1. stripe · 克制·文档型
   观感：深蓝墨底 + 电光靛，网格渐变压在首屏上三分之一…
   主色：#533afd  #4434d4  #2e2b8c  #665efd  #b9b9f9  #1c1e54
   字体：sohne-var
   代价：信息一多就显寡淡，层级全靠字号与留白撑，写不好会像未设计的后台

2. together.ai · AI·新锐型
   …
3. linear.app · 暗色·产品型
   …
```

你回一句「用 2」，它才开始动手：

```
design_use_style  → 项目根落一份 DESIGN.md（合同）
        ↓
只按 DESIGN.md 的 token 写代码（颜色/字号/间距不许即兴发挥）
        ↓
design_detect 自检 → 61 条规则逐条打分，报问题必须引用规则名与数值
```

其它直接说法：

| 你说 | 它做什么 |
|---|---|
| `太丑了，帮我改造一下这个页面` | `redesign` / `bolder` / `quieter` 路线重做 |
| `把这个页面体检一遍` | 跑扫描器，按严重度列出问题清单 |
| `简化一下，层级太多` | `distill`：删层级、合并组件、压装饰 |
| `加一点动效，别土` | `animate`：只加有信息意义的动效 |
| `换成 linear 那种暗色风格` | 换 DESIGN.md → 重新对齐 token |
| `适配手机` | `adapt`：断点 + 触控目标 + 密度 |

---

## 安装

### 前置

- DSH 桌面版（Windows）。`%DSH_HOME%` 默认 `C:\Users\<你>\.dsh`
- 能联网（第一次要下两套资产）

### 三条命令

```powershell
git clone https://github.com/<你的账号>/dsh-taste.git D:\dsh-taste
cd D:\dsh-taste

# 1) 下载引擎 + 技能细则 + 84 套风格库（约 20MB，国内自动走加速源）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-assets.ps1

# 2) 装依赖、登记 profile、建 junction
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

**3) 重启 DSH 桌面版**（插件只在启动时加载）。

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
```

> 为什么不用 `dsh plugin add`？桌面版把 `desktop` profile 独占给 Electron，命令行入口被拒；`install.ps1` 走的是同一条最终路径（profile 的 `dependencies` + `dsh.profile.bundles` + `node_modules` junction），只是绕过了那把锁。

### 想换个盘 / 自定义路径

```powershell
# 资产放到 D 盘
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-assets.ps1 -PluginPath D:\dsh-taste

# 风格库/引擎本来就有，直接指向
# 编辑 cordis.patch.yml：
#   skillRoot:  "D:\\assets\\impeccable"
#   stylesRoot: "D:\\assets\\design-md"
```

---

## 六个工具

模型会自己调，你也可以直接要求。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `design_propose` | 一句话 → 2~4 个不同气质方案（含观感、主色、字体、代价） | `idea`、`count` |
| `design_use_style` | 把某套站点风格落成项目里的 `DESIGN.md` | `slug`、`dest`、`force` |
| `design_detect` | 确定性自检：61 条反模式（渐变文字、AI 紫、对比度不足、单边粗色条…） | `target`、`json`、`scope` |
| `design_playbook` | 取 41 篇方法论细则原文（`critique` / `shape` / `polish` …） | `command`、`inline` |
| `design_styles` | 检索 84 套风格 | `keyword` |
| `design_engine` | 引擎原始命令（`context`、`--version`…） | `args` |

`design_propose` 的分流表（保证方案不同质）：

| 气质档 | 命中词举例 | 代表风格 |
|---|---|---|
| 克制·文档型 | 高级、干净、官网、企业 | stripe / vercel / notion |
| 暗色·产品型 | 暗色、开发者、仪表盘、SaaS | linear / supabase / sentry |
| 暖调·人文型 | 温暖、亲切、生活、阅读 | claude / airbnb / starbucks |
| 大胆·品牌型 | 冲击、潮、运动、发布 | nike / tesla / spotify |
| 工具·协作型 | 编辑器、画布、工作台 | figma / framer / miro |
| 金融·信任型 | 支付、钱包、安全、toB | coinbase / wise / revolut |
| AI·新锐型 | AI、模型、agent、生成 | together.ai / elevenlabs |
| 工业·硬朗型 | 硬件、参数、汽车 | bmw / nvidia / dji |

---

## 配置项

`cordis.patch.yml` 里都可以省略，省略时自动定位：

| 键 | 默认 | 说明 |
|---|---|---|
| `skillRoot` | `%DSH_HOME%/skills/impeccable` | 引擎技能目录（含 `reference/*.md`） |
| `stylesRoot` | `<插件>/assets/design-md` | DESIGN.md 风格库根目录 |
| `enginePath` | 空（自动探测） | 引擎可执行文件 |
| `timeoutMs` | `180000` | 单次引擎调用超时 |
| `injectSessionRule` | `true` | 是否注入会话规则块 |
| `verbose` | `true` | 启动日志 |

---

## 结构

```
dsh-taste/
├── lib/index.js           # 唯一入口：注入规则 + 注册 6 个工具 + 引擎桥
├── cordis.patch.yml       # bundle patch（DSH 从这里挂载插件）
├── scripts/
│   ├── setup-assets.ps1   # 下引擎 + 装技能 + 下风格库
│   └── install.ps1        # 装/卸 profile
└── assets/                # setup-assets 生成，不入库
    ├── bin/impeccable.exe
    └── design-md/<slug>/DESIGN.md
```

加一套新风格：往 `assets/design-md/` 扔一个目录（内含 `DESIGN.md`），`design_styles` 立刻能检索到；`design_propose` 的气质分流靠 `lib/index.js` 的 `TASTE` 表，按需加 slug。

---

## 常见问题

**重启后看不到 `design_*` 工具？**
看 DSH 启动日志里有没有 `[taste] 设计插件生效：风格库 N 套…`。没有的话通常是 profile 的 `bundles` 没写上，或 junction 没建。

**`design_propose` 说风格库为空？**
`scripts/setup-assets.ps1` 没跑完，或 `stylesRoot` 指错了。风格库在 `<插件>/assets/design-md/<slug>/DESIGN.md`。

**`design_detect` 报找不到引擎？**
引擎没下到，或者 `impeccable install` 失败。手动验证：`assets\bin\impeccable.exe --version`。

**国内下载失败？**
`setup-assets.ps1` 默认依次试直连 → `gh-proxy.com` → `ghfast.top`；也可以 `-Proxy @('https://你的加速前缀/')`。

---

## 自己发布一份（可选）

仓库不带 `assets/`（第三方二进制与风格库版权），所以别人 clone 下来只需多跑一步 `setup-assets.ps1`。

维护者更新代码后同步到 GitHub（不需要装 git）：

```powershell
$env:GH_TOKEN = "ghp_xxxxxxxx"       # classic PAT，勾 repo；或 fine-grained 给 Contents: RW
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -Repo dsh-taste
# 私有仓库加 -Private；先看清单加 -DryRun
```

它会创建仓库（已存在则复用）、逐文件对比后只提交有变化的，跳过 `assets/`、`node_modules/`、`*.bak`。

---

## 许可与致谢

- 本插件代码：MIT
- 设计方法论与扫描器：[pbakaus/impeccable](https://github.com/pbakaus/impeccable)（按其许可使用，不随本仓库分发）
- DESIGN.md 风格库：[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)（同上）
- 风格库中的站点商标与设计语言归各自所有者，`DESIGN.md` 是**分析性描述**，用于学习与参考，不构成授权复制他人品牌资产。

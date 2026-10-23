/**
 * dsh-taste
 *
 * 一站式界面设计插件。三件事：
 *
 * 1. **会话规则注入** —— 把「怎么做好界面」的工作规则（含 25 条设计命令的
 *    意图书、资产路径、判定标准）写进每个会话的系统提示，不用每次重复交代。
 * 2. **`design_*` 工具族** —— 让 Agent 自己就能检索 84 套真实站点风格、
 *    把某套 DESIGN.md 落到项目、跑确定性体检、取用某条命令的完整细则。
 * 3. **引擎桥** —— 直接调用 impeccable 原生的 `detect` / `context` 可执行文件，
 *    把「AI 味」检测结果结构化返回，而不是让模型凭感觉点评。
 *
 * 资产根目录、引擎路径、超时全部可通过 cordis.patch.yml 配置。
 *
 * @module dsh-taste
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'taste'

/** 插件自带资产目录（styles 库默认放这里，便于 npm 包内自洽）。 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** impeccable 引擎安装后的默认技能目录（impeccable install --providers=dsh --user）。 */
const DEFAULT_SKILL_ROOT = join(DSH_HOME, 'skills', 'impeccable')
/** 84 套 DESIGN.md 的默认位置，可由 setup-assets.ps1 下载到此处。 */
const DEFAULT_STYLES_ROOT = join(PKG_ROOT, 'assets', 'design-md')

/**
 * 只声明 `tools` 为硬依赖。`systemPrompt` 在 apply() 里通过
 * `ctx.reflect.get(..., false)` 惰性解析 —— cordis v4 的 `inject` 是扁平必需
 * 映射，声明成必需会让整个插件在服务尚未就绪时一起失效。
 */
export const inject = ['tools']

export const Config = Schema.object({
  skillRoot: Schema.string().default(DEFAULT_SKILL_ROOT),
  stylesRoot: Schema.string().default(DEFAULT_STYLES_ROOT),
  enginePath: Schema.string().default(''),
  timeoutMs: Schema.number().default(180000),
  injectSessionRule: Schema.boolean().default(true),
  verbose: Schema.boolean().default(true),
})

/* --------------------------------------------------------------- 输出声明 */

const TEXT_OUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
}

/* ----------------------------------------------------------- 风格库索引 */

/** 读 DESIGN.md 的可用元信息；兼容 YAML frontmatter 与纯 Markdown 两种写法。 */
function parseStyle(dir) {
  const file = join(dir, 'DESIGN.md')
  if (!existsSync(file)) return null
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const front = (/^---\r?\n([\s\S]*?)\r?\n---/u.exec(text) || [])[1] || ''
  const body = front ? text.slice(text.search(/\r?\n---/u) + 4) : text
  const field = (key) => {
    const hit = new RegExp('^' + key + ':\\s*(.*)$', 'mu').exec(front)
    return hit ? hit[1].replace(/^["']|["']$/gu, '').trim() : ''
  }

  // description 可能是块标量（| 或 >），真值在后续缩进行。
  let description = field('description')
  if (!description || /^[|>][-+]?$/u.test(description)) {
    const block = /^description:\s*[|>][-+]?\r?\n((?:[ \t]+.*\r?\n?)+)/mu.exec(front)
    description = block ? block[1].replace(/^[ \t]+/gmu, '').replace(/\r?\n+/gu, ' ').trim() : ''
  }
  // 纯 Markdown 风格（无 frontmatter）：取一级标题后的第一段正文。
  if (!description) {
    description =
      body
        .split(/\r?\n\s*\r?\n/u)
        .map((p) => p.replace(/\s+/gu, ' ').trim())
        .find((p) => p && !p.startsWith('#') && !p.startsWith('**') && !p.startsWith('|')) || ''
  }

  const yamlColors = [...front.matchAll(/^\s{2,}([a-z0-9-]+):\s*"(#[0-9a-fA-F]{3,8})"/gmu)]
    .map((m) => m[2])
    .filter((v, i, all) => all.indexOf(v) === i)
  const anyColors = [...new Set([...text.matchAll(/#[0-9a-fA-F]{6}\b/gu)].map((m) => m[0].toLowerCase()))]
  const palette = (yamlColors.length ? yamlColors : anyColors).slice(0, 6)
  const fontHit =
    /fontFamily:\s*"([^",\n]+)/u.exec(front) ||
    /\b([A-Z][A-Za-z0-9]*(?:[ -][A-Z][A-Za-z0-9]*){0,2}[ ]?(?:Sans|Serif|Grotesk|Mono|Display|Neue))\b/u.exec(body)

  return {
    slug: basename(dir),
    title: field('name') || basename(dir),
    description,
    colors: palette,
    font: fontHit ? String(fontHit[1]).replace(/^['"]|['"]$/gu, '').replace(/\s+/gu, ' ').trim() : '',
    file,
  }
}

let styleCache = null
function styles(config) {
  if (styleCache && styleCache.root === config.stylesRoot) return styleCache.rows
  const root = config.stylesRoot
  const rows = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const hit = parseStyle(join(root, entry.name))
      if (hit) rows.push(hit)
    }
  } catch {
    /* 目录缺失时返回空表，由工具层给出提示 */
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug))
  styleCache = { root, rows }
  return rows
}

/** 截一段能读懂的话：优先整句，超长就在逗号/破折号处收，禁止半截断词。 */
function shortDescription(text, limit = 170) {
  const clean = String(text || '').replace(/\s+/gu, ' ').trim()
  if (!clean) return ''
  const sentence = clean.split(/(?<=[.。])\s/u)[0]
  let out = sentence.length >= 24 ? sentence : clean
  if (out.length > limit) {
    const head = out.slice(0, limit)
    const cut = Math.max(
      head.lastIndexOf('，'),
      head.lastIndexOf(', '),
      head.lastIndexOf(' — '),
      head.lastIndexOf('; '),
      head.lastIndexOf('. '),
    )
    out = (cut > limit * 0.5 ? head.slice(0, cut) : head).trim() + '…'
  }
  return out
}

function styleLine(row) {
  const bits = [shortDescription(row.description)]
  if (row.colors.length) bits.push(`主色 ${row.colors.slice(0, 3).join(' ')}`)
  if (row.font) bits.push(row.font)
  return `- \`${row.slug}\` — ${bits.filter(Boolean).join(' · ')}`
}

/* --------------------------------------------------------------- 引擎桥 */

function resolveEngine(config) {
  const candidates = []
  if (config.enginePath) candidates.push(config.enginePath)
  for (const dir of ['scripts/bin/windows-x64', 'scripts/bin/win32-x64', 'scripts/bin']) {
    candidates.push(join(config.skillRoot, dir, 'impeccable.exe'))
    candidates.push(join(config.skillRoot, dir, 'impeccable.cmd'))
    candidates.push(join(config.skillRoot, dir, 'impeccable'))
  }
  candidates.push(join(config.skillRoot, 'scripts', 'impeccable.cmd'))
  // setup-assets.ps1 会把引擎单独下一份到插件 assets/bin，作为兜底
  candidates.push(join(PKG_ROOT, 'assets', 'bin', 'impeccable.exe'))
  candidates.push(join(PKG_ROOT, 'assets', 'bin', 'impeccable'))
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const shell = /\.(cmd|bat|ps1)$/iu.test(file)
    return { file, shell }
  }
  return null
}

function runEngine(config, args, cwd) {
  const engine = resolveEngine(config)
  if (!engine) {
    return { ok: false, text: `找不到设计引擎，请检查配置 enginePath 或 skillRoot（当前 ${config.skillRoot}）` }
  }
  const result = spawnSync(engine.shell ? `"${engine.file}"` : engine.file, engine.shell ? args : args, {
    cwd: existsSync(cwd || '') ? cwd : process.cwd(),
    shell: engine.shell,
    windowsHide: true,
    timeout: config.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  if (result.error) {
    return { ok: false, exitCode: -1, output: `${output}\n${result.error.message}`.trim() }
  }
  return { ok: result.status === 0, exitCode: result.status, output }
}

/* --------------------------------------------------------------- 细则库 */

function playbookDir(config) {
  return join(config.skillRoot, 'reference')
}

function playbookNames(config) {
  try {
    return readdirSync(playbookDir(config))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/u, ''))
      .sort()
  } catch {
    return []
  }
}

/** 命令名容错：`critique.page`、`Critique`、`critique.md` 都能命中。 */
function resolvePlaybook(config, command) {
  const raw = String(command || '').trim().replace(/\.md$/iu, '')
  if (!raw) return null
  const names = playbookNames(config)
  const lower = raw.toLowerCase()
  const candidates = [lower, lower.replace(/_/gu, '-'), lower.replace(/\./gu, '-')]
  for (const key of candidates) {
    if (names.includes(key)) return { key, file: join(playbookDir(config), `${key}.md`) }
  }
  const fuzzy = names.find((n) => n.startsWith(lower) || lower.startsWith(n))
  return fuzzy ? { key: fuzzy, file: join(playbookDir(config), `${fuzzy}.md`) } : null
}

/* --------------------------------------------------------------- 会话规则 */

/* 气质分档：用于「一句话 → 多方案」时保证方案彼此不同质，并给出取舍代价。 */
const TASTE = [
  {
    id: 'restrained',
    label: '克制·文档型',
    cost: '信息一多就显寡淡，层级全靠字号与留白撑，写不好会像未设计的后台',
    slugs: ['stripe', 'vercel', 'notion', 'mintlify', 'hashicorp', 'resend', 'sanity'],
    cues: ['高级', '精致', '克制', '干净', '简约', '极简', '专业', '稳重', '文档', '官网', '企业'],
  },
  {
    id: 'dark',
    label: '暗色·产品型',
    cost: '暗底吃图片和留白，缺层次就发闷；浅色打印/截图场景不友好',
    slugs: ['linear.app', 'supabase', 'sentry', 'posthog', 'raycast', 'warp', 'cursor'],
    cues: ['暗色', '黑色', '深色', '开发者', '技术', '仪表盘', '后台', '控制台', 'saas', '工具', '监控'],
  },
  {
    id: 'warm',
    label: '暖调·人文型',
    cost: '饱和度低、气质软，严肃的金融/医疗场景容易显得不够可信',
    slugs: ['claude', 'airbnb', 'starbucks', 'oura', 'clay', 'intercom'],
    cues: ['温暖', '亲切', '人文', '舒适', '治愈', '生活', '社区', '内容', '阅读', '品牌', '编辑'],
  },
  {
    id: 'bold',
    label: '大胆·品牌型',
    cost: '靠大字号与高对比撑场，细节密度一高就崩，改造老系统代价大',
    slugs: ['nike', 'tesla', 'spotify', 'spacex', 'bugatti', 'lamborghini', 'ferrari'],
    cues: ['大胆', '冲击', '潮', '年轻', '运动', '酷', '张扬', '营销', '发布', '品牌', '大片'],
  },
  {
    id: 'tool',
    label: '工具·协作型',
    cost: '组件多、状态多，实现成本高；小页面用它会显得过度设计',
    slugs: ['figma', 'framer', 'miro', 'webflow', 'zapier', 'slack', 'airtable'],
    cues: ['工具', '协作', '编辑器', '画布', '工作台', '表单', '配置', '多面板'],
  },
  {
    id: 'finance',
    label: '金融·信任型',
    cost: '配色保守、装饰少，做消费品会显得冷淡；数字排版要求极高',
    slugs: ['coinbase', 'wise', 'revolut', 'mastercard', 'mercury', 'kraken', 'binance'],
    cues: ['金融', '支付', '钱包', '账单', '交易', '安全', '信任', 'toB', 'b2b'],
  },
  {
    id: 'ai',
    label: 'AI·新锐型',
    cost: '渐变与光效一旦用滥就回到「AI 味」，必须靠排版和留白拉住',
    slugs: ['together.ai', 'elevenlabs', 'replicate', 'minimax', 'cohere', 'x.ai', 'lovable'],
    cues: ['ai', '模型', '智能', '生成', 'agent', '大模型', '科技', '未来'],
  },
  {
    id: 'physical',
    label: '工业·硬朗型',
    cost: '字重与网格感强，内容型页面会显得生硬；移动端密度难压',
    slugs: ['bmw', 'bmw-m', 'nvidia', 'dji', 'renault', 'dell-1996', 'playstation'],
    cues: ['工业', '硬件', '汽车', '设备', '参数', '规格', '硬朗', '机械'],
  },
]

/** 从一句话里挑出命中的气质档（按命中次数排序，没命中就全给）。 */
function tasteHits(idea, rows) {
  const text = String(idea || '').toLowerCase()
  const available = new Set(rows.map((r) => r.slug))
  return TASTE.map((group) => {
    const score = group.cues.reduce((sum, cue) => (text.includes(cue.toLowerCase()) ? sum + 1 : sum), 0)
    const slugs = group.slugs.filter((slug) => available.has(slug))
    return { ...group, slugs, score }
  })
    .filter((group) => group.slugs.length > 0)
    .sort((a, b) => b.score - a.score || TASTE.indexOf(a) - TASTE.indexOf(b))
}

/** 一句话 → N 个互不同质的方案（风格 + 观感 + token + 代价）。 */
function proposePlans(idea, rows, count) {
  const bySlug = new Map(rows.map((row) => [row.slug, row]))
  const lower = String(idea || '').toLowerCase()

  // 用户直接点了站点名：它必须排第一。
  const named = [...bySlug.keys()].find((slug) => lower.includes(slug.toLowerCase()))
  const groups = tasteHits(idea, rows)
  const plans = []
  const usedGroups = new Set()

  const push = (group, slug) => {
    const row = bySlug.get(slug)
    if (!row || plans.some((p) => p.row.slug === slug)) return false
    plans.push({ row, group })
    usedGroups.add(group.id)
    return true
  }

  if (named) {
    const owner = TASTE.find((g) => g.slugs.includes(named)) || { id: 'custom', label: '指定风格', cost: '按站点原样还原，注意别把它的行业气质套错场景' }
    push(owner, named)
  }

  // 每轮从不同气质档各取一个，保证方案之间不是同一种味道。
  for (const group of groups) {
    if (plans.length >= count) break
    if (usedGroups.has(group.id)) continue
    const hit = group.slugs.find((slug) => !plans.some((p) => p.row.slug === slug))
    if (hit) push(group, hit)
  }
  // 还不够就放宽（允许同档第二个），再不够就按字母序补。
  for (const group of groups) {
    if (plans.length >= count) break
    for (const slug of group.slugs) {
      if (plans.length >= count) break
      push(group, slug)
    }
  }
  for (const row of rows) {
    if (plans.length >= count) break
    push({ id: 'any', label: '通用', cost: '气质中性，靠内容本身撑' }, row.slug)
  }
  return plans
}

function designRule(config) {
  const rows = styles(config)
  return [
    '# 界面设计（dsh-taste 已装）',
    '',
    '用户说一句话就够，别反问流程、别问要什么风格。默认动作：',
    '1. 先用 `design_propose` 拿到 2~3 个**气质不同**的方案，用两三行说清每个「长什么样 + 代价是什么 + 适合谁」，让用户挑。',
    '2. 挑定后用 `design_use_style` 落 DESIGN.md（项目根已有就跳过），实现时颜色/字号/间距只用它的 token。',
    '3. 写完用 `design_detect` 自检；报问题要引用规则名与数值，不许说「感觉更好了」。',
    '',
    '其余工具：`design_styles` 检索 84 套风格 · `design_playbook` 取 41 篇方法论细则 · `design_engine` 自检。',
    '',
    '硬规则：颜色只用 DESIGN.md 里的值；禁渐变文字、禁单边粗色条卡片、禁默认 AI 紫；正文对比度 ≥ 4.5:1；层级靠尺寸/字重/留白，不靠阴影堆叠与到处描边。',
    `资产：引擎 ${config.skillRoot} · 风格库 ${config.stylesRoot}（${rows.length} 套）`,
  ].join('\n')
}

/* ----------------------------------------------------------------- apply */

export function apply(ctx, config) {
  if (config.verbose) {
    const rows = styles(config)
    const engine = resolveEngine(config)
    console.log(
      `[taste] 设计插件生效：风格库 ${rows.length} 套；细则 ${playbookNames(config).length} 篇；引擎 ${engine ? engine.file : '未找到'}`,
    )
  }

  /* 规则注入：把设计规则前置进每个会话的系统提示。
   * `systemPrompt` 故意不写进 inject —— 见文件顶部的说明。 */
  let detachRule = null
  const attachRule = () => {
    if (!config.injectSessionRule || detachRule) return
    try {
      const systemPrompt = ctx.reflect?.get?.('systemPrompt', false)
      if (typeof systemPrompt?.section !== 'function') return
      detachRule =
        systemPrompt.section({
          name: 'taste-rules',
          order: 600,
          text: () => designRule(config),
        }) ?? true
    } catch (error) {
      if (config.verbose) console.warn(`[taste] 会话规则注入跳过：${error?.message ?? error}`)
    }
  }
  attachRule()
  ctx.on('internal/service', (serviceName) => {
    if (serviceName === 'systemPrompt') attachRule()
  })

  const run = (fn) => {
    try {
      return fn()
    } catch (error) {
      return { ok: false, text: `错误: ${error?.message ?? error}` }
    }
  }

  /* 0. 一句话 → 多方案 --------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_propose',
      description:
        'Turn ONE sentence of user intent into 2-4 visually distinct design directions, each with a real style-library reference (DESIGN.md), its exact colors/font, what it will look like, and what it costs. Call this FIRST when a user says "design a page / make this look good / pick a style" instead of asking them questions: offer the plans, let them pick a number, then implement against that DESIGN.md.',
      parameters: {
        idea: {
          type: 'string',
          required: true,
          description: "The user's own sentence, verbatim, e.g. 「做一个 AI 笔记产品落地页，要高级一点」or 'admin dashboard for a payment product, dark'.",
        },
        count: { type: 'number', description: 'How many directions to offer (2-4, default 3).' },
      },
      output: TEXT_OUT,
      async execute(args) {
        return run(() => {
          const idea = String(args.idea || '').trim()
          if (!idea) {
            return { ok: false, text: '给一句需求就行，例如「做一个 AI 笔记产品的落地页，要高级一点」。' }
          }
          const rows = styles(config)
          if (!rows.length) return { ok: false, text: `风格库为空：${config.stylesRoot}` }
          const count = Math.max(2, Math.min(Number(args.count) || 3, 4))
          const plans = proposePlans(idea, rows, count)
          const lines = [`需求：${idea}`, '', `给你 ${plans.length} 个方向（气质各不相同）：`, '']
          plans.forEach((plan, index) => {
            lines.push(`${index + 1}. ${plan.row.slug} · ${plan.group.label}`)
            const look = shortDescription(plan.row.description, 220)
            if (look) lines.push(`   观感：${look}`)
            else if (plan.row.colors.length) {
              lines.push(`   观感：${plan.row.colors.slice(0, 2).join(' / ')} 主导的高对比体系${plan.row.font ? `，字体 ${plan.row.font}` : ''}`)
            }
            if (plan.row.colors.length) lines.push(`   主色：${plan.row.colors.join('  ')}`)
            if (plan.row.font) lines.push(`   字体：${plan.row.font}`)
            lines.push(`   代价：${plan.group.cost}`)
            lines.push('')
          })
          lines.push('回一个数字即可（如「用 2」）；想换口味就说「再暗一点 / 再活泼一点 / 更像 Apple」。')
          lines.push('选定后我会：落 DESIGN.md → 只按它的 token 实现 → design_detect 自检。')
          return { ok: true, text: lines.join('\n') }
        })
      },
    }),
  )

  /* 1. 风格检索 ---------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_styles',
      description:
        'Search the bundled style library of 84 real-world site DESIGN.md files (Stripe, Linear, Vercel, Claude, Apple, Supabase, Notion, Figma, Framer, Airbnb, Tesla, Nike, Spotify, Coinbase, Wise, Revolut, ...). Returns each match with slug, one-line visual description, main colors and font. Use it to pick a concrete style before designing.',
      parameters: {
        keyword: {
          type: 'string',
          description: 'Optional filter matched against slug, title, description, colors and font (case-insensitive). Omit to list all.',
        },
        limit: { type: 'number', description: 'Max rows to return (default 84).' },
      },
      output: TEXT_OUT,
      async execute(args) {
        return run(() => {
          const rows = styles(config)
          const keyword = String(args.keyword || '').trim().toLowerCase()
          const rank = (row) => {
            const slug = row.slug.toLowerCase()
            if (slug === keyword) return 0
            if (slug.includes(keyword)) return 1
            if (row.title.toLowerCase().includes(keyword)) return 2
            if (row.description.toLowerCase().includes(keyword)) return 3
            return 4
          }
          const hit = keyword
            ? rows
                .filter((row) =>
                  [row.slug, row.title, row.description, row.colors.join(' '), row.font]
                    .join(' ')
                    .toLowerCase()
                    .includes(keyword),
                )
                .sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug))
            : rows
          const limit = Math.max(1, Math.min(Number(args.limit) || 84, 200))
          const shown = hit.slice(0, limit)
          const head = `风格库 ${rows.length} 套${keyword ? `，命中 ${hit.length} 套（关键词 ${keyword}）` : ''}：`
          const tail = hit.length > shown.length ? `\n…另有 ${hit.length - shown.length} 套未显示` : ''
          return { ok: true, text: `${head}\n${shown.map(styleLine).join('\n')}${tail}` }
        })
      },
    }),
  )

  /* 2. 套用风格 ---------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_use_style',
      description:
        'Copy one style library DESIGN.md into a project so it becomes the design contract for that codebase. Returns the written path plus the exact color and font tokens, so you can implement against them without re-reading the file.',
      parameters: {
        slug: { type: 'string', required: true, description: 'Style slug from design_styles, e.g. stripe, linear.app, vercel, claude.' },
        dest: { type: 'string', description: 'Target directory (project root). Defaults to the current working directory.' },
        force: { type: 'boolean', description: 'Overwrite an existing DESIGN.md (default false).' },
      },
      output: TEXT_OUT,
      async execute(args) {
        return run(() => {
          const slug = String(args.slug || '').trim()
          const row = styles(config).find((r) => r.slug.toLowerCase() === slug.toLowerCase())
          if (!row) {
            const near = styles(config)
              .filter((r) => r.slug.toLowerCase().includes(slug.toLowerCase()))
              .slice(0, 8)
              .map((r) => r.slug)
            return {
              ok: false,
              text: `没有 \`${slug}\` 这套风格。${near.length ? `相近的有：${near.join(', ')}` : '用 design_styles 看全表。'}`,
            }
          }
          const dir = resolve(args.dest || process.cwd())
          if (!existsSync(dir)) return { ok: false, text: `目标目录不存在：${dir}` }
          const target = join(dir, 'DESIGN.md')
          if (existsSync(target) && !args.force) {
            return { ok: false, text: `${target} 已存在。确认覆盖就带 force: true 重跑。` }
          }
          copyFileSync(row.file, target)
          const tokens = [
            `已写入 ${target}`,
            `风格：${row.title}`,
            row.description ? `定位：${shortDescription(row.description, 400)}` : '',
            row.colors.length ? `主色：${row.colors.join('  ')}` : '',
            row.font ? `字体：${row.font}` : '',
            `完整 YAML token 见文件顶部 frontmatter；实现时只许用这些值。`,
          ]
            .filter(Boolean)
            .join('\n')
          return { ok: true, text: tokens }
        })
      },
    }),
  )

  /* 3. 确定性体检 -------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_detect',
      description:
        'Run the impeccable deterministic scanner (61 rules: contrast, gradient text, side-tab, AI color palettes, layout rhythm, ...) over a source directory, a built site directory, or a live URL / Electron CDP port. Returns exit code 0 (clean) / 2 (primary findings) / 1 (errors) plus the raw report. Use it instead of eyeballing whether a page "looks AI".',
      parameters: {
        target: { type: 'string', description: 'Directory, file, http(s) URL, or "cdp:PORT" for Electron/CDP targets. Defaults to the current working directory.' },
        json: { type: 'boolean', description: 'Ask the engine for machine-readable JSON output.' },
        scope: { type: 'string', description: 'Narrow rules: "type" for typography rules, "layout" for layout rules.' },
        cwd: { type: 'string', description: 'Working directory for the scan (defaults to the process cwd).' },
      },
      output: TEXT_OUT,
      async execute(args) {
        return run(() => {
          const target = String(args.target || '').trim() || '.'
          const argv = ['detect']
          if (args.json) argv.push('--json')
          if (args.scope) argv.push(`--scope=${args.scope}`)
          argv.push(target.startsWith('cdp:') ? `--cdp=${target.slice(4)}` : target)
          const result = runEngine(config, argv, args.cwd)
          const verdict =
            result.exitCode === 0
              ? '体检通过：0 条 primary 问题'
              : result.exitCode === 2
                ? '体检发现 primary 问题（见下）'
                : result.exitCode === 1
                  ? '引擎报错或有文件未扫描成功'
                  : '引擎未正常返回'
          return {
            ok: Boolean(result.ok),
            text: `${verdict}\n命令：impeccable ${argv.join(' ')}\n退出码：${result.exitCode}\n\n${result.output || '(无输出)'}`,
          }
        })
      },
    }),
  )

  /* 4. 设计细则 ---------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_playbook',
      description:
        'Load the full playbook for one design command (critique, audit, shape, redesign, bolder, quieter, distill, typeset, layout, colorize, animate, polish, harden, optimize, adapt, adapt.native, onboard, delight, clarify, document, extract, live, generate, init, help, ...). Returns the playbook path and its text so you can follow the real method instead of inventing one.',
      parameters: {
        command: { type: 'string', required: true, description: 'Command name, e.g. "critique" or "adapt.native". Omit-free: use design_engine to list all.' },
        inline: { type: 'boolean', description: 'Include the playbook text (default true, truncated at ~14000 chars).' },
      },
      output: TEXT_OUT,
      async execute(args) {
        return run(() => {
          const hit = resolvePlaybook(config, args.command)
          if (!hit) {
            return {
              ok: false,
              text: `没有 \`${args.command}\` 这条命令。可用：${playbookNames(config).join(', ')}`,
            }
          }
          const size = statSync(hit.file).size
          if (args.inline === false) {
            return { ok: true, text: `${hit.key}\n路径：${hit.file}\n大小：${size} B` }
          }
          const text = readFileSync(hit.file, 'utf8')
          const cap = 14000
          const body = text.length > cap ? `${text.slice(0, cap)}\n\n…（已截断，完整内容读 ${hit.file}）` : text
          return { ok: true, text: `# ${hit.key}（${hit.file}）\n\n${body}` }
        })
      },
    }),
  )

  /* 5. 引擎自检 ---------------------------------------------------------- */
  ctx.tools.register(
    defineTool({
      name: 'design_engine',
      description:
        'Report the design plugin wiring: engine binary path and whether it runs, engine version output, style library size and location, playbook count, and the list of available playbook commands. Use it first when a design tool misbehaves.',
      parameters: {},
      output: TEXT_OUT,
      async execute() {
        return run(() => {
          const engine = resolveEngine(config)
          const rows = styles(config)
          const commands = playbookNames(config)
          const probe = engine ? runEngine(config, ['--version'], undefined) : null
          const lines = [
            `引擎：${engine ? engine.file : '未找到'}`,
            `引擎自检：${probe ? `exit ${probe.exitCode} · ${(probe.output || '(无输出)').split('\n').slice(0, 2).join(' / ')}` : '跳过（无引擎）'}`,
            `skillRoot：${config.skillRoot}${existsSync(config.skillRoot) ? '' : '（目录不存在）'}`,
            `风格库：${config.stylesRoot} · ${rows.length} 套`,
            `细则：${playbookDir(config)} · ${commands.length} 篇`,
            `命令：${commands.join(', ')}`,
            `超时：${config.timeoutMs} ms`,
          ]
          return { ok: Boolean(engine), text: lines.join('\n') }
        })
      },
    }),
  )
}

import { api, sql } from './api'

const DAILY_NAME = /^(\d{4}-\d{2}-\d{2}) 待办$/

/**
 * 清单里的每条「提取来的」任务都会在自身块上记录来源块 id，
 * 这样日志那边改了文字、加了 @延后、勾了完成，清单才能跟着变。
 */
const SOURCE_ATTR = 'custom-todo-source'

export interface Task {
  id: string
  /** 展示用文本，已剥离 @延后 标记 */
  text: string
  done: boolean
  /** 延后到哪天才出现（YYYY-MM-DD） */
  deferUntil?: string
  /** 原始文本（保留 @标记），写回思源时使用 */
  rawText?: string
}

export interface TaskItem extends Task {
  parentId: string
}

export interface DeferredEntry {
  id: string
  text: string
  until: string
}

export interface TodoConfig {
  notebookId: string
  dailyRootId: string
  dailyRootName: string
  worklogRootId: string
  worklogRootName: string
  /** 工作日志根文档的完整路径，用来判断某篇文档是否属于工作日志 */
  worklogRootPath?: string
}

export interface TodayState {
  date: string
  docId: string
  docTitle: string
  tasks: Task[]
  deferred: DeferredEntry[]
  rolledOver: number
  extracted: number
  generated: boolean
  /** 今天还没有清单，且没有值得创建的内容 */
  pendingCreate?: boolean
  /** 同名重复清单的份数（不含主文档） */
  duplicates?: number
}

interface DailyDoc {
  date: string
  id: string
  name: string
}

interface RawBlock {
  id: string
  content?: string
  markdown?: string
  parent_id?: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dailyDocTitle(date: string): string {
  return `${date} 待办`
}

/** 解析思源任务块，兼容 markdown 的 "- [ ] x" 与 content 的 "[ ] x" */
export function parseTaskContent(raw: string): { text: string; done: boolean } | null {
  const source = (raw ?? '').trim()
  const match = source.match(/^(?:[-*+]\s+)?\[([ xX])\]\s*(.*)$/)
  if (!match) return null
  const done = match[1].toLowerCase() === 'x'
  const text = match[2].trim().replace(/\{:\s*[^}]*\}\s*$/, '').trim()
  if (!text) return null
  return { text, done }
}

const DEFER_REGEX = /\s*@(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})-(\d{1,2})|\+(\d{1,3})d)\s*$/

function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** 解析并剥离末尾的 @延后 标记 */
export function parseDeferMark(text: string): { text: string; until?: string } {
  const source = (text ?? '').trim()
  const match = source.match(DEFER_REGEX)
  if (!match) return { text: source }

  const clean = source.slice(0, match.index).trim()
  if (!clean) return { text: source }

  const now = new Date()
  let until: string

  if (match[1]) {
    const month = Number(match[2])
    const day = Number(match[3])
    if (!isValidMonthDay(month, day)) return { text: source }
    until = `${match[1]}-${pad(month)}-${pad(day)}`
  } else if (match[4]) {
    const month = Number(match[4])
    const day = Number(match[5])
    if (!isValidMonthDay(month, day)) return { text: source }
    until = `${now.getFullYear()}-${pad(month)}-${pad(day)}`
  } else {
    const offset = Number(match[6])
    if (offset <= 0 || offset > 365) return { text: source }
    const target = new Date(now)
    target.setDate(target.getDate() + offset)
    until = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`
  }

  return { text: clean, until }
}

function normalizeText(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、,.!?！？:：;；"'“”‘’()（）[\]【】]/g, '')
    .toLowerCase()
}

/** 比较两段任务 markdown 是否等价：忽略尾部块属性、折叠空白 */
export function normalizeMd(md: string): string {
  return (md || '')
    .replace(/\{:[^{}]*\}\s*$/, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
}

function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

function chunked<T>(list: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size))
  return result
}

/** 写回或搬运时保留 @标记 的原始文本 */
function sourceText(task: Task): string {
  return task.rawText ?? task.text
}

/** 延后日期固化成绝对日期，否则 @+5d 每次解析都会往后滚 */
export function taskLineText(task: Task, done: boolean): string {
  const base = task.rawText ? parseDeferMark(task.rawText).text : task.text
  const suffix = !done && task.deferUntil ? ` @${task.deferUntil}` : ''
  return `${base}${suffix}`
}

function splitByDefer<T extends Task>(tasks: T[], today: string) {
  const active: T[] = []
  const deferred: DeferredEntry[] = []
  for (const task of tasks) {
    if (task.deferUntil && task.deferUntil > today) {
      deferred.push({ id: task.id, text: task.text, until: task.deferUntil })
    } else {
      active.push(task)
    }
  }
  return { active, deferred }
}

function mergeDeferred(...groups: DeferredEntry[][]): DeferredEntry[] {
  const seen = new Set<string>()
  const result: DeferredEntry[] = []
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      result.push(item)
    }
  }
  return result.sort((a, b) => a.until.localeCompare(b.until))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * TodoService 每次都是新建实例，锁必须放模块作用域才生效。
 * 页面打开时多个时机（事件、布局就绪、延迟补注入）会同时触发 today()，
 * 没有这把锁就会各自建出一份同名清单。
 */
let todayLock: Promise<TodayState> | null = null

/** 任务块的比较键：剥掉勾选状态与 @延后，只留正文 */
export function taskKey(md: string): string {
  const parsed = parseTaskContent(md || '')
  if (!parsed) return ''
  return normalizeText(parseDeferMark(parsed.text).text)
}

export class TodoService {
  constructor(private readonly cfg: TodoConfig) {}

  private async taskItems(docId: string): Promise<TaskItem[]> {
    const blocks = await sql<RawBlock>(
      `SELECT id, content, markdown, parent_id FROM blocks WHERE root_id = '${docId}' AND subtype = 't' AND type = 'i' ORDER BY sort, created`,
    )
    const items: TaskItem[] = []
    for (const block of blocks) {
      const parsed = parseTaskContent(block.markdown || block.content || '')
      if (!parsed) continue
      const defer = parseDeferMark(parsed.text)
      if (!defer.text) continue
      items.push({
        id: block.id,
        parentId: block.parent_id || '',
        done: parsed.done,
        text: defer.text,
        deferUntil: defer.until,
        rawText: parsed.text,
      })
    }
    return items
  }

  private async listBlockIds(docId: string): Promise<string[]> {
    const rows = await sql<{ id: string }>(
      `SELECT id FROM blocks WHERE root_id = '${docId}' AND type = 'l' AND subtype = 't' ORDER BY sort`,
    )
    return rows.map((row) => row.id)
  }

  /** 工作日志树下所有任务项 */
  private async tasksUnderDoc(rootId: string, limit = 100): Promise<Task[]> {
    const prefix = `/${rootId}`.replace(/'/g, "''")
    const safeLimit = Math.max(1, Math.min(limit, 300))
    const blocks = await sql<RawBlock>(
      `SELECT id, content, markdown FROM blocks WHERE (path = '${prefix}' OR path = '${prefix}.sy' OR path LIKE '${prefix}/%') AND subtype = 't' AND type = 'i' ORDER BY created DESC LIMIT ${safeLimit}`,
    )
    const tasks: Task[] = []
    for (const block of blocks) {
      const parsed = parseTaskContent(block.markdown || block.content || '')
      if (!parsed) continue
      const defer = parseDeferMark(parsed.text)
      if (!defer.text) continue
      tasks.push({
        id: block.id,
        done: parsed.done,
        text: defer.text,
        deferUntil: defer.until,
        rawText: parsed.text,
      })
    }
    return tasks
  }

  private async extractedSourceIds(rootId: string): Promise<Set<string>> {
    const prefix = `/${rootId}`.replace(/'/g, "''")
    const rows = await sql<{ id: string }>(
      `SELECT block_id AS id FROM attributes WHERE name = 'custom-todo-extracted' AND path LIKE '${prefix}%'`,
    )
    return new Set(rows.map((row) => row.id).filter(Boolean))
  }

  /**
   * 列出「每日待办」下的清单文档。
   * 每次按名字重新定位父文档：用户删掉重建「每日待办」后，配置里缓存的旧 id 会失效，
   * 一旦继续用旧 id 查，就永远查不到今天的清单，于是每次进入都新建一份。
   */
  private async dailyDocs(): Promise<DailyDoc[]> {
    try {
      const top = await api<{ files?: Array<{ id: string; name: string }> }>('/api/filetree/listDocsByPath', {
        notebook: this.cfg.notebookId,
        path: '/',
      })
      const topFiles = top?.files ?? []
      const root =
        topFiles.find((file) => file.name === this.cfg.dailyRootName) ??
        topFiles.find((file) => file.id === this.cfg.dailyRootId)
      if (!root) return []

      // 顺手把失效的 id 修正回来，后续调用少一次查找
      this.cfg.dailyRootId = root.id

      const data = await api<{ files?: Array<{ id: string; name: string }> }>('/api/filetree/listDocsByPath', {
        notebook: this.cfg.notebookId,
        path: `/${root.id}`,
      })
      const files = data?.files ?? []
      return files
        .map((file) => {
          const match = file.name.match(DAILY_NAME)
          return match ? { date: match[1], id: file.id, name: file.name } : null
        })
        .filter((doc): doc is DailyDoc => doc !== null)
        .sort((a, b) => a.date.localeCompare(b.date))
    } catch {
      return []
    }
  }

  /** 同一天可能存在多份同名清单（历史并发创建的产物），选任务最多的那份当主文档 */
  private async pickDaily(same: DailyDoc[]): Promise<DailyDoc | undefined> {
    if (same.length <= 1) return same[0]
    let best = same[0]
    let bestCount = -1
    for (const doc of same) {
      const items = await this.taskItems(doc.id)
      if (items.length > bestCount) {
        bestCount = items.length
        best = doc
      }
    }
    return best
  }

  private async collectWorklogTasks(existingTexts: string[], today: string) {
    if (!this.cfg.worklogRootId) {
      return { tasks: [] as Task[], deferred: [] as DeferredEntry[], sourceIds: [] as string[] }
    }

    const candidates = await this.tasksUnderDoc(this.cfg.worklogRootId)
    const extracted = await this.extractedSourceIds(this.cfg.worklogRootId)
    const seen = new Set(existingTexts.map(normalizeText))
    const tasks: Task[] = []
    const deferred: DeferredEntry[] = []
    const sourceIds: string[] = []

    for (const task of candidates) {
      if (task.done || extracted.has(task.id)) continue

      // 未到期只进排队区，不打已提取标记，到期后仍会被提取
      if (task.deferUntil && task.deferUntil > today) {
        const key = normalizeText(task.text)
        if (key && !seen.has(key)) {
          seen.add(key)
          deferred.push({ id: task.id, text: task.text, until: task.deferUntil })
        }
        continue
      }

      sourceIds.push(task.id)
      const key = normalizeText(task.text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      tasks.push(task)
    }

    return { tasks, deferred, sourceIds }
  }

  private async waitForTasks(docId: string, minCount: number): Promise<Task[]> {
    let items = await this.taskItems(docId)
    for (let i = 0; i < 12 && items.length < minCount; i += 1) {
      await sleep(400)
      items = await this.taskItems(docId)
    }
    return items
  }

  /** 在清单里追加一条任务，并把来源块 id 记在副本上 */
  private async appendTask(docId: string, task: Task, sourceId: string): Promise<string> {
    const data = `- [${task.done ? 'x' : ' '}] ${taskLineText(task, task.done)}`
    const res = await api<unknown>('/api/block/appendBlock', {
      parentID: docId,
      data,
      dataType: 'markdown',
    })

    const list = Array.isArray(res) ? res : [res]
    let newId = (list[0] as { doOperations?: Array<{ id?: string }> })?.doOperations?.[0]?.id ?? ''
    if (!newId) {
      // 老版本内核不返回新块 id，按创建时间回查一次，别让同步关系丢失
      const rows = await sql<{ id: string }>(
        `SELECT id FROM blocks WHERE root_id = ${quote(docId)} AND type = 'i' AND subtype = 't' ORDER BY created DESC, sort DESC LIMIT 3`,
      )
      newId = rows[0]?.id ?? ''
    }
    if (newId && sourceId) {
      await api('/api/attr/setBlockAttrs', { id: newId, attrs: { [SOURCE_ATTR]: sourceId } })
    }
    return newId
  }

  /** 副本来自哪个源块；不是提取来的任务返回空串 */
  private async sourceOf(blockId: string): Promise<string> {
    try {
      const rows = await sql<{ value: string }>(
        `SELECT value FROM attributes WHERE block_id = ${quote(blockId)} AND name = '${SOURCE_ATTR}'`,
      )
      return rows[0]?.value ?? ''
    } catch {
      return ''
    }
  }

  private async readTask(blockId: string): Promise<Task | null> {
    const rows = await sql<RawBlock>(
      `SELECT id, markdown, content FROM blocks WHERE id = ${quote(blockId)}`,
    )
    const block = rows[0]
    if (!block) return null
    const parsed = parseTaskContent(block.markdown || block.content || '')
    if (!parsed) return null
    const defer = parseDeferMark(parsed.text)
    if (!defer.text) return null
    return {
      id: block.id,
      text: defer.text,
      done: parsed.done,
      deferUntil: defer.until,
      rawText: parsed.text,
    }
  }

  /**
   * 1.0.2 及更早提取出来的条目没有来源标记，升级后按正文回填一次，
   * 否则这些老条目永远不会跟随日志变化，用户会觉得「改了还是不动」。
   */
  private async backfillSource(docIds: string[]): Promise<void> {
    if (docIds.length === 0 || !this.cfg.worklogRootId) return

    const linkedRows = await sql<{ id: string }>(
      `SELECT block_id AS id FROM attributes WHERE name = '${SOURCE_ATTR}'`,
    )
    const linked = new Set(linkedRows.map((row) => row.id).filter(Boolean))

    const copies = await sql<{ id: string; markdown: string }>(
      `SELECT id, markdown FROM blocks WHERE root_id IN (${docIds.map(quote).join(',')}) AND type = 'i' AND subtype = 't'`,
    )
    const unlinked = copies.filter((row) => !linked.has(row.id))
    if (unlinked.length === 0) return

    const extractedIds = [...(await this.extractedSourceIds(this.cfg.worklogRootId))]
    if (extractedIds.length === 0) return

    const byKey = new Map<string, string[]>()
    for (const chunk of chunked(extractedIds, 100)) {
      const sources = await sql<RawBlock>(
        `SELECT id, markdown FROM blocks WHERE id IN (${chunk.map(quote).join(',')})`,
      )
      for (const source of sources) {
        const key = taskKey(source.markdown || '')
        if (!key) continue
        const bucket = byKey.get(key) ?? []
        bucket.push(source.id)
        byKey.set(key, bucket)
      }
    }

    for (const copy of unlinked) {
      const key = taskKey(copy.markdown || '')
      const bucket = key ? byKey.get(key) : undefined
      // 同正文的源块不止一条时不猜，避免把两条不相干的任务绑在一起
      if (!bucket || bucket.length !== 1) continue
      await api('/api/attr/setBlockAttrs', { id: copy.id, attrs: { [SOURCE_ATTR]: bucket[0] } })
    }
  }

  /**
   * 让清单里「从工作日志提取来」的条目跟源块保持一致。
   * 日志里改文字、加/去 @延后、勾完成、甚至删掉源块，清单里的副本都要跟着变，
   * 否则两边会各说一套（例如日志改成 @11-25 后清单那条还赖在「待办」里）。
   */
  async reconcile(docIds: string[] = []): Promise<number> {
    await this.backfillSource(docIds).catch(() => undefined)

    let rows: Array<{ copyId: string; sourceId: string; copyMd: string }> = []
    try {
      rows = await sql<{ copyId: string; sourceId: string; copyMd: string }>(
        `SELECT a.block_id AS copyId, a.value AS sourceId, b.markdown AS copyMd
           FROM attributes a JOIN blocks b ON a.block_id = b.id
          WHERE a.name = '${SOURCE_ATTR}' AND a.value IS NOT NULL AND a.value != ''`,
      )
    } catch {
      return 0
    }
    if (rows.length === 0) return 0

    const sources = new Map<string, Task>()
    for (const chunk of chunked([...new Set(rows.map((row) => row.sourceId))], 100)) {
      const list = await sql<RawBlock>(
        `SELECT id, markdown, content FROM blocks WHERE id IN (${chunk.map(quote).join(',')})`,
      )
      for (const block of list) {
        const parsed = parseTaskContent(block.markdown || block.content || '')
        if (!parsed) continue
        const defer = parseDeferMark(parsed.text)
        if (!defer.text) continue
        sources.set(block.id, {
          id: block.id,
          text: defer.text,
          done: parsed.done,
          deferUntil: defer.until,
          rawText: parsed.text,
        })
      }
    }

    let changed = 0
    for (const row of rows) {
      const source = sources.get(row.sourceId)

      // 源块没了，副本也没有存在的理由
      if (!source) {
        try {
          await api('/api/block/deleteBlock', { id: row.copyId })
          changed += 1
        } catch {
          /* 已经被手动删掉了 */
        }
        continue
      }

      const expected = `- [${source.done ? 'x' : ' '}] ${taskLineText(source, source.done)}`
      if (normalizeMd(expected) === normalizeMd(row.copyMd)) continue

      await api('/api/block/updateBlock', {
        id: row.copyId,
        data: expected,
        dataType: 'markdown',
      })
      changed += 1
    }
    return changed
  }

  private buildDailyMarkdown(date: string, tasks: Task[], rolledOver: number, extracted: number): string {
    const lines = [`# ${dailyDocTitle(date)}`, '']
    const notes: string[] = []
    if (rolledOver > 0) notes.push(`从昨天结转 ${rolledOver} 项`)
    if (extracted > 0) notes.push(`从工作日志提取 ${extracted} 项`)
    if (notes.length > 0) lines.push(`> ${notes.join(' · ')}`, '')

    // 提取项不在这里写：它们要逐条追加，才能拿到块 id 并记下来源，用于后续同步
    if (tasks.length > 0) {
      lines.push(...tasks.map((task) => `- [ ] ${taskLineText(task, false)}`))
    } else if (extracted === 0) {
      lines.push('> 今天没有待办。可以直接在这篇文档里用 `- [ ] 任务` 添加。')
    }
    lines.push('')
    return lines.join('\n')
  }

  private async removeFromPreviousDoc(docId: string, taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return
    const remove = new Set(taskIds)
    const items = await this.taskItems(docId)
    const listIds = await this.listBlockIds(docId)

    for (const listId of listIds) {
      const own = items.filter((item) => item.parentId === listId)
      if (own.length === 0) continue
      const remaining = own.filter((item) => !remove.has(item.id))
      if (remaining.length > 0) {
        await api('/api/block/updateBlock', {
          id: listId,
          data: remaining.map((item) => `- [${item.done ? 'x' : ' '}] ${taskLineText(item, item.done)}`).join('\n'),
          dataType: 'markdown',
        })
      } else {
        await api('/api/block/deleteBlock', { id: listId })
      }
    }
  }

  /**
   * 生成或读取今天的清单。
   * createWhenEmpty=false 时，没有结转项也没有可提取任务就不创建空文档。
   * 内部有模块级锁：并发调用共享同一次执行，避免同时建出多份同名清单。
   */
  async today(createWhenEmpty = false): Promise<TodayState> {
    if (todayLock) return todayLock
    const run = this.todayInner(createWhenEmpty)
    todayLock = run
    try {
      return await run
    } finally {
      if (todayLock === run) todayLock = null
    }
  }

  private async todayInner(createWhenEmpty: boolean): Promise<TodayState> {
    const date = dateKey()
    const docs = await this.dailyDocs()
    const same = docs.filter((doc) => doc.date === date)
    const existing = await this.pickDaily(same)
    const duplicates = Math.max(0, same.length - 1)

    if (existing) {
      // 打开清单前先跟工作日志对齐一次：日志那边改了 @延后 或文字，这里要立刻反映出来
      await this.reconcile(docs.slice(-7).map((doc) => doc.id)).catch(() => 0)
      const items = await this.taskItems(existing.id)
      const { active, deferred } = splitByDefer(items, date)
      const pending = await this.collectWorklogTasks(
        items.map((task) => task.text),
        date,
      )
      return {
        date,
        docId: existing.id,
        docTitle: existing.name,
        tasks: active,
        deferred: mergeDeferred(deferred, pending.deferred),
        rolledOver: 0,
        extracted: 0,
        generated: false,
        duplicates,
      }
    }

    const earlier = docs.filter((doc) => doc.date < date)
    const previous = earlier.length > 0 ? earlier[earlier.length - 1] : undefined
    const previousItems: TaskItem[] = previous ? await this.taskItems(previous.id) : []
    const pendingItems = previousItems.filter((task) => !task.done)

    const extracted = await this.collectWorklogTasks(
      previousItems.map((task) => task.text),
      date,
    )

    const rolledUnique: Task[] = []
    const seen = new Set<string>()
    for (const task of pendingItems) {
      const key = normalizeText(task.text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      rolledUnique.push({
        id: '',
        text: task.text,
        done: false,
        deferUntil: task.deferUntil,
        rawText: task.rawText,
      })
    }

    const extractTasks = extracted.tasks

    if (rolledUnique.length === 0 && extractTasks.length === 0 && !createWhenEmpty) {
      return {
        date,
        docId: '',
        docTitle: dailyDocTitle(date),
        tasks: [],
        deferred: extracted.deferred,
        rolledOver: 0,
        extracted: 0,
        generated: false,
        pendingCreate: true,
        duplicates,
      }
    }

    const newId = await api<string | { id: string }>('/api/filetree/createDocWithMd', {
      notebook: this.cfg.notebookId,
      path: `/${this.cfg.dailyRootName}/${dailyDocTitle(date)}`,
      markdown: this.buildDailyMarkdown(date, rolledUnique, pendingItems.length, extractTasks.length),
    })
    const docId = typeof newId === 'string' ? newId : newId?.id
    if (!docId) throw new Error('思源未返回新文档 ID')

    await this.waitForTasks(docId, rolledUnique.length)
    for (const task of extractTasks) {
      await this.appendTask(docId, task, task.id)
    }
    const items = await this.waitForTasks(docId, rolledUnique.length + extractTasks.length)
    const { active, deferred } = splitByDefer(items, date)

    // 新文档建好后再动昨天，避免中途失败丢任务
    if (previous && pendingItems.length > 0) {
      await this.removeFromPreviousDoc(
        previous.id,
        pendingItems.map((task) => task.id),
      )
      await api('/api/block/appendBlock', {
        parentID: previous.id,
        data: `> 未完成项已结转至 ${date}`,
        dataType: 'markdown',
      })
    }

    for (const sourceId of extracted.sourceIds) {
      await api('/api/attr/setBlockAttrs', {
        id: sourceId,
        attrs: { 'custom-todo-extracted': date },
      })
    }

    return {
      date,
      docId,
      docTitle: dailyDocTitle(date),
      tasks: active,
      deferred: mergeDeferred(deferred, extracted.deferred),
      rolledOver: pendingItems.length,
      extracted: extracted.tasks.length,
      generated: true,
      duplicates: 0,
    }
  }

  /** 后台自动提取：有内容才建文档，没有就什么都不做 */
  async autoExtract(): Promise<{ created: boolean; extracted: number; docId: string }> {
    const state = await this.today(false)
    if (!state.docId) return { created: false, extracted: 0, docId: '' }
    if (state.generated) return { created: true, extracted: state.extracted, docId: state.docId }

    const synced = await this.syncWorklog()
    return { created: false, extracted: synced.extracted, docId: synced.docId }
  }

  /** 合并同一天的重复清单：任务并入主文档，再删掉多余的 */
  async cleanupDuplicates(): Promise<{ removed: number; merged: number; kept: string }> {
    const date = dateKey()
    const same = (await this.dailyDocs()).filter((doc) => doc.date === date)
    if (same.length <= 1) return { removed: 0, merged: 0, kept: same[0]?.id ?? '' }

    const primary = await this.pickDaily(same)
    if (!primary) return { removed: 0, merged: 0, kept: '' }

    let removed = 0
    let merged = 0

    for (const doc of same) {
      if (doc.id === primary.id) continue

      const items = await this.taskItems(doc.id)
      const pending = items.filter((item) => !item.done)
      if (pending.length > 0) {
        const current = await this.taskItems(primary.id)
        const seen = new Set(current.map((item) => normalizeText(item.text)))
        const add = pending.filter((item) => {
          const key = normalizeText(item.text)
          if (!key || seen.has(key)) return false
          seen.add(key)
          return true
        })
        if (add.length > 0) {
          await api('/api/block/appendBlock', {
            parentID: primary.id,
            data: add.map((item) => `- [ ] ${taskLineText(item, false)}`).join('\n'),
            dataType: 'markdown',
          })
          merged += add.length
        }
      }

      try {
        await api('/api/filetree/removeDocByID', { id: doc.id })
      } catch {
        await api('/api/filetree/removeDoc', { id: doc.id })
      }
      removed += 1
    }

    return { removed, merged, kept: primary.id }
  }

  async toggle(id: string, done: boolean): Promise<void> {
    const state = await this.today()
    const target = state.tasks.find((task) => task.id === id)
    if (!target) throw new Error('任务不存在，或不属于今天的清单')
    await api('/api/block/updateBlock', {
      id,
      data: `- [${done ? 'x' : ' '}] ${taskLineText(target, done)}`,
      dataType: 'markdown',
    })

    // 这条是从工作日志提取来的，就把完成状态写回原块，别出现「清单勾了、日志没勾」
    const sourceId = await this.sourceOf(id)
    if (sourceId) {
      const source = await this.readTask(sourceId)
      if (source) {
        const base = source.rawText ? parseDeferMark(source.rawText).text : source.text
        const suffix = source.deferUntil ? ` @${source.deferUntil}` : ''
        await api('/api/block/updateBlock', {
          id: sourceId,
          data: `- [${done ? 'x' : ' '}] ${base}${suffix}`,
          dataType: 'markdown',
        })
      }
    }
  }

  async defer(id: string, input: string): Promise<string> {
    const state = await this.today()
    const items = await this.taskItems(state.docId)
    const target = items.find((task) => task.id === id)
    if (!target) throw new Error('任务不存在，或不属于今天的清单')

    const until = parseDeferMark(`__defer__ @${input.trim()}`).until
    if (!until) throw new Error('延后日期格式不正确，请用 2026-11-24、11-24 或 +2d')

    const base = parseDeferMark(sourceText(target)).text
    if (!base) throw new Error('任务内容为空，无法延后')

    await api('/api/block/updateBlock', {
      id,
      data: `- [ ] ${base} @${until}`,
      dataType: 'markdown',
    })

    // 从日志提取来的条目，延后日期也要写回原块，否则下次对齐会把副本改回去
    const sourceId = await this.sourceOf(id)
    if (sourceId) {
      const source = await this.readTask(sourceId)
      const sourceBase = source
        ? (source.rawText ? parseDeferMark(source.rawText).text : source.text)
        : ''
      if (sourceBase) {
        await api('/api/block/updateBlock', {
          id: sourceId,
          data: `- [ ] ${sourceBase} @${until}`,
          dataType: 'markdown',
        })
      }
    }
    return until
  }

  /** 把工作日志里新增的 - [ ] 拉进今天的清单（用户点「同步工作日志」时允许建空文档） */
  async syncWorklog(): Promise<TodayState> {
    const state = await this.today(true)
    const current = await this.taskItems(state.docId)
    const extraction = await this.collectWorklogTasks(
      current.map((task) => task.text),
      state.date,
    )

    if (extraction.tasks.length > 0) {
      for (const task of extraction.tasks) {
        await this.appendTask(state.docId, task, task.id)
      }
      await this.waitForTasks(state.docId, current.length + extraction.tasks.length)
    }

    for (const sourceId of extraction.sourceIds) {
      await api('/api/attr/setBlockAttrs', {
        id: sourceId,
        attrs: { 'custom-todo-extracted': state.date },
      })
    }

    const items = await this.taskItems(state.docId)
    const { active, deferred } = splitByDefer(items, state.date)
    return {
      ...state,
      tasks: active,
      deferred: mergeDeferred(deferred, extraction.deferred),
      extracted: state.extracted + extraction.tasks.length,
      generated: state.generated,
    }
  }
}

/** 首次使用时按文档标题自动定位「每日待办」与「工作日志」 */
export async function detectConfig(): Promise<TodoConfig> {
  const data = await api<{ notebooks?: Array<{ id: string; name: string; closed: boolean }> }>(
    '/api/notebook/lsNotebooks',
  )
  const notebooks = (data?.notebooks ?? []).filter((nb) => !nb.closed)

  for (const notebook of notebooks) {
    let files: Array<{ id: string; name: string }> = []
    try {
      const listed = await api<{ files?: Array<{ id: string; name: string }> }>('/api/filetree/listDocsByPath', {
        notebook: notebook.id,
        path: '/',
      })
      files = listed?.files ?? []
    } catch {
      continue
    }
    const daily = files.find((file) => file.name === '每日待办')
    if (!daily) continue
    const worklog = files.find((file) => file.name === '工作日志')
    let worklogPath = ''
    if (worklog) {
      try {
        const hpath = await api<string>('/api/filetree/getHPathByID', { id: worklog.id })
        worklogPath = typeof hpath === 'string' ? hpath : ''
      } catch {
        worklogPath = `/${worklog.name}`
      }
    }
    return {
      notebookId: notebook.id,
      dailyRootId: daily.id,
      dailyRootName: daily.name,
      worklogRootId: worklog ? worklog.id : '',
      worklogRootName: worklog ? worklog.name : '',
      worklogRootPath: worklogPath,
    }
  }

  throw new Error('没有找到名为「每日待办」的文档，请先创建它')
}

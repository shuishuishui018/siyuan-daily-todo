import { api, sql } from './api'

const DAILY_NAME = /^(\d{4}-\d{2}-\d{2}) 待办$/

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

/** 写回或搬运时保留 @标记 的原始文本 */
function sourceText(task: Task): string {
  return task.rawText ?? task.text
}

/** 延后日期固化成绝对日期，否则 @+5d 每次解析都会往后滚 */
function taskLineText(task: Task, done: boolean): string {
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

  private buildDailyMarkdown(date: string, tasks: Task[], rolledOver: number, extracted: number): string {
    const lines = [`# ${dailyDocTitle(date)}`, '']
    const notes: string[] = []
    if (rolledOver > 0) notes.push(`从昨天结转 ${rolledOver} 项`)
    if (extracted > 0) notes.push(`从工作日志提取 ${extracted} 项`)
    if (notes.length > 0) lines.push(`> ${notes.join(' · ')}`, '')

    if (tasks.length > 0) {
      lines.push(...tasks.map((task) => `- [ ] ${taskLineText(task, false)}`))
    } else {
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

    const allTasks: Task[] = [
      ...pendingItems.map((task) => ({
        id: '',
        text: task.text,
        done: false,
        deferUntil: task.deferUntil,
        rawText: task.rawText,
      })),
      ...extracted.tasks,
    ]

    const unique: Task[] = []
    const seen = new Set<string>()
    for (const task of allTasks) {
      const key = normalizeText(task.text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(task)
    }

    if (unique.length === 0 && !createWhenEmpty) {
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
      markdown: this.buildDailyMarkdown(date, unique, pendingItems.length, extracted.tasks.length),
    })
    const docId = typeof newId === 'string' ? newId : newId?.id
    if (!docId) throw new Error('思源未返回新文档 ID')

    const items = await this.waitForTasks(docId, unique.length)
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
      await api('/api/block/appendBlock', {
        parentID: state.docId,
        data: extraction.tasks.map((task) => `- [ ] ${taskLineText(task, false)}`).join('\n'),
        dataType: 'markdown',
      })
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

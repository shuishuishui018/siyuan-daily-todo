import { Dialog, Plugin, showMessage } from 'siyuan'
import { api, sql } from './api'
import css from './styles.css'
import { TodoService, detectConfig, type TodoConfig } from './tasks'
import { TodoPanel } from './ui'

const ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h11"/><path d="M9 12h11"/><path d="M9 19h11"/><path d="m3 5 1.6 1.6L7.2 4"/><path d="m3 12 1.6 1.6L7.2 11"/><circle cx="4.6" cy="19" r="1.6"/></svg>'

const STYLE_ID = 'siyuan-daily-todo-style'

/** 写完日志到内核索引可查之间有时间差，等一会再提取 */
const AUTO_EXTRACT_DELAY = 2500

/** 兜底轮询间隔：只查一个 MAX(updated)，开销可以忽略 */
const POLL_INTERVAL = 15000

export default class DailyTodoPlugin extends Plugin {
  private config: TodoConfig | null = null
  private styleEl: HTMLStyleElement | null = null
  private dialog: Dialog | null = null
  private opening = false
  /** 文档是否属于「每日待办」，避免每次打开都查接口 */
  private belongsCache = new Map<string, boolean>()
  /** 文档是否属于「工作日志」，用来决定要不要自动提取 */
  private worklogCache = new Map<string, boolean>()
  private autoTimer: number | null = null
  private autoRunning = false
  private pollTimer: number | null = null
  private lastStamp = ''

  async onload(): Promise<void> {
    this.injectStyle()

    this.addTopBar({
      icon: ICON,
      title: '每日待办',
      position: 'right',
      callback: () => {
        void this.openPanel()
      },
    })

    this.addCommand({
      langKey: 'openDailyTodo',
      langText: '打开每日待办',
      hotkey: '⌥⌘T',
      callback: () => {
        void this.openPanel()
      },
    })

    // 打开「每日待办」下的文档时，直接在正文顶部渲染清单（手机端比顶栏按钮可靠）
    this.eventBus.on('loaded-protyle-static', (event: { detail?: { protyle?: unknown } }) => {
      void this.injectInline(event?.detail?.protyle)
    })
    this.eventBus.on('switch-protyle', (event: { detail?: { protyle?: unknown } }) => {
      void this.injectInline(event?.detail?.protyle)
    })

    // 日志写保存后自动把 - [ ] 提取到当天清单
    this.eventBus.on('ws-main', (event: unknown) => {
      void this.onTransactions(event)
    })

    // 事件里的 rootID 不一定可靠，再加一道轻量轮询：只看工作日志下任务块的最后修改时间，
    // 变了就提取。查询走 SQLite 索引，开销很小。
    this.startPolling()

  }


  async onunload(): Promise<void> {
    this.styleEl?.remove()
    this.styleEl = null
    this.dialog?.destroy()
    this.dialog = null
    if (this.autoTimer) window.clearTimeout(this.autoTimer)
    this.autoTimer = null
    if (this.pollTimer) window.clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = css as unknown as string
    document.head.appendChild(style)
    this.styleEl = style
  }

  private async resolveConfig(): Promise<TodoConfig> {
    if (this.config) return this.config

    const saved = await this.loadData('config')
    if (saved && typeof saved === 'object' && saved.dailyRootId) {
      const cfg = saved as TodoConfig
      // 旧版本存的配置没有 worklogRootPath，补查一次后写回
      if (cfg.worklogRootId && !cfg.worklogRootPath) {
        try {
          const hpath = await api<string>('/api/filetree/getHPathByID', { id: cfg.worklogRootId })
          cfg.worklogRootPath = typeof hpath === 'string' ? hpath : `/${cfg.worklogRootName}`
        } catch {
          cfg.worklogRootPath = `/${cfg.worklogRootName}`
        }
        await this.saveData('config', cfg)
      }
      this.config = cfg
      return cfg
    }

    const detected = await detectConfig()
    this.config = detected
    await this.saveData('config', detected)
    return detected
  }

  /** 从事务事件里取出被改动的文档 id；有些写入不带 rootID，就把块 id 也一并带出来 */
  private touchedOps(event: unknown): { roots: string[]; ids: string[] } {
    const detail = (event as { detail?: { cmd?: string; data?: unknown } })?.detail
    if (!detail || detail.cmd !== 'transactions') return { roots: [], ids: [] }

    const list = Array.isArray(detail.data) ? detail.data : [detail.data]
    const roots = new Set<string>()
    const ids = new Set<string>()

    for (const tx of list) {
      const ops = (tx as { doOperations?: Array<Record<string, unknown>> })?.doOperations ?? []
      for (const op of ops) {
        const rootId = op?.rootID ?? op?.rootId
        if (typeof rootId === 'string' && rootId) roots.add(rootId)
        const id = op?.id
        if (typeof id === 'string' && id) ids.add(id)
        const parentId = op?.parentID
        if (typeof parentId === 'string' && parentId) ids.add(parentId)
      }
    }

    return { roots: [...roots], ids: [...ids] }
  }

  private async isWorklogDoc(docId: string): Promise<boolean> {
    const cached = this.worklogCache.get(docId)
    if (cached !== undefined) return cached

    let result = false
    try {
      const cfg = await this.resolveConfig()
      if (cfg.worklogRootId && docId !== cfg.worklogRootId) {
        const hpath = await api<string>('/api/filetree/getHPathByID', { id: docId })
        const prefix = cfg.worklogRootPath || `/${cfg.worklogRootName}`
        result = typeof hpath === 'string' && (hpath === prefix || hpath.startsWith(`${prefix}/`))
      }
    } catch {
      result = false
    }
    this.worklogCache.set(docId, result)
    return result
  }

  private async onTransactions(event: unknown): Promise<void> {
    const { roots, ids } = this.touchedOps(event)
    if (roots.length === 0 && ids.length === 0) return

    for (const rootId of roots) {
      if (await this.isWorklogDoc(rootId)) {
        this.scheduleAutoExtract()
        return
      }
    }

    if (ids.length === 0) return

    // 事务里没带 rootID（部分写入就是这样），回查这些块属于哪篇文档
    const quoted = ids
      .slice(0, 20)
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(',')
    try {
      const rows = await sql<{ root_id: string }>(
        `SELECT DISTINCT root_id FROM blocks WHERE id IN (${quoted})`,
      )
      for (const row of rows) {
        if (row.root_id && (await this.isWorklogDoc(row.root_id))) {
          this.scheduleAutoExtract()
          return
        }
      }
    } catch {
      /* 查不到就算了，下一次保存还有机会 */
    }
  }

  private scheduleAutoExtract(): void {
    if (this.autoTimer) window.clearTimeout(this.autoTimer)
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = null
      void this.runAutoExtract()
    }, AUTO_EXTRACT_DELAY)
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = window.setInterval(() => {
      void this.pollWorklog()
    }, POLL_INTERVAL)
    // 启动后先跑一次，补上关机期间在日志里写下的任务
    window.setTimeout(() => {
      void this.pollWorklog(true)
    }, 6000)
  }

  /** 工作日志下任务块的最后修改时间，用来判断有没有新写入 */
  private async worklogStamp(): Promise<string> {
    const cfg = await this.resolveConfig()
    if (!cfg.worklogRootId) return ''
    const prefix = `/${cfg.worklogRootId}`.replace(/'/g, "''")
    const rows = await sql<{ stamp: string | null }>(
      `SELECT MAX(updated) AS stamp FROM blocks WHERE (path = '${prefix}.sy' OR path LIKE '${prefix}/%') AND type = 'i' AND subtype = 't'`,
    )
    return String(rows[0]?.stamp ?? '')
  }

  private async pollWorklog(force = false): Promise<void> {
    if (this.autoRunning) return
    try {
      const stamp = await this.worklogStamp()
      if (!stamp) return
      const changed = stamp !== this.lastStamp
      this.lastStamp = stamp
      if (force || changed) await this.runAutoExtract()
    } catch {
      /* 查询失败下个周期再试 */
    }
  }

  private async runAutoExtract(): Promise<void> {
    if (this.autoRunning) return
    this.autoRunning = true
    try {
      const cfg = await this.resolveConfig()
      if (!cfg.worklogRootId) return
      const service = new TodoService(cfg)
      const result = await service.autoExtract()
      if (result.extracted > 0) {
        showMessage(`已提取 ${result.extracted} 项到今日待办`, 2500)
        document.dispatchEvent(new CustomEvent('dtp-refresh'))
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.message} | ${error.stack || ''}` : String(error)
      ;(window as any).__dtpLastError = `auto: ${message}`
    } finally {
      // 自己写属性/追加块也会产生事务事件，冷却一下避免自触发循环
      window.setTimeout(() => {
        this.autoRunning = false
      }, 1500)
    }
  }

  /** 布局就绪时，对已经打开的文档补一次注入（插件加载可能晚于首个文档渲染） */
  async onLayoutReady(): Promise<void> {
    const tryInject = () => {
      document.querySelectorAll('.protyle').forEach((element) => {
        void this.injectInline({ element })
      })
    }
    tryInject()
    // 文档渲染时机不受控，补两次延迟重试
    setTimeout(tryInject, 1500)
    setTimeout(tryInject, 4000)
  }

  private docIdOf(protyle: any): string {
    return (
      protyle?.background?.id ||
      protyle?.options?.rootId ||
      protyle?.element?.querySelector('.protyle-background')?.getAttribute('data-node-id') ||
      ''
    )
  }

  private async belongsToDaily(docId: string): Promise<boolean> {
    const cached = this.belongsCache.get(docId)
    if (cached !== undefined) return cached

    let result = false
    try {
      const cfg = await this.resolveConfig()
      const hpath = await api<string>('/api/filetree/getHPathByID', { id: docId })
      result = typeof hpath === 'string' && hpath.startsWith(`/${cfg.dailyRootName}`)
    } catch (error) {
      ;(window as any).__dtpLastError =
        'belong: ' + (error instanceof Error ? `${error.message} | ${error.stack || ''}` : String(error))
      result = false
    }
    this.belongsCache.set(docId, result)
    return result
  }

  /** 把清单插到正文最前面；失败也不能影响编辑器本身 */
  private async injectInline(protyle: any): Promise<void> {
    try {
      const element: HTMLElement | undefined = protyle?.element
      if (!element || element.querySelector('.dtp-inline')) return

      const docId = this.docIdOf(protyle)
      if (!docId) return
      if (!(await this.belongsToDaily(docId))) return

      // 必须插在 .protyle-wysiwyg 之外：wysiwyg 的内容会被思源序列化保存，
      // 塞进去会导致「无法保存标题 / 行级内容」错误。
      // 用 wysiwyg 的实际父节点插入，避免 querySelector 跨容器取到别的 protyle 里的节点
      const wysiwyg = element.querySelector('.protyle-wysiwyg')
      const content = wysiwyg?.parentElement
      if (!wysiwyg || !content) return
      if (content.querySelector('.dtp-inline')) return

      const host = document.createElement('div')
      host.className = 'dtp-inline'
      host.setAttribute('contenteditable', 'false')
      const inner = document.createElement('div')
      inner.className = 'dtp-inline__inner'
      host.appendChild(inner)
      content.insertBefore(host, wysiwyg)

      const service = new TodoService(await this.resolveConfig())
      const panel = new TodoPanel(inner, service, this.app)
      await panel.load()
    } catch (error) {
      // 注入失败不影响编辑器，但留个痕迹便于排查
      ;(window as any).__dtpLastError = error instanceof Error ? `${error.message} | ${error.stack || ''}` : String(error)
    }
  }

  private async openPanel(): Promise<void> {
    if (this.opening) return
    this.opening = true

    try {
      let service: TodoService
      try {
        service = new TodoService(await this.resolveConfig())
      } catch (err) {
        showMessage(`初始化失败：${err instanceof Error ? err.message : String(err)}`, 5000, 'error')
        return
      }

      this.dialog?.destroy()
      const dialog = new Dialog({
        title: '每日待办',
        content: '<div class="dtp-host"></div>',
        width: 'min(560px, 94vw)',
        destroyCallback: () => {
          if (this.dialog === dialog) this.dialog = null
        },
      })
      this.dialog = dialog

      const host = dialog.element.querySelector('.dtp-host')
      if (host instanceof HTMLElement) {
        const panel = new TodoPanel(host, service, this.app)
        await panel.load()
      }
    } finally {
      this.opening = false
    }
  }
}

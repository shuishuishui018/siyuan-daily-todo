import { Dialog, Plugin, showMessage } from 'siyuan'
import { api } from './api'
import css from './styles.css'
import { TodoService, detectConfig, type TodoConfig } from './tasks'
import { TodoPanel } from './ui'

const ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h11"/><path d="M9 12h11"/><path d="M9 19h11"/><path d="m3 5 1.6 1.6L7.2 4"/><path d="m3 12 1.6 1.6L7.2 11"/><circle cx="4.6" cy="19" r="1.6"/></svg>'

const STYLE_ID = 'siyuan-daily-todo-style'

export default class DailyTodoPlugin extends Plugin {
  private config: TodoConfig | null = null
  private styleEl: HTMLStyleElement | null = null
  private dialog: Dialog | null = null
  private opening = false
  /** 文档是否属于「每日待办」，避免每次打开都查接口 */
  private belongsCache = new Map<string, boolean>()

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
  }

  async onunload(): Promise<void> {
    this.styleEl?.remove()
    this.styleEl = null
    this.dialog?.destroy()
    this.dialog = null
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
      this.config = saved as TodoConfig
      return this.config
    }

    const detected = await detectConfig()
    this.config = detected
    await this.saveData('config', detected)
    return detected
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

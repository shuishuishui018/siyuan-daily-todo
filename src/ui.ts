import { confirm as syConfirm, openTab, showMessage } from 'siyuan'
import type { TodayState, TodoService } from './tasks'

/** 老版本思源没有导出 confirm，退回浏览器原生确认框 */
type ConfirmFn = (title: string, text: string, confirmText?: string, cancelText?: string) => Promise<boolean>
const askConfirm: ConfirmFn =
  typeof syConfirm === 'function'
    ? syConfirm
    : async (title: string, text: string): Promise<boolean> => window.confirm(`${title}\n\n${text}`)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  const label = Number.isNaN(parsed.getTime()) ? '' : ` ${WEEKDAYS[parsed.getDay()]}`
  return `${date}${label}`
}

function shortDate(date: string): string {
  const parts = date.split('-')
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : date
}

export class TodoPanel {
  private state: TodayState | null = null
  private openDeferId: string | null = null
  private error = ''
  private busy = false

  constructor(
    private readonly root: HTMLElement,
    private readonly service: TodoService,
    private readonly app: unknown,
  ) {
    this.root.classList.add('dtp-wrap')
    this.root.addEventListener('change', (event) => this.onChange(event))
    this.root.addEventListener('click', (event) => this.onClick(event))
    this.root.addEventListener('keydown', (event) => this.onKeyDown(event))
    document.addEventListener('dtp-refresh', this.onRefresh)
    this.render()
  }

  /** 后台自动提取完成后通知面板重读；节点已被移除就顺手解绑 */
  private readonly onRefresh = (): void => {
    if (!this.root.isConnected) {
      document.removeEventListener('dtp-refresh', this.onRefresh)
      return
    }
    void this.load()
  }

  async load(): Promise<void> {
    this.error = ''
    this.render()
    try {
      this.state = await this.service.today()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }
    this.render()
  }

  private html(): string {
    if (this.error) {
      return `<div class="dtp-error">加载失败：${escapeHtml(this.error)}</div>
        <div class="dtp-foot"><button class="dtp-btn" data-act="retry">重试</button></div>`
    }

    if (!this.state) {
      return '<div class="dtp-loading">正在读取今天的清单…</div>'
    }

    const state = this.state
    const pending = state.tasks.filter((task) => !task.done).length
    const done = state.tasks.length - pending

    const notices: string[] = []
    if (state.generated) notices.push('已生成今日清单')
    if (state.rolledOver > 0) notices.push(`从昨天结转 ${state.rolledOver} 项`)
    if (state.extracted > 0) notices.push(`从工作日志提取 ${state.extracted} 项`)

    const noticeHtml =
      notices.length > 0 ? `<div class="dtp-notice">${escapeHtml(notices.join(' · '))}</div>` : ''

    const duplicateHtml =
      (state.duplicates ?? 0) > 0
        ? `<div class="dtp-notice is-warn">有 ${state.duplicates} 份重复的今日清单，建议合并
            <button class="dtp-link" data-act="dedupe">清理</button>
          </div>`
        : ''

    const isEmptyDoc = !state.docId

    const itemsHtml =
      state.tasks.length > 0
        ? state.tasks
            .map((task) => {
              const checked = task.done ? 'checked' : ''
              const doneClass = task.done ? ' is-done' : ''
              const openClass = this.openDeferId === task.id ? ' is-open' : ''
              const deferHtml =
                this.openDeferId === task.id
                  ? `<div class="dtp-defer">
                      <button class="dtp-chip" data-defer="+1d" data-id="${task.id}">明天</button>
                      <button class="dtp-chip" data-defer="+2d" data-id="${task.id}">后天</button>
                      <button class="dtp-chip" data-defer="+7d" data-id="${task.id}">一周后</button>
                      <input class="dtp-chip-input" data-defer-input="${task.id}" placeholder="11-25 或 +3d" />
                    </div>`
                  : ''
              return `<div class="dtp-item${doneClass}">
                  <div class="dtp-row">
                    <input class="dtp-check" type="checkbox" data-id="${task.id}" ${checked} />
                    <div class="dtp-text" data-id="${task.id}">${escapeHtml(task.text)}</div>
                    <button class="dtp-more${openClass}" data-more="${task.id}" title="延后">⋯</button>
                  </div>
                  ${deferHtml}
                </div>`
            })
            .join('')
        : isEmptyDoc
          ? `<div class="dtp-empty">今天还没有待办清单。<br />在工作日志里写 <code>- [ ] 任务</code> 就会自动生成，也可以点下面按钮先建一份空白清单。</div>`
          : `<div class="dtp-empty">今天没有待办。<br />在工作日志里写 <code>- [ ] 任务</code> 会自动出现在这里，也可以直接在这篇文档里写。</div>`

    const deferredHtml =
      state.deferred.length > 0
        ? `<details class="dtp-deferred">
            <summary>排队中 ${state.deferred.length} 项</summary>
            ${state.deferred
              .map(
                (item) => `<div class="dtp-deferred-item">
                  <span>${escapeHtml(item.text)}</span>
                  <span class="dtp-deferred-date">${escapeHtml(shortDate(item.until))}</span>
                </div>`,
              )
              .join('')}
          </details>`
        : ''

    const footHtml = isEmptyDoc
      ? `<div class="dtp-foot">
          <button class="dtp-btn is-primary" data-act="create" ${this.busy ? 'disabled' : ''}>新建今天的清单</button>
        </div>`
      : `<div class="dtp-foot">
          <button class="dtp-btn" data-act="sync" ${this.busy ? 'disabled' : ''}>同步工作日志</button>
          <button class="dtp-btn is-primary" data-act="open">打开文档</button>
        </div>`

    return `<div class="dtp-head">
        <div class="dtp-date">${escapeHtml(formatDate(state.date))}</div>
        <div class="dtp-stat">${pending} 待办 · ${done} 完成</div>
      </div>
      ${noticeHtml}
      ${duplicateHtml}
      <div class="dtp-list">${itemsHtml}</div>
      ${deferredHtml}
      ${footHtml}`
  }

  private render(): void {
    const list = this.root.querySelector('.dtp-list')
    const scrollTop = list instanceof HTMLElement ? list.scrollTop : 0
    this.root.innerHTML = this.html()
    const next = this.root.querySelector('.dtp-list')
    if (next instanceof HTMLElement) next.scrollTop = scrollTop
  }

  private async onChange(event: Event): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('dtp-check')) return
    await this.toggle(target.dataset.id || '', target.checked)
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const moreId = target.dataset.more
    if (moreId) {
      this.openDeferId = this.openDeferId === moreId ? null : moreId
      this.render()
      return
    }

    const deferValue = target.dataset.defer
    if (deferValue) {
      await this.defer(target.dataset.id || '', deferValue)
      return
    }

    const textId = target.closest('.dtp-text')?.getAttribute('data-id')
    if (textId) {
      const current = this.state?.tasks.find((item) => item.id === textId)
      await this.toggle(textId, !current?.done)
      return
    }

    const action = target.dataset.act
    if (action === 'retry') {
      await this.load()
      return
    }
    if (action === 'sync' || action === 'create') {
      await this.sync()
      return
    }
    if (action === 'dedupe') {
      await this.dedupe()
      return
    }
    if (action === 'open') {
      this.openDoc()
    }
  }

  private async dedupe(): Promise<void> {
    const count = this.state?.duplicates ?? 0
    if (count <= 0) return

    const ok = await askConfirm(
      '合并重复清单',
      `保留任务最多的一份，其余 ${count} 份里的未完成任务会合并进来后再删除，是否继续？`,
      '合并',
    )
    if (!ok) return

    try {
      const result = await this.service.cleanupDuplicates()
      showMessage(`已合并 ${result.merged} 项，删除 ${result.removed} 份重复清单`, 3000)
      // 等 SQL 索引追上再重读
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await this.load()
    } catch (err) {
      showMessage(`清理失败：${err instanceof Error ? err.message : String(err)}`, 4000, 'error')
    }
  }

  private async onKeyDown(event: KeyboardEvent): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const id = target.dataset.deferInput
    if (!id || event.key !== 'Enter') return
    event.preventDefault()
    const value = target.value.trim()
    if (!value) return
    await this.defer(id, value)
  }

  private async toggle(id: string, done: boolean): Promise<void> {
    if (!id || !this.state) return
    const task = this.state.tasks.find((item) => item.id === id)
    if (!task) return

    const previous = task.done
    task.done = done
    this.render()

    try {
      await this.service.toggle(id, done)
    } catch (err) {
      task.done = previous
      this.render()
      showMessage(`保存失败：${err instanceof Error ? err.message : String(err)}`, 4000, 'error')
    }
  }

  private async defer(id: string, value: string): Promise<void> {
    if (!id) return
    this.openDeferId = null
    try {
      const until = await this.service.defer(id, value)
      showMessage(`已延后到 ${until}`, 2000)
      // 思源 SQL 索引有 1~2 秒延迟，立刻重读会看到旧状态
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await this.load()
    } catch (err) {
      this.render()
      showMessage(`延后失败：${err instanceof Error ? err.message : String(err)}`, 4000, 'error')
    }
  }

  private async sync(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.render()
    try {
      this.state = await this.service.syncWorklog()
      this.busy = false
      this.render()
      const count = this.state.extracted
      showMessage(
        count > 0
          ? `已从工作日志同步 ${count} 项`
          : this.state.generated
            ? '已新建今天的清单'
            : '工作日志里没有新任务',
        2500,
      )
    } catch (err) {
      this.busy = false
      this.render()
      showMessage(`同步失败：${err instanceof Error ? err.message : String(err)}`, 4000, 'error')
    }
  }

  private openDoc(): void {
    if (!this.state) return
    openTab({ app: this.app, doc: { id: this.state.docId } })
  }
}

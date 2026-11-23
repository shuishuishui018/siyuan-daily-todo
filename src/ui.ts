import { openTab, showMessage } from 'siyuan'
import type { TodayState, TodoService } from './tasks'

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
    this.render()
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
        : `<div class="dtp-empty">今天没有待办。<br />可以在「${escapeHtml(state.docTitle)}」里直接写 <code>- [ ] 任务</code>，或点下方按钮从工作日志同步。</div>`

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

    return `<div class="dtp-head">
        <div class="dtp-date">${escapeHtml(formatDate(state.date))}</div>
        <div class="dtp-stat">${pending} 待办 · ${done} 完成</div>
      </div>
      ${noticeHtml}
      <div class="dtp-list">${itemsHtml}</div>
      ${deferredHtml}
      <div class="dtp-foot">
        <button class="dtp-btn" data-act="sync" ${this.busy ? 'disabled' : ''}>同步工作日志</button>
        <button class="dtp-btn is-primary" data-act="open">打开文档</button>
      </div>`
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
    if (action === 'sync') {
      await this.sync()
      return
    }
    if (action === 'open') {
      this.openDoc()
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
      showMessage(count > 0 ? `已从工作日志同步 ${count} 项` : '工作日志里没有新任务', 2500)
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

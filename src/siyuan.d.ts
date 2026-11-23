declare module 'siyuan' {
  export interface IObject {
    [key: string]: any
  }

  export class Plugin {
    name: string
    app: any
    eventBus: any
    i18n: IObject
    constructor(options: { name: string; app: any; i18n: IObject })
    onload(): void | Promise<void>
    onunload(): void | Promise<void>
    onLayoutReady(): void | Promise<void>
    loadData(key: string): Promise<any>
    saveData(key: string, value: any): Promise<void>
    addTopBar(options: {
      icon: string
      title: string
      position?: 'left' | 'right'
      callback?: () => void
      dragstart?: (event: DragEvent) => void
      dragend?: (event: DragEvent) => void
      drag?: (event: DragEvent) => void
      click?: (event: MouseEvent) => void
    }): HTMLElement
    addCommand(options: {
      langKey: string
      langText?: string
      hotkey?: string
      customHotkey?: string
      callback?: () => void
      editorCallback?: (protyle: any) => void
      globalCallback?: () => void
    }): void
    addIcons(svg: string): void
  }

  export class Dialog {
    element: HTMLElement
    constructor(options: {
      title?: string
      content?: string
      width?: string
      height?: string
      transparent?: boolean
      destroyCallback?: () => void
      disableClose?: boolean
      hideCloseIcon?: boolean
    })
    destroy(): void
  }

  export function showMessage(message: string, timeout?: number, type?: 'info' | 'error'): void
  export function openTab(options: {
    app: any
    doc?: { id: string; zoomIn?: boolean; action?: string[] }
    afterOpen?: () => void
  }): void
  export function fetchSyncPost(url: string, data?: IObject): Promise<any>
}

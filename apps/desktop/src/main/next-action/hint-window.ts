import { BrowserWindow, globalShortcut, ipcMain, powerMonitor, screen, type IpcMainEvent } from 'electron'
import { HintStateMachine, NextTargetRegistry, type HintContext, type InputActivity } from '@memo/next-action'
import type { NextTarget } from '@memo/contracts'
import { isTrustedPage, isTrustedSender } from '../security'

export interface HintPresentation {
  context: HintContext
  target: NextTarget
  token: string
}
/** Independent nonactivating host. No pet dependency and no model-supplied actions. */
export class NextActionHintWindow {
  private window: BrowserWindow | null = null
  private state: HintStateMachine | null = null
  private current: HintPresentation | null = null
  private lease: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  private loaded = false
  private readyResolve: (() => void) | null = null
  private disposed = false
  private inputState: InputActivity = { known: false, composing: false, lastInputAt: 0 }
  private valid: () => boolean = () => false
  constructor(private options: { pageURL: string; preload: string; registry: NextTargetRegistry; now?: () => number }) {
    ipcMain.on('next-hint:ready', this.readyMessage)
    ipcMain.on('next-hint:confirm', this.confirmMessage)
    ipcMain.on('next-hint:dismiss', this.dismissMessage)
    powerMonitor.on('lock-screen', this.invalidate)
    powerMonitor.on('suspend', this.invalidate)
  }
  private now = () => (this.options.now ?? Date.now)()
  private trusted(event: IpcMainEvent): boolean {
    return isTrustedSender(event, this.window?.webContents ?? null, this.options.pageURL)
  }
  private readyMessage = (event: IpcMainEvent) => { if (this.trusted(event)) this.readyResolve?.() }
  private confirmMessage = (event: IpcMainEvent, id: unknown) => {
    if (this.trusted(event) && typeof id === 'string' && id === this.current?.context.id) void this.confirm()
  }
  private dismissMessage = (event: IpcMainEvent, id: unknown) => {
    if (this.trusted(event) && typeof id === 'string' && id === this.current?.context.id) this.dismiss()
  }
  private invalidate = () => { this.options.registry.invalidate(); this.dismiss() }
  private release(): void {
    if (this.lease) { globalShortcut.unregister(this.lease); this.lease = null }
  }
  async present(presentation: HintPresentation, isCurrent: () => boolean): Promise<boolean> {
    if (this.disposed || this.current || this.exitTimer || !isCurrent() || presentation.target.id !== presentation.context.targetId ||
        presentation.target.revision !== presentation.context.targetRevision) return false
    // Bare Tab is deliberately unavailable until a tested native input/IME lease provider exists.
    // Never advertise a Tab keycap backed by globalShortcut or a focused-window key handler.
    if (presentation.context.shortcut === 'Tab') return false
    this.current = structuredClone(presentation)
    this.state = new HintStateMachine(this.current.context)
    this.valid = isCurrent
    if (!this.window) {
      this.window = new BrowserWindow({ width: 360, height: 72, show: false, frame: false, transparent: true,
        resizable: false, movable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true,
        hasShadow: false, webPreferences: { preload: this.options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      this.window.webContents.on('will-navigate', (event, url) => { if (!isTrustedPage(url, this.options.pageURL)) event.preventDefault() })
      this.window.webContents.on('will-attach-webview', event => event.preventDefault())
      this.window.webContents.on('render-process-gone', this.invalidate)
      this.window.on('closed', () => { this.window = null; this.loaded = false; this.invalidate() })
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      const rendererReady = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve
        readyTimer = setTimeout(() => reject(Error('NEXT_RENDERER_UNAVAILABLE')), 5000)
      })
      try { await Promise.all([this.window.loadURL(this.options.pageURL), rendererReady]); this.loaded = true }
      catch { this.dismiss(); return false }
      finally { clearTimeout(readyTimer); this.readyResolve = null }
    }
    if (this.disposed || !this.loaded || !this.current || !this.valid()) { this.dismiss(); return false }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    this.window.setPosition(workArea.x + 16, workArea.y + 16, false)
    this.tick()
    if (this.state?.phase !== 'visible') { this.dismiss(); return false }
    this.timer = setInterval(() => this.tick(), 50)
    return true
  }
  private tick(): void {
    const state = this.state
    if (!state || !this.current || !this.window || !this.valid()) { this.dismiss(); return }
    state.tick(this.now())
    if (state.phase === 'dismissed') { this.dismiss(); return }
    if (state.phase !== 'visible') {
      const shortcut = state.context.shortcut
      if (shortcut !== 'click' && !this.lease) {
        // Unknown input/composition state is not safe for an OS-wide key lease.
        if (!this.inputState.known || this.inputState.composing) return
        if (!globalShortcut.register(shortcut, () => void this.confirm())) return
        this.lease = shortcut
      }
      if (!state.ready(this.now(), this.inputState, shortcut === 'click' || this.lease !== null)) { this.release(); return }
      this.window.webContents.send('next-hint:show', {
        id: state.context.id, label: this.current.target.kind === 'open-app' ? `打开 ${this.current.target.label}` : this.current.target.label,
        keycap: shortcut === 'click' ? null : shortcut, durationMs: state.deadline - this.now(),
      })
      this.window.showInactive()
    }
  }
  /** Ephemeral native signal only. Never persisted or passed to the model. */
  input(activity: InputActivity): void {
    this.inputState = { ...activity }
    if (!activity.known || activity.composing) { this.release(); this.dismiss() }
  }
  private async confirm(): Promise<void> {
    const c = this.current
    if (!c) return
    if (!this.valid()) { this.dismiss(); return }
    if (!this.state?.confirm(this.now(), c.context)) return
    this.release()
    this.hide()
    await this.options.registry.confirm(c.token, this.now)
  }
  dismiss(): void { this.state?.dismiss(); this.release(); this.hide() }
  private hide(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.current) return
    this.current = null
    this.window?.webContents.send('next-hint:hide')
    this.exitTimer = setTimeout(() => { this.window?.hide(); this.exitTimer = null }, 180)
  }
  dispose(): void {
    this.disposed = true
    this.options.registry.invalidate()
    this.dismiss()
    if (this.exitTimer) clearTimeout(this.exitTimer)
    ipcMain.removeListener('next-hint:ready', this.readyMessage)
    ipcMain.removeListener('next-hint:confirm', this.confirmMessage)
    ipcMain.removeListener('next-hint:dismiss', this.dismissMessage)
    powerMonitor.removeListener('lock-screen', this.invalidate)
    powerMonitor.removeListener('suspend', this.invalidate)
    this.window?.destroy()
    this.window = null
  }
}

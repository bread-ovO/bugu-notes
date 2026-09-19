import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { InputActivity } from '@memo/next-action'
export type NativeCapability = {
  foreground: boolean
  input: boolean
  tab: boolean
  reason: string
}
export type NativeSignal =
  | { type: 'visible-set'; ids: number[] }
  | { type: 'visible'; recordId: number }
  | { type: 'foreground'; app: string }
  | { type: 'input'; activity: InputActivity }
  | { type: 'locked' }
export class NativeNextObserver {
  capability: NativeCapability = {
    foreground: false,
    input: false,
    tab: false,
    reason: '系统观察未开启',
  }
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: {
    id: string
    resolve: (ok: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private watched = ''
  private confirm: ((id: string) => void) | null = null
  constructor(
    private executable: string,
    private onSignal: (signal: NativeSignal) => void,
  ) {}
  start(permission = false) {
    this.stop()
    if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
      this.capability = {
        foreground: false,
        input: false,
        tab: false,
        reason:
          process.env.XDG_SESSION_TYPE === 'wayland'
            ? 'Wayland 不开放跨应用输入状态；使用 BUGU 内记录与浏览器授权对象，仅点击确认'
            : '当前 Linux 桌面不提供可靠输入状态；使用已授权对象，仅点击确认',
      }
      return
    }
    const child = spawn(this.executable, permission ? ['--permission'] : [], {
      stdio: 'pipe',
      windowsHide: true,
    })
    this.child = child
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (this.child !== child || line.length > 2048) return
      try {
        const v = JSON.parse(line) as Record<string, unknown>
        if (
          v.type === 'capability' &&
          ['foreground', 'input', 'tab'].every(
            (k) => typeof v[k] === 'boolean',
          ) &&
          typeof v.reason === 'string'
        )
          this.capability = {
            foreground: v.foreground as boolean,
            input: v.input as boolean,
            tab: v.tab as boolean,
            reason: v.reason.slice(0, 200),
          }
        if (
          v.type === 'input' &&
          typeof v.known === 'boolean' &&
          typeof v.composing === 'boolean' &&
          typeof v.lastInputAt === 'number' &&
          Number.isFinite(v.lastInputAt)
        )
          this.onSignal({
            type: 'input',
            activity: {
              known: v.known,
              composing: v.composing,
              lastInputAt: Math.min(Date.now(), v.lastInputAt),
            },
          })
        if (
          v.type === 'foreground' &&
          typeof v.app === 'string' &&
          v.app.length <= 256
        )
          this.onSignal({ type: 'foreground', app: v.app })
        if (
          v.type === 'visible-set' &&
          Array.isArray(v.ids) &&
          v.ids.length <= 40 &&
          v.ids.every((n) => Number.isSafeInteger(n) && n > 0)
        )
          this.onSignal({ type: 'visible-set', ids: v.ids as number[] })
        if (
          v.type === 'visible' &&
          Number.isSafeInteger(v.recordId) &&
          Number(v.recordId) > 0
        )
          this.onSignal({ type: 'visible', recordId: Number(v.recordId) })
        if (v.type === 'locked') this.onSignal({ type: 'locked' })
        if (v.type === 'armed' && this.pending && this.pending.id === v.id) {
          clearTimeout(this.pending.timer)
          this.pending.resolve(true)
          this.pending = null
        }
        if (v.type === 'confirm' && typeof v.id === 'string')
          this.confirm?.(v.id)
      } catch {
        /* malformed native output never becomes input state */
      }
    })
    const gone = () => {
      if (this.child !== child) return
      this.child = null
      this.release()
      this.capability = {
        foreground: false,
        input: false,
        tab: false,
        reason: '系统观察不可用；已释放快捷键',
      }
      this.onSignal({ type: 'locked' })
    }
    child.once('error', gone)
    child.once('exit', gone)
  }
  watch(candidates: Array<{ recordId: number; app: string; text: string }>) {
    const encoded = JSON.stringify(candidates)
    if (
      encoded === this.watched ||
      !this.child ||
      Buffer.byteLength(encoded) > 60000
    )
      return
    this.watched = encoded
    if (process.platform === 'win32') {
      this.child.stdin.write('clearwatch\n')
      for (const c of candidates)
        this.child.stdin.write(
          `watch ${c.recordId} ${Buffer.from(c.app).toString('hex')} ${Buffer.from(c.text).toString('hex')}\n`,
        )
      this.child.stdin.write('commitwatch\n')
    } else this.child.stdin.write(`watch ${encoded}\n`)
  }
  arm(
    id: string,
    deadline: number,
    onConfirm: (id: string) => void,
  ): Promise<boolean> {
    this.release()
    if (
      !this.child ||
      !this.capability.tab ||
      !/^[-a-zA-Z0-9]{1,100}$/.test(id) ||
      deadline <= Date.now() ||
      deadline > Date.now() + 8000
    )
      return Promise.resolve(false)
    this.confirm = onConfirm
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = null
          this.release()
          resolve(false)
        }
      }, 300)
      this.pending = { id, resolve, timer }
      this.child!.stdin.write(`arm ${id} ${deadline}\n`)
    })
  }
  release() {
    this.child?.stdin.write('release\n')
    this.confirm = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.resolve(false)
      this.pending = null
    }
  }
  stop() {
    this.watched = ''
    this.release()
    const c = this.child
    this.child = null
    c?.stdin.end()
    c?.kill()
    this.capability = {
      foreground: false,
      input: false,
      tab: false,
      reason: '系统观察未开启',
    }
  }
}

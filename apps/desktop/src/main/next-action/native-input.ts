import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
    deadline: number
    resolve: (ok: boolean) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private lease: { id: string; deadline: number } | null = null
  private watched = ''
  private watchIds = new Set<number>()
  private enabled = false
  private failures = 0
  private restart: ReturnType<typeof setTimeout> | null = null
  private confirm: ((id: string) => void) | null = null
  constructor(
    private executable: string,
    private onSignal: (signal: NativeSignal) => void,
  ) {}
  start(permission = false) {
    this.stop()
    this.enabled = true
    this.failures = 0
    this.launch(permission)
  }
  private launch(permission: boolean) {
    if (!this.enabled) return
    if (
      process.platform === 'linux' &&
      process.env.XDG_SESSION_TYPE === 'wayland'
    ) {
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
    child.stdin.on('error', () => gone())
    let buffer = ''
    const lineReceived = (line: string) => {
      if (this.child !== child || line.length > 2048) return
      try {
        const v = JSON.parse(line) as Record<string, unknown>
        if (
          v.type === 'capability' &&
          ['foreground', 'input', 'tab'].every(
            (k) => typeof v[k] === 'boolean',
          ) &&
          typeof v.reason === 'string'
        ) {
          if (
            (!v.input && this.capability.input) ||
            (!v.foreground && this.capability.foreground) ||
            (!v.tab && this.capability.tab)
          ) {
            this.release()
            this.onSignal({ type: 'locked' })
          }
          this.capability = {
            foreground: v.foreground as boolean,
            input: v.input as boolean,
            tab: v.tab as boolean,
            reason: v.reason.slice(0, 200),
          }
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
          v.ids.every(
            (n) => Number.isSafeInteger(n) && this.watchIds.has(n as number),
          )
        )
          this.onSignal({ type: 'visible-set', ids: v.ids as number[] })
        if (
          v.type === 'visible' &&
          Number.isSafeInteger(v.recordId) &&
          this.watchIds.has(Number(v.recordId))
        )
          this.onSignal({ type: 'visible', recordId: Number(v.recordId) })
        if (v.type === 'locked') {
          this.release()
          this.onSignal({ type: 'locked' })
        }
        if (v.type === 'armed' && this.pending && this.pending.id === v.id) {
          clearTimeout(this.pending.timer)
          this.lease = { id: this.pending.id, deadline: this.pending.deadline }
          this.pending.resolve(true)
          this.pending = null
        }
        if (
          v.type === 'confirm' &&
          this.lease &&
          this.lease.id === v.id &&
          Date.now() < this.lease.deadline
        ) {
          const confirm = this.confirm
          this.release()
          confirm?.(v.id as string)
        }
      } catch {
        /* malformed native output never becomes input state */
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      buffer += chunk.toString('utf8')
      // A malformed helper cannot create an unbounded readline buffer.
      if (Buffer.byteLength(buffer) > 65536) {
        gone()
        return
      }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        lineReceived(line)
      }
    })
    const gone = () => {
      if (this.child !== child) return
      this.child = null
      child.kill()
      this.watched = ''
      this.watchIds.clear()
      this.release()
      this.capability = {
        foreground: false,
        input: false,
        tab: false,
        reason: '系统观察不可用；已释放快捷键',
      }
      this.onSignal({ type: 'locked' })
      if (this.enabled && this.failures < 3) {
        const delay = [1000, 3000, 10000][this.failures++]!
        this.restart = setTimeout(() => {
          this.restart = null
          this.launch(false)
        }, delay)
        this.restart.unref()
      }
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
    this.watchIds = new Set(candidates.map((c) => c.recordId))
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
      this.pending = { id, deadline, resolve, timer }
      this.child!.stdin.write(`arm ${id} ${deadline}\n`)
    })
  }
  release() {
    this.lease = null
    this.child?.stdin.write('release\n')
    this.confirm = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.resolve(false)
      this.pending = null
    }
  }
  stop() {
    this.enabled = false
    if (this.restart) clearTimeout(this.restart)
    this.restart = null
    this.watched = ''
    this.watchIds.clear()
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

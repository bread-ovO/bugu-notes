import { dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  CoreReply,
  HostRequest,
  CoreRequest,
  NextWorkbench,
  NextTarget,
} from '@memo/contracts'
import { NextTargetRegistry } from '@memo/next-action'
import { NextActionHintWindow } from './hint-window'
import { NativeNextObserver } from './native-input'
import { BrowserContextBridge } from './browser-bridge'
import {
  installedTools,
  launchInstalled,
  validateCustomTool,
  type InstalledTool,
} from './app-catalog'

type Request = (request: HostRequest) => Promise<CoreReply<unknown>>
export class NextActionRuntime {
  private registry = new NextTargetRegistry()
  private hint: NextActionHintWindow
  private observer: NativeNextObserver
  private browser: BrowserContextBridge
  private timer: ReturnType<typeof setInterval> | null = null
  private tools: InstalledTool[] = []
  private state: NextWorkbench | null = null
  private seen = new Set<string>()
  private pending = false
  private observing = false
  private foreground = ''
  private foregroundRevision = 0
  private browserRevision = 0
  private observed = new Map<
    number,
    { revision: number; origin: 'native' | 'explicit' | 'browser' }
  >()
  private activeLaunch = false
  private disposed = false
  constructor(
    private options: {
      request: Request
      data: string
      nativeDirectory: string
      extensionDirectory: string
      pageURL: string
      preload: string
      window: () => BrowserWindow | null
      catalog?: () => Promise<InstalledTool[]>
      launch?: (tool: InstalledTool) => Promise<'dispatched' | 'failed'>
    },
  ) {
    this.observer = new NativeNextObserver(
      join(
        options.nativeDirectory,
        `next-action-observer${process.platform === 'win32' ? '.exe' : ''}`,
      ),
      (signal) => {
        if (signal.type === 'visible-set')
          for (const [id, binding] of this.observed)
            if (binding.origin === 'native' && !signal.ids.includes(id))
              this.observed.delete(id)
        if (
          signal.type === 'visible' &&
          this.state?.settings.enabled &&
          this.state.observation.enabled
        ) {
          this.observed.set(signal.recordId, {
            revision: this.foregroundRevision,
            origin: 'native',
          })
          void this.options.request({
            method: 'nextActionHost.visible',
            recordId: signal.recordId,
          })
        }
        if (signal.type === 'input') this.hint.input(signal.activity)
        if (signal.type === 'locked') {
          this.foregroundRevision++
          this.observed.clear()
          this.registry.invalidate()
          this.hint.dismiss()
        }
        if (signal.type === 'foreground' && this.foreground !== signal.app) {
          this.foreground = signal.app
          this.foregroundRevision++
          this.observed.clear()
          this.registry.invalidate()
          this.hint.dismiss()
        }
      },
    )
    this.hint = new NextActionHintWindow({
      pageURL: options.pageURL,
      preload: options.preload,
      registry: this.registry,
      native: this.observer,
    })
    this.browser = new BrowserContextBridge(
      options.data,
      options.extensionDirectory,
      join(
        options.nativeDirectory,
        `next-action-browser-host${process.platform === 'win32' ? '.exe' : ''}`,
      ),
      (url) => {
        const browserRevision = ++this.browserRevision
        for (const [id, binding] of this.observed)
          if (binding.origin === 'browser') this.observed.delete(id)
        if (
          url &&
          this.state?.settings.enabled &&
          this.state.observation.enabled
        ) {
          const revision = this.foregroundRevision
          void options
            .request({
              method: 'nextActionHost.page',
              url,
              visibility: 'visible-object',
            })
            .then((result) => {
              if (
                result.ok &&
                revision === this.foregroundRevision &&
                browserRevision === this.browserRevision
              ) {
                const recordId = (result.data as NextWorkbench).observedRecordId
                if (recordId)
                  this.observed.set(recordId, { revision, origin: 'browser' })
              }
            })
        }
      },
    )
  }
  async start() {
    this.tools = await (this.options.catalog ?? installedTools)()
    try {
      const paths = JSON.parse(
        await readFile(
          join(this.options.data, 'next-action-apps.json'),
          'utf8',
        ),
      ) as unknown
      if (Array.isArray(paths))
        for (const path of paths.slice(0, 24)) {
          if (typeof path === 'string')
            try {
              const tool = await validateCustomTool(path)
              if (!this.tools.some((t) => t.id === tool.id))
                this.tools.push(tool)
            } catch {
              /* removed app */
            }
        }
    } catch {
      /* first run */
    }
    await this.browser.resume()
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref()
    await this.tick()
  }
  private async read(): Promise<NextWorkbench | null> {
    const result = await this.options.request({
      method: 'nextAction.workbench',
    })
    if (!result.ok) return null
    const data = result.data as NextWorkbench
    this.state = data
    const shouldObserve = data.settings.enabled && data.observation.enabled
    if (shouldObserve !== this.observing) {
      this.observing = shouldObserve
      if (shouldObserve) this.observer.start()
      else {
        this.observer.stop()
        this.registry.invalidate()
        this.hint.dismiss()
      }
    }
    return { ...data, capability: this.observer.capability }
  }
  private async tick() {
    if (this.pending || this.disposed) return
    this.pending = true
    try {
      await this.options.request({
        method: 'nextActionHost.targets',
        targets: this.tools.map((t) => ({ id: t.id, label: t.label })),
      })
      const s = await this.read()
      if (s?.settings.enabled && s.observation.enabled) {
        const candidates = await this.options.request({
          method: 'nextActionHost.candidates',
        })
        if (candidates.ok)
          this.observer.watch(
            (
              candidates.data as Array<{
                recordId: number
                appId: string
                text: string
              }>
            ).flatMap((c) => {
              const tool = this.tools.find((t) => t.id === c.appId)
              return tool
                ? [{ recordId: c.recordId, app: tool.identity, text: c.text }]
                : []
            }),
          )
      }
      if (
        !s?.settings.enabled ||
        !s.settings.proactive ||
        !s.observation.enabled ||
        !this.observer.capability.input
      )
        return
      const suggestion = s.suggestions.find(
        (x) =>
          x.state === 'offered' &&
          x.expiresAt > Date.now() &&
          !this.seen.has(x.id),
      )
      if (!suggestion) return
      const event = s.events.find((e) => e.id === suggestion.eventId)
      const target = event?.targets.find((t) => t.id === suggestion.targetId)
      if (
        !target ||
        !event ||
        this.observed.get(event.recordId)?.revision !== this.foregroundRevision
      )
        return
      if (this.seen.size >= 1000) this.seen.clear()
      this.seen.add(suggestion.id)
      const revision = this.foregroundRevision
      const version = s.version
      this.registry.clear()
      this.register(suggestion.eventId, target, suggestion.id)
      const token = randomUUID()
      this.registry.issue(token, target, suggestion.expiresAt, Date.now())
      const shortcut =
        s.settings.shortcut === 'Tab' && !this.observer.capability.tab
          ? 'click'
          : s.settings.shortcut
      await this.hint.present(
        {
          target,
          token,
          context: {
            id: suggestion.id,
            targetId: target.id,
            targetRevision: target.revision,
            contextRevision: version,
            shortcutRevision: version,
            validUntil: suggestion.expiresAt,
            durationMs: s.settings.durationMs,
            shortcut,
          },
        },
        () =>
          !this.disposed &&
          this.state?.version === version &&
          this.foregroundRevision === revision &&
          this.observed.get(event.recordId)?.revision === revision &&
          !!this.state.settings.enabled &&
          this.state.observation.enabled,
      )
    } catch {
      /* Core restart or withdrawn grants simply stop presenting. */
    } finally {
      this.pending = false
    }
  }
  private register(eventId: string, target: NextTarget, suggestionId?: string) {
    this.registry.register({
      target,
      available: async () => {
        const state = await this.read()
        return (
          !!state?.settings.enabled &&
          state.events.some(
            (e) =>
              e.id === eventId &&
              e.targets.some(
                (t) => t.id === target.id && t.revision === target.revision,
              ),
          ) &&
          (target.kind === 'open-object' ||
            this.tools.some((t) => t.id === target.toolId))
        )
      },
      open: async () => {
        const checked = await this.options.request({
          method: 'nextActionHost.target',
          eventId,
          targetId: target.id,
        })
        if (!checked.ok) return { state: 'failed' }
        const descriptor = checked.data as {
          target: NextTarget
          url?: string
          taskId?: string
          projectId?: string
        }
        if (descriptor.target.revision !== target.revision)
          return { state: 'failed' }
        let result: 'dispatched' | 'failed' = 'failed'
        if (descriptor.url) {
          try {
            const url = new URL(descriptor.url)
            if (
              url.origin === 'https://github.com' &&
              /^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url.pathname)
            ) {
              await shell.openExternal(url.href)
              result = 'dispatched'
            }
          } catch {
            /* target unavailable */
          }
        } else if (descriptor.taskId && descriptor.projectId) {
          const window = this.options.window()
          if (window && !window.isDestroyed()) {
            window.webContents.send('memo:open-task', {
              taskId: descriptor.taskId,
              projectId: descriptor.projectId,
            })
            window.show()
            window.focus()
            result = 'dispatched'
          }
        } else {
          const tool = this.tools.find((t) => t.id === target.toolId)
          if (tool)
            result = await (this.options.launch ?? launchInstalled)(tool)
        }
        await this.options.request({
          method: 'nextActionHost.chosen',
          eventId,
          targetId: target.id,
          result,
          origin: suggestionId ? 'suggestion' : 'explicit',
          ...(suggestionId ? { suggestionId } : {}),
        })
        return { state: result }
      },
    })
  }
  async handle(
    request: Extract<CoreRequest, { method: `nextAction.${string}` }>,
  ): Promise<CoreReply<unknown>> {
    try {
      if (request.method === 'nextAction.browserRemove') {
        await this.browser.uninstall()
        this.observed.clear()
        this.hint.dismiss()
        return { ok: true, data: await this.read() }
      }
      if (request.method === 'nextAction.diagnostics') {
        const state = await this.read(),
          window = this.options.window()
        if (!state || !window) throw Error('NEXT_UNAVAILABLE')
        const result = await dialog.showSaveDialog(window, {
          title: '导出事件学习诊断',
          defaultPath: 'BUGU-next-action-diagnostics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (result.canceled || !result.filePath)
          return { ok: true, data: { saved: false } }
        await writeFile(
          result.filePath,
          JSON.stringify(
            {
              version: 1,
              platform: process.platform,
              arch: process.arch,
              electron: process.versions.electron,
              capability: this.observer.capability,
              enabled: state.settings.enabled,
              proactive: state.settings.proactive,
              sourceCount: state.sources.filter((s) => s.selected).length,
              eventCount: state.events.length,
              suggestionCount: state.suggestions.length,
              busy: state.busy,
              error: state.error,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        )
        return { ok: true, data: { saved: true } }
      }
      if (request.method === 'nextAction.addApplication')
        return { ok: true, data: await this.addApplication() }
      if (request.method === 'nextAction.browserSetup') {
        const result = await this.browser.install()
        await shell.openPath(result.directory)
        return { ok: true, data: result }
      }
      if (request.method === 'nextAction.permission') {
        if (!this.state?.settings.enabled || !this.state.observation.enabled)
          return { ok: false, error: 'INVALID_REQUEST' }
        this.observer.start(true)
        return { ok: true, data: await this.read() }
      }
      if (request.method === 'nextAction.choose') {
        if (this.activeLaunch) return { ok: false, error: 'INVALID_REQUEST' }
        this.activeLaunch = true
        try {
          const s = await this.read()
          const event = s?.events.find((e) => e.id === request.eventId)
          const target = event?.targets.find((t) => t.id === request.targetId)
          if (!s?.settings.enabled || !event || !target)
            throw Error('NEXT_INVALID_TARGET')
          if (
            request.suggestionId &&
            !s.suggestions.some(
              (x) =>
                x.id === request.suggestionId &&
                x.eventId === event.id &&
                x.targetId === target.id &&
                x.state === 'offered',
            )
          )
            throw Error('NEXT_INVALID_TARGET')
          this.hint.dismiss()
          this.registry.clear()
          this.register(event.id, target, request.suggestionId)
          const token = randomUUID()
          this.registry.issue(token, target, Date.now() + 5000, Date.now())
          const result = await this.registry.confirm(token, Date.now)
          const data = await this.read()
          if (!data || result.state === 'failed')
            return { ok: false, error: 'INVALID_REQUEST' }
          return { ok: true, data }
        } finally {
          this.activeLaunch = false
        }
      }
      if (request.method === 'nextAction.inspect')
        this.observed.set(request.recordId, {
          revision: this.foregroundRevision,
          origin: 'explicit',
        })
      const reply = await this.options.request(request)
      if (
        request.method !== 'nextAction.workbench' &&
        request.method !== 'nextAction.status'
      ) {
        this.registry.invalidate()
        this.hint.dismiss()
        await this.read()
      }
      if (request.method === 'nextAction.workbench' && reply.ok) {
        this.state = reply.data as NextWorkbench
        return {
          ok: true,
          data: { ...this.state, capability: this.observer.capability },
        }
      }
      return reply
    } catch {
      return { ok: false, error: 'INVALID_REQUEST' }
    }
  }
  async addApplication() {
    const window = this.options.window()
    if (!window) throw Error('NEXT_UNAVAILABLE')
    const result = await dialog.showOpenDialog(window, {
      title: '选择允许打开的应用',
      properties: ['openFile'],
      ...(process.platform === 'darwin'
        ? { defaultPath: '/Applications' }
        : {}),
    })
    if (!result.canceled && result.filePaths[0]) {
      const tool = await validateCustomTool(result.filePaths[0])
      this.tools = this.tools
        .filter((t) => t.id !== tool.id)
        .concat(tool)
        .slice(-24)
      await mkdir(this.options.data, { recursive: true })
      await writeFile(
        join(this.options.data, 'next-action-apps.json'),
        JSON.stringify(this.tools.map((t) => t.path)),
        { mode: 0o600 },
      )
      await this.tick()
    }
    return this.read()
  }
  dispose() {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.observer.stop()
    this.hint.dispose()
    this.registry.clear()
    this.browser.stop()
  }
}

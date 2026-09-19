import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function extension(
  patch: {
    active?: boolean
    focused?: boolean
    permitted?: boolean
    url?: string
    protocol?: number
  } = {},
) {
  const listener = vi.fn(),
    hidden = vi.fn()
  const sendNativeMessage = vi
    .fn()
    .mockResolvedValue({ ok: true, protocolVersion: patch.protocol ?? 1 })
  const chrome = {
    permissions: {
      getAll: vi.fn().mockResolvedValue({ origins: [] }),
      contains: vi.fn().mockResolvedValue(patch.permitted ?? true),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      unregisterContentScripts: vi.fn(),
      registerContentScripts: vi.fn(),
    },
    runtime: {
      onMessage: { addListener: listener },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendNativeMessage,
    },
    tabs: {
      get: vi.fn().mockResolvedValue({
        active: patch.active ?? true,
        url: patch.url ?? 'https://github.com/org/repo/pull/1',
      }),
      onActivated: { addListener: hidden },
      onUpdated: { addListener: vi.fn() },
    },
    windows: {
      get: vi.fn().mockResolvedValue({ focused: patch.focused ?? true }),
      onFocusChanged: { addListener: vi.fn() },
    },
  }
  runInNewContext(
    readFileSync('apps/browser-extension/background.js', 'utf8'),
    { chrome, URL, Date, Map },
  )
  const handler = listener.mock.calls[0]![0]
  const message = (url = 'https://github.com/org/repo/pull/1') =>
    new Promise((resolve) =>
      handler(
        { type: 'visible-object', url },
        { tab: { id: 1, windowId: 2 }, frameId: 0 },
        resolve,
      ),
    )
  return { chrome, message, handler, hidden }
}
describe('browser extension scope and protocol', () => {
  it('sends only the current permitted object URL and requires a compatible host', async () => {
    const e = extension()
    expect(await e.message()).toEqual({ ok: true })
    expect(e.chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(
      'dev.bugu.context',
      { type: 'visible-object', url: 'https://github.com/org/repo/pull/1' },
    )
  })
  it.each([
    { active: false },
    { focused: false },
    { permitted: false },
    { url: 'https://github.com/org/repo/pull/2' },
  ])('does not emit mismatched/hidden/unauthorized pages %j', async (patch) => {
    const e = extension(patch)
    expect(await e.message()).toEqual({ ok: false })
    expect(e.chrome.runtime.sendNativeMessage).not.toHaveBeenCalled()
  })
  it('rejects incompatible native host version', async () => {
    const e = extension({ protocol: 2 })
    expect(await e.message()).toEqual({ ok: false })
    expect(await e.message()).toEqual({ ok: false })
  })
  it('strips query parameters and fragments before native transmission', async () => {
    const url = 'https://github.com/org/repo/pull/1?token=private#fragment'
    const e = extension({ url })
    expect(await e.message(url)).toEqual({ ok: true })
    expect(e.chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(
      'dev.bugu.context',
      { type: 'visible-object', url: 'https://github.com/org/repo/pull/1' },
    )
  })
  it('does not accept page frames or text-only page messages', () => {
    const e = extension()
    const reply = vi.fn()
    e.handler(
      { type: 'visible-object', url: 'https://github.com/x' },
      { tab: { id: 1 }, frameId: 1 },
      reply,
    )
    e.handler(
      { type: 'visible-object', text: 'injected' },
      { tab: { id: 1 }, frameId: 0 },
      reply,
    )
    expect(e.chrome.runtime.sendNativeMessage).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
  })
  it('invalidates the object on tab activation', async () => {
    const e = extension()
    await e.hidden.mock.calls[0]![0]()
    expect(e.chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(
      'dev.bugu.context',
      { type: 'hidden' },
    )
  })
  it('discards a visibility check completed after a tab switch', async () => {
    const e = extension()
    let release!: (value: unknown) => void
    e.chrome.tabs.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = e.message()
    await e.hidden.mock.calls[0]![0]()
    release({ active: true, url: 'https://github.com/org/repo/pull/1' })
    expect(await pending).toEqual({ ok: false })
    expect(
      e.chrome.runtime.sendNativeMessage.mock.calls.map((c) => c[1].type),
    ).toEqual(['hidden'])
  })
  it('clears the current object immediately on permission removal', async () => {
    const e = extension()
    await e.message()
    e.chrome.permissions.onRemoved.addListener.mock.calls[0]![0]()
    await vi.waitFor(() =>
      expect(e.chrome.runtime.sendNativeMessage).toHaveBeenLastCalledWith(
        'dev.bugu.context',
        { type: 'hidden' },
      ),
    )
  })
})

describe('visible object recovery', () => {
  it('reannounces after hiding and periodically retries a desktop restart', async () => {
    vi.useFakeTimers()
    try {
      const handlers: Record<string, () => void> = {}
      const doc = { visibilityState: 'visible', hasFocus: () => true,
        addEventListener: (name: string, handler: () => void) => { handlers[name] = handler } }
      const sendMessage = vi.fn().mockResolvedValue({ ok: true })
      runInNewContext(readFileSync('apps/browser-extension/content.js', 'utf8'), {
        document: doc, location: { href: 'https://github.com/org/repo/pull/1' },
        chrome: { runtime: { sendMessage } }, Date,
        setTimeout, clearTimeout, setInterval,
        addEventListener: (name: string, handler: () => void) => { handlers[name] = handler },
      })
      await vi.advanceTimersByTimeAsync(1600)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      doc.visibilityState = 'hidden'; handlers.visibilitychange!()
      await vi.advanceTimersByTimeAsync(4000)
      expect(sendMessage).toHaveBeenCalledTimes(1)
      doc.visibilityState = 'visible'; handlers.visibilitychange!()
      await vi.advanceTimersByTimeAsync(2000)
      expect(sendMessage).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(14000)
      expect(sendMessage.mock.calls.length).toBeGreaterThan(2)
    } finally { vi.clearAllTimers(); vi.useRealTimers() }
  })
})

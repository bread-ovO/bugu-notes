import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
import { NativeNextObserver } from '../../apps/desktop/src/main/next-action/native-input'
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
}
const children: ReturnType<typeof child>[] = []
let observer: NativeNextObserver
const signals = vi.fn()
const emit = (value: unknown, c = children.at(-1)!) =>
  c.stdout.write(JSON.stringify(value) + '\n')
const capable = () =>
  emit({
    type: 'capability',
    foreground: true,
    input: true,
    tab: true,
    reason: 'fixture',
  })
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('XDG_SESSION_TYPE', 'x11')
  children.length = 0
  signals.mockReset()
  mocks.spawn.mockReset().mockImplementation(() => {
    const c = child()
    children.push(c)
    return c
  })
  observer = new NativeNextObserver('/isolated/helper', signals)
  observer.start()
})
afterEach(() => {
  observer.stop()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
describe('native observation recovery and revocation', () => {
  it('releases an armed shortcut when capabilities are withdrawn', async () => {
    capable()
    const confirm = vi.fn()
    const pending = observer.arm('lease', Date.now() + 3000, confirm)
    emit({ type: 'armed', id: 'lease' })
    expect(await pending).toBe(true)
    emit({
      type: 'capability',
      foreground: true,
      input: false,
      tab: false,
      reason: 'permission revoked',
    })
    emit({ type: 'confirm', id: 'lease' })
    expect(confirm).not.toHaveBeenCalled()
    expect(signals).toHaveBeenCalledWith({ type: 'locked' })
  })
  it('invalidates confirmation immediately on a lock signal', async () => {
    capable()
    const confirm = vi.fn()
    const pending = observer.arm('lease', Date.now() + 3000, confirm)
    emit({ type: 'armed', id: 'lease' })
    await pending
    emit({ type: 'locked' })
    emit({ type: 'confirm', id: 'lease' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('accepts one matching, unexpired confirmation only', async () => {
    capable()
    const confirm = vi.fn()
    const pending = observer.arm('lease', Date.now() + 3000, confirm)
    emit({ type: 'armed', id: 'lease' })
    await pending
    emit({ type: 'confirm', id: 'forged' })
    expect(confirm).not.toHaveBeenCalled()
    emit({ type: 'confirm', id: 'lease' })
    emit({ type: 'confirm', id: 'lease' })
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('rejects delayed confirmations after the local deadline', async () => {
    capable()
    const confirm = vi.fn()
    const pending = observer.arm('lease', Date.now() + 500, confirm)
    emit({ type: 'armed', id: 'lease' })
    await pending
    await vi.advanceTimersByTimeAsync(501)
    emit({ type: 'confirm', id: 'lease' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('bounds crash retries and never re-prompts for permission automatically', async () => {
    observer.start(true)
    for (const delay of [1000, 3000, 10000]) {
      children.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(delay)
    }
    children.at(-1)!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.spawn).toHaveBeenCalledTimes(5) // initial start, explicit restart, three recovery attempts
    expect(
      mocks.spawn.mock.calls.slice(2).every((c) => c[1].length === 0),
    ).toBe(true)
    expect(observer.capability.input).toBe(false)
  })
  it('cancels pending restart on explicit stop and ignores old process output', async () => {
    const old = children[0]!
    old.emit('exit', 1)
    observer.stop()
    await vi.advanceTimersByTimeAsync(20000)
    expect(children).toHaveLength(1)
    signals.mockClear()
    emit({ type: 'foreground', app: 'forged' }, old)
    expect(signals).not.toHaveBeenCalled()
  })
  it('only accepts currently watched record identities and resends watches after a crash', async () => {
    const watch = [
      { recordId: 7, app: 'fixture', text: 'synthetic '.repeat(8) },
    ]
    observer.watch(watch)
    emit({ type: 'visible', recordId: 9 })
    expect(signals).not.toHaveBeenCalled()
    emit({ type: 'visible', recordId: 7 })
    expect(signals).toHaveBeenCalledWith({ type: 'visible', recordId: 7 })
    children[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1000)
    signals.mockClear()
    emit({ type: 'visible', recordId: 7 })
    expect(signals).not.toHaveBeenCalled()
    observer.watch(watch)
    emit({ type: 'visible', recordId: 7 })
    expect(signals).toHaveBeenCalledWith({ type: 'visible', recordId: 7 })
  })
  it('treats oversized unterminated frames and broken stdin as unavailable', () => {
    capable()
    children[0]!.stdout.write('x'.repeat(65537))
    expect(observer.capability.input).toBe(false)
    expect(children[0]!.kill).toHaveBeenCalled()
    expect(signals).toHaveBeenCalledWith({ type: 'locked' })
  })
  it('handles stdin errors without an unhandled process exception', () => {
    children[0]!.stdin.emit('error', Error('synthetic EPIPE'))
    expect(signals).toHaveBeenCalledWith({ type: 'locked' })
  })
})

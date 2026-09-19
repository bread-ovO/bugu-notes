import { describe, expect, it, vi } from 'vitest'
import { HintStateMachine, NextTargetRegistry, normalizeConfirmShortcut, type HintContext } from '@memo/next-action'
import { target } from '../fixtures/next-action'
const context = (patch: Partial<HintContext> = {}): HintContext => ({ id: 'suggestion', targetId: 'codex-a', targetRevision: 1, contextRevision: 1, shortcutRevision: 1, validUntil: 60000, durationMs: 3000, shortcut: 'Tab', ...patch })
const stopped = { known: true, composing: false, lastInputAt: 0 }
describe('hint input and lease lifecycle', () => {
  it('waits for input to stop and IME composition to end, then gives the full three seconds', () => {
    const h = new HintStateMachine(context())
    expect(h.ready(1000, stopped, true)).toBe(false)
    expect(h.ready(5000, { ...stopped, composing: true }, true)).toBe(false)
    expect(h.ready(6000, stopped, true)).toBe(true)
    expect(h.deadline).toBe(9000)
  })
  it('unknown input state and unavailable lease never show a misleading Tab suggestion', () => {
    const h = new HintStateMachine(context())
    expect(h.ready(2000, { ...stopped, known: false }, true)).toBe(false)
    expect(h.ready(2000, stopped, false)).toBe(false)
    expect(h.confirm(2001, context())).toBe(false)
  })
  it('typing during a popup suspends it; at most one full redisplay is allowed', () => {
    const h = new HintStateMachine(context())
    h.ready(2000, stopped, true)
    h.input(2100)
    expect(h.phase).toBe('waiting-input')
    expect(h.confirm(2150, context())).toBe(false)
    expect(h.ready(3300, { ...stopped, lastInputAt: 2100 }, true)).toBe(true)
    expect(h.deadline).toBe(6300)
    h.input(3400)
    expect(h.phase).toBe('dismissed')
    expect(h.ready(9000, stopped, true)).toBe(false)
  })
  it('expired hints never confirm or revive', () => {
    const h = new HintStateMachine(context())
    h.ready(2000, stopped, true)
    expect(h.confirm(5000, context())).toBe(false)
    expect(h.ready(6000, stopped, true)).toBe(false)
  })
  it.each(['id', 'targetId', 'targetRevision', 'contextRevision', 'shortcutRevision'] as const)('rejects stale %s binding', field => {
    const h = new HintStateMachine(context())
    h.ready(2000, stopped, true)
    const changed = { ...context(), [field]: typeof context()[field] === 'string' ? 'changed' : 2 }
    expect(h.confirm(2100, changed)).toBe(false)
  })
  it('ignores key repeats/pre-held keys and consumes confirmation exactly once', () => {
    const h = new HintStateMachine(context())
    h.ready(2000, stopped, true)
    expect(h.confirm(2100, context(), { repeated: true, heldBeforeLease: false })).toBe(false)
    expect(h.confirm(2100, context(), { repeated: false, heldBeforeLease: true })).toBe(false)
    expect(h.confirm(2100, context())).toBe(true)
    expect(h.confirm(2101, context())).toBe(false)
  })
  it('click mode needs no keyboard lease and cannot reset an existing countdown', () => {
    const h = new HintStateMachine(context({ shortcut: 'click' }))
    expect(h.ready(2000, { ...stopped, known: false }, false)).toBe(true)
    expect(h.ready(4000, stopped, false)).toBe(false)
    expect(h.deadline).toBe(5000)
  })
  it.each(['Enter', 'Escape', 'Alt+F4', 'Command+Q', 'Control+Tab', 'Tab;rm', ''])('rejects reserved or unvalidated shortcut %s', key => {
    expect(() => normalizeConfirmShortcut(key)).toThrow('NEXT_INVALID_SHORTCUT')
  })
  it('does not silently rewrite valid custom keys', () => {
    for (const key of ['Tab', 'click', 'CommandOrControl+Shift+J', 'Control+Shift+J']) expect(normalizeConfirmShortcut(key)).toBe(key)
  })
})

describe('trusted execution registry', () => {
  const setup = () => {
    const registry = new NextTargetRegistry()
    const open = vi.fn(async () => ({ state: 'dispatched' as const }))
    registry.register({ target: target(), available: async () => true, open })
    return { registry, open }
  }
  it('only offers same project/account targets with working adapters', async () => {
    const { registry } = setup()
    expect(await registry.candidates('project-a', 'account-a')).toHaveLength(1)
    expect(await registry.candidates('project-b', 'account-a')).toEqual([])
    expect(await registry.candidates('project-a', 'account-b')).toEqual([])
    registry.register({ target: target(), available: async () => false, open: async () => ({ state: 'failed' }) })
    expect(await registry.candidates('project-a', 'account-a')).toEqual([])
  })
  it('double confirmation dispatches only once without claiming the destination was observed', async () => {
    const { registry, open } = setup()
    registry.issue('token', target(), 3000, 0)
    const results = await Promise.all([registry.confirm('token', () => 100), registry.confirm('token', () => 100)])
    expect(results).toEqual([{ state: 'dispatched' }, { state: 'failed' }])
    expect(open).toHaveBeenCalledOnce()
  })
  it.each(['expiry', 'revocation', 'permission', 'replacement'] as const)('blocks %s after showing the suggestion', async kind => {
    const { registry, open } = setup()
    registry.issue('token', target(), 3000, 0)
    if (kind === 'revocation') registry.revoke('codex-a')
    if (kind === 'permission') registry.invalidate()
    if (kind === 'replacement') registry.register({ target: target('codex-a', { revision: 2 }), available: async () => true, open })
    expect(await registry.confirm('token', () => kind === 'expiry' ? 3000 : 100)).toEqual({ state: 'failed' })
    expect(open).not.toHaveBeenCalled()
  })
  it('rechecks revocation and time after async availability checks', async () => {
    const { registry, open } = setup()
    let finish!: (value: boolean) => void
    registry.register({ target: target(), available: () => new Promise(resolve => finish = resolve), open })
    registry.issue('token', target(), 3000, 0)
    const pending = registry.confirm('token', () => 100)
    registry.invalidate(); finish(true)
    expect(await pending).toEqual({ state: 'failed' })
    expect(open).not.toHaveBeenCalled()
  })
  it('never falls back from a failed precise target to an unconfirmed app launch', async () => {
    const registry = new NextTargetRegistry()
    const fallback = vi.fn(async () => ({ state: 'dispatched' as const }))
    registry.register({ target: target('object', { kind: 'open-object' }), available: async () => false, open: fallback })
    registry.issue('token', target('object', { kind: 'open-object' }), 3000, 0)
    expect(await registry.confirm('token', () => 100)).toEqual({ state: 'failed' })
    expect(fallback).not.toHaveBeenCalled()
  })
})

import type { NextTarget } from '@memo/contracts'

export interface TargetExecution {
  state: 'dispatched' | 'app-observed' | 'target-confirmed' | 'unknown' | 'failed'
}
export interface TargetAdapter {
  target: NextTarget
  available(): Promise<boolean>
  open(): Promise<TargetExecution>
}

/** Only host adapters register actions. Neither URLs nor commands are accepted from model/renderer. */
export class NextTargetRegistry {
  private adapters = new Map<string, TargetAdapter>()
  private confirmations = new Map<string, { target: NextTarget; expiresAt: number; generation: number }>()
  private generation = 0
  register(adapter: TargetAdapter): void {
    if (this.adapters.size >= 128 && !this.adapters.has(adapter.target.id)) throw Error('NEXT_TARGET_LIMIT')
    this.revoke(adapter.target.id)
    this.adapters.set(adapter.target.id, { ...adapter, target: structuredClone(adapter.target) })
  }
  revoke(id: string): void {
    this.adapters.delete(id)
    for (const [token, binding] of this.confirmations) if (binding.target.id === id) this.confirmations.delete(token)
  }
  invalidate(): void { this.generation++; this.confirmations.clear() }
  clear(): void { this.invalidate(); this.adapters.clear() }
  async candidates(projectId: string, accountId: string): Promise<NextTarget[]> {
    const out: NextTarget[] = []
    for (const adapter of this.adapters.values()) {
      if (adapter.target.projectId !== projectId || adapter.target.accountId !== accountId) continue
      try {
        if (await adapter.available() && this.adapters.get(adapter.target.id) === adapter) out.push(structuredClone(adapter.target))
      } catch { /* An unavailable adapter is not a launch target. */ }
    }
    return out.slice(0, 12)
  }
  issue(token: string, target: NextTarget, expiresAt: number, now: number): void {
    for (const [key, binding] of this.confirmations) if (now >= binding.expiresAt) this.confirmations.delete(key)
    const registered = this.adapters.get(target.id)?.target
    if (!registered || registered.revision !== target.revision || registered.projectId !== target.projectId ||
        registered.accountId !== target.accountId || !token || this.confirmations.has(token) ||
        this.confirmations.size >= 20 || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 30000)
      throw Error('NEXT_INVALID_TARGET')
    this.confirmations.set(token, { target: structuredClone(registered), expiresAt, generation: this.generation })
  }
  async confirm(token: string, now: () => number): Promise<TargetExecution> {
    const binding = this.confirmations.get(token)
    // Consume before any asynchronous work, including failed validation and double clicks.
    this.confirmations.delete(token)
    if (!binding || now() >= binding.expiresAt || binding.generation !== this.generation) return { state: 'failed' }
    const adapter = this.adapters.get(binding.target.id)
    if (!adapter || adapter.target.revision !== binding.target.revision) return { state: 'failed' }
    try {
      if (!await adapter.available() || now() >= binding.expiresAt || binding.generation !== this.generation ||
          this.adapters.get(binding.target.id) !== adapter) return { state: 'failed' }
      return await adapter.open()
    } catch { return { state: 'failed' } }
  }
}

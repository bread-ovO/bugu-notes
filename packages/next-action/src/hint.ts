export type HintPhase = 'idle' | 'waiting-input' | 'visible' | 'dismissed' | 'confirmed'
export interface HintContext {
  id: string
  targetId: string
  targetRevision: number
  contextRevision: number
  shortcutRevision: number
  validUntil: number
  durationMs: number
  shortcut: string
}
export interface InputActivity { known: boolean; composing: boolean; lastInputAt: number }
export function normalizeConfirmShortcut(value: string): string {
  if (value === 'Tab' || value === 'click') return value
  // Deliberately small portable grammar. The host must additionally verify OS registration succeeds.
  if (/^(CommandOrControl|Control|Alt|Command)\+Shift\+[A-Z]$/.test(value)) return value
  throw Error('NEXT_INVALID_SHORTCUT')
}

/** Monotonic times are injected. This class performs no OS calls or timers. */
export class HintStateMachine {
  phase: HintPhase = 'idle'
  deadline = 0
  private redisplays = 0
  private shown = false
  constructor(readonly context: HintContext) {
    normalizeConfirmShortcut(context.shortcut)
    if (![3000, 5000, 8000].includes(context.durationMs) || !Number.isFinite(context.validUntil))
      throw Error('NEXT_INVALID_HINT')
  }
  ready(now: number, activity: InputActivity, keyLeaseReady: boolean): boolean {
    if (['dismissed', 'confirmed', 'visible'].includes(this.phase)) return false
    if (now >= this.context.validUntil) { this.dismiss(); return false }
    if (this.context.shortcut === 'Tab' && (!activity.known || activity.composing || now - activity.lastInputAt < 1200)) {
      this.phase = 'waiting-input'
      return false
    }
    if (activity.composing || (this.context.shortcut !== 'click' && !keyLeaseReady)) return false
    this.phase = 'visible'
    this.shown = true
    this.deadline = Math.min(now + this.context.durationMs, this.context.validUntil)
    return true
  }
  input(now: number): void {
    if (this.phase !== 'visible' || this.context.shortcut !== 'Tab') return
    if (now >= this.deadline || this.redisplays >= 1) { this.dismiss(); return }
    this.redisplays++
    this.phase = 'waiting-input'
    this.deadline = 0
  }
  tick(now: number): void {
    if (now >= this.context.validUntil || (this.phase === 'visible' && now >= this.deadline)) this.dismiss()
  }
  confirm(now: number, binding: Pick<HintContext, 'id' | 'targetId' | 'targetRevision' | 'contextRevision' | 'shortcutRevision'>,
    key: { repeated: boolean; heldBeforeLease: boolean } = { repeated: false, heldBeforeLease: false }): boolean {
    this.tick(now)
    if (this.phase !== 'visible' || !this.shown || key.repeated || key.heldBeforeLease ||
        binding.id !== this.context.id || binding.targetId !== this.context.targetId ||
        binding.targetRevision !== this.context.targetRevision || binding.contextRevision !== this.context.contextRevision ||
        binding.shortcutRevision !== this.context.shortcutRevision) return false
    this.phase = 'confirmed'
    this.deadline = 0
    return true
  }
  dismiss(): void { if (this.phase !== 'confirmed') this.phase = 'dismissed'; this.deadline = 0 }
}

import type { TaskModelRequest } from '@memo/model'
/** One provider at a time, round-robin between chat, task extraction and next-action. */
export class ModelQueue {
  private active = false
  private queues = new Map<
    string,
    Array<{ signal: AbortSignal; run: () => Promise<void>; cancel: () => void }>
  >()
  private cursor = 0
  enqueue(
    purpose: TaskModelRequest['purpose'],
    signal: AbortSignal,
    run: () => Promise<void>,
    cancel: () => void,
  ): boolean {
    if ([...this.queues.values()].reduce((n, q) => n + q.length, 0) >= 24)
      return false
    const key = purpose ?? 'extraction'
    const q = this.queues.get(key) ?? []
    q.push({ signal, run, cancel })
    this.queues.set(key, q)
    void this.drain()
    return true
  }
  private async drain() {
    if (this.active) return
    this.active = true
    try {
      while (true) {
        const keys = ['task-chat', 'extraction', 'next-action']
        let job
        for (let i = 0; i < keys.length; i++) {
          const index = (this.cursor + i) % keys.length
          const q = this.queues.get(keys[index]!)
          if (q?.length) {
            job = q.shift()!
            this.cursor = (index + 1) % keys.length
            break
          }
        }
        if (!job) break
        if (job.signal.aborted) job.cancel()
        else await job.run()
      }
    } finally {
      this.active = false
    }
  }
  clear() {
    for (const q of this.queues.values()) for (const job of q) job.cancel()
    this.queues.clear()
  }
}

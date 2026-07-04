/** Minimal typed event bus — the spine between data, weather, and effects. */

export interface HLEvents {
  whale: { btc: number; txid: string }
  newBlock: { height: number }
  crash: void
  rally: void
  gust: void
  stale: void
  resumeLive: void
  tick: void
}

type Handler<T> = (payload: T) => void

export class EventBus {
  private handlers = new Map<keyof HLEvents, Set<Handler<never>>>()

  on<K extends keyof HLEvents>(type: K, fn: Handler<HLEvents[K]>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(fn as Handler<never>)
    return () => this.handlers.get(type)?.delete(fn as Handler<never>)
  }

  emit<K extends keyof HLEvents>(type: K, payload: HLEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        ;(fn as Handler<HLEvents[K]>)(payload)
      } catch (err) {
        console.error(`event handler error [${type}]`, err)
      }
    })
  }
}

export const bus = new EventBus()

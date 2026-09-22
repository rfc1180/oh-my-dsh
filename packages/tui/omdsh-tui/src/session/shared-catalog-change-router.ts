import type { Context } from '@deepseek-ai/cordis'

/** Runtime-local reactions to process-wide catalog changes. */
export interface SharedCatalogChangeSink {
  commandsChanged(): void | Promise<void>
  skillsChanged(): void | Promise<void>
  toolsChanged(): void | Promise<void>
}

const routers = new WeakMap<Context, SharedCatalogChangeRouter>()

/**
 * Share one listener for each catalog event between every SessionRuntime using
 * the same process Context. Synchronous catalog bursts are delivered once per
 * affected catalog in the next microtask.
 */
export function connectSharedCatalogChanges(ctx: Context, sink: SharedCatalogChangeSink): () => void {
  let router = routers.get(ctx)
  if (router === undefined) {
    router = new SharedCatalogChangeRouter(ctx, () => { routers.delete(ctx) })
    routers.set(ctx, router)
  }
  return router.connect(sink)
}

class SharedCatalogChangeRouter {
  readonly #sinks = new Set<SharedCatalogChangeSink>()
  readonly #off: Array<() => void>
  readonly #onEmpty: () => void
  #pending = 0
  #scheduled = false

  constructor(ctx: Context, onEmpty: () => void) {
    this.#onEmpty = onEmpty
    this.#off = [
      ctx.on('commands/change', () => { this.#schedule(1) }),
      ctx.on('skills/change', () => { this.#schedule(2) }),
      ctx.on('tools/change', () => { this.#schedule(4) }),
    ]
  }

  connect(sink: SharedCatalogChangeSink): () => void {
    this.#sinks.add(sink)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.#sinks.delete(sink)
      if (this.#sinks.size !== 0) return
      for (const off of this.#off.splice(0).reverse()) off()
      this.#pending = 0
      this.#onEmpty()
    }
  }

  #schedule(kind: number): void {
    this.#pending |= kind
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => { this.#flush() })
  }

  #flush(): void {
    this.#scheduled = false
    const pending = this.#pending
    this.#pending = 0
    if (pending === 0) return
    for (const sink of [...this.#sinks]) {
      if (!this.#sinks.has(sink)) continue
      if ((pending & 1) !== 0) this.#notify(() => { sink.commandsChanged() })
      if ((pending & 2) !== 0) this.#notify(() => { sink.skillsChanged() })
      if ((pending & 4) !== 0) this.#notify(() => { sink.toolsChanged() })
    }
  }

  #notify(notify: () => void | Promise<void>): void {
    try {
      void Promise.resolve(notify()).catch(() => {
        // One async runtime failure must not affect another live slot.
      })
    } catch {
      // One synchronous runtime failure must not affect another live slot.
    }
  }
}

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

type AgentStatusPayload = {
  readonly agent: Agent
  readonly status: Agent['status']
}

/** Runtime-local handlers for the high-volume events emitted by one shared Context. */
export interface SharedSessionEventSink {
  agentStatus(payload: AgentStatusPayload): void
  sessionCreated(session: Session): void
  sessionDisposed(session: Session): void
  sessionEvent(session: Session, event: SessionEvent): void
}

/** One runtime's root binding in the process-wide router for a shared Context. */
export interface SharedSessionEventRoute {
  bindRoot(rootId: SessionId): void
  unbindRoot(): void
  dispose(): void
}

interface RouteState {
  readonly sink: SharedSessionEventSink
  rootId?: SessionId
  disposed: boolean
}

const routers = new WeakMap<Context, SharedSessionEventRouter>()

/** Share exactly one set of Context listeners between every SessionRuntime in this process. */
export function connectSharedSessionEvents(ctx: Context, sink: SharedSessionEventSink): SharedSessionEventRoute {
  let router = routers.get(ctx)
  if (router === undefined) {
    router = new SharedSessionEventRouter(ctx, () => { routers.delete(ctx) })
    routers.set(ctx, router)
  }
  return router.connect(sink)
}

class SharedSessionEventRouter {
  readonly #ctx: Context
  readonly #onEmpty: () => void
  readonly #routes = new Set<RouteState>()
  readonly #roots = new Map<string, RouteState>()
  readonly #owners = new Map<string, RouteState>()
  readonly #off: Array<() => void>

  constructor(ctx: Context, onEmpty: () => void) {
    this.#ctx = ctx
    this.#onEmpty = onEmpty
    this.#off = [
      ctx.on('agent/status', payload => { this.#dispatch(payload.agent.session, route => { route.sink.agentStatus(payload) }) }),
      ctx.on('session/created', session => { this.#dispatch(session, route => { route.sink.sessionCreated(session) }) }),
      ctx.on('session/disposed', session => {
        this.#dispatch(session, route => { route.sink.sessionDisposed(session) })
        this.#owners.delete(session.id)
      }),
      ctx.on('session/event', (session, event) => {
        this.#dispatch(session, route => { route.sink.sessionEvent(session, event) })
      }),
    ]
  }

  connect(sink: SharedSessionEventSink): SharedSessionEventRoute {
    const state: RouteState = { sink, disposed: false }
    this.#routes.add(state)
    return {
      bindRoot: rootId => { this.#bindRoot(state, rootId) },
      unbindRoot: () => { this.#unbindRoot(state) },
      dispose: () => { this.#disposeRoute(state) },
    }
  }

  #bindRoot(route: RouteState, rootId: SessionId): void {
    if (route.disposed) throw new Error('cannot bind a disposed shared session event route')
    if (route.rootId === rootId) return
    const owner = this.#roots.get(rootId)
    if (owner !== undefined && owner !== route) {
      throw new Error(`session root ${rootId} is already bound to another runtime`)
    }
    this.#unbindRoot(route)
    route.rootId = rootId
    this.#roots.set(rootId, route)
    // A session cached as another root's descendant may itself become a live
    // root later. Rebuild only explicit root owners so every descendant is
    // resolved against the complete new root set on its next event.
    this.#owners.clear()
    for (const [id, ownerRoute] of this.#roots) this.#owners.set(id, ownerRoute)
  }

  #unbindRoot(route: RouteState): void {
    if (route.rootId !== undefined) this.#roots.delete(route.rootId)
    delete route.rootId
    for (const [id, owner] of this.#owners) {
      if (owner === route) this.#owners.delete(id)
    }
  }

  #disposeRoute(route: RouteState): void {
    if (route.disposed) return
    route.disposed = true
    this.#unbindRoot(route)
    this.#routes.delete(route)
    if (this.#routes.size !== 0) return
    for (const off of this.#off.splice(0).reverse()) off()
    this.#onEmpty()
  }

  #dispatch(session: Session, notify: (route: RouteState) => void): void {
    const owner = this.#owner(session)
    if (owner !== undefined) {
      notify(owner)
      return
    }
    // Preserve the previous broadcast behavior when a session's ancestry is not
    // available yet. Runtime-local lineage checks remain the source of truth.
    for (const route of this.#routes) notify(route)
  }

  #owner(session: Session): RouteState | undefined {
    const known = this.#owners.get(session.id)
    if (known !== undefined) return known

    const lineage: string[] = []
    let current: Session | undefined = session
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      lineage.push(current.id)
      const direct = this.#roots.get(current.id) ?? this.#owners.get(current.id)
      if (direct !== undefined) {
        for (const id of lineage) this.#owners.set(id, direct)
        return direct
      }
      const parentId: SessionId | undefined = current.header.parentSession
      if (parentId === undefined) return undefined
      const parentOwner = this.#roots.get(parentId) ?? this.#owners.get(parentId)
      if (parentOwner !== undefined) {
        for (const id of lineage) this.#owners.set(id, parentOwner)
        return parentOwner
      }
      current = this.#ctx.get('sessions')?.get(SessionId(parentId))
    }
    return undefined
  }
}

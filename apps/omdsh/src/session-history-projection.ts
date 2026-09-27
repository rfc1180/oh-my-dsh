/** Product-owned semantic session history projection. Raw journal payloads never cross this boundary. */
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

export const SESSION_HISTORY_DTO_VERSION = 1 as const
export const SESSION_HISTORY_CLASSIFIER_VERSION = 'omdsh.session-history.classifier.v1' as const

export type SessionAudienceV1 = 'human' | 'internal' | 'unknown'
export type SessionTopologyV1 = 'root' | 'fork' | 'subagent'
export type SessionProvenanceV1 = 'native' | 'legacy'
export type SessionBucketV1 = 'human' | 'internal' | 'subagent' | 'legacy'
export type ProjectionConfidenceV1 = 'high' | 'medium' | 'low'

export interface SessionClassificationV1 {
  readonly audience: SessionAudienceV1
  readonly topology: SessionTopologyV1
  readonly provenance: SessionProvenanceV1
  readonly bucket: SessionBucketV1
  readonly reasons: readonly string[]
  readonly confidence: ProjectionConfidenceV1
  readonly classifierVersion: typeof SESSION_HISTORY_CLASSIFIER_VERSION
}

/** Allowlisted user-visible content. Attachment identities, reasoning, calls, and tool payloads are omitted. */
export interface SafeHistoryContentV1 {
  readonly format: 'markdown'
  readonly text?: string
  readonly imageCount?: number
}

export interface HistoryEventRefV1 {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly turn?: number
  readonly step?: number
  readonly name?: string
  readonly status?: 'completed' | 'failed'
}

export interface HistoryInputV1 {
  readonly kind: 'input' | 'steering'
  readonly content: SafeHistoryContentV1
  readonly ref: HistoryEventRefV1
}

export interface HistoryAnswerV1 {
  readonly content: SafeHistoryContentV1
  readonly confidence: 'explicit' | 'inferred'
  readonly ref: HistoryEventRefV1
}

export interface HistoryOutcomeV1 {
  readonly kind: 'completed' | 'failed' | 'blocked' | 'interrupted' | 'open' | 'unknown'
  readonly ref?: HistoryEventRefV1
}

export interface SessionInteractionV1 {
  readonly id: string
  readonly turn?: number
  readonly input: HistoryInputV1
  readonly answer?: HistoryAnswerV1
  readonly outcome: HistoryOutcomeV1
  readonly technicalTrace: readonly HistoryEventRefV1[]
}

export interface SessionHistoryProjectionV1 {
  readonly version: typeof SESSION_HISTORY_DTO_VERSION
  readonly sessionId: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly asOfSeq: number
  readonly title: string
  readonly preview?: string
  readonly status?: Exclude<HistoryOutcomeV1['kind'], 'open' | 'unknown'>
  readonly classification: SessionClassificationV1
  readonly interactions: readonly SessionInteractionV1[]
}

export interface SessionHistoryCatalogPageV1 {
  readonly version: typeof SESSION_HISTORY_DTO_VERSION
  readonly items: readonly SessionHistoryProjectionV1[]
  readonly nextCursor?: string
}

function directHuman(event: SessionEvent, localFromSeq: number): boolean {
  return event.seq >= localFromSeq && event.type === 'user/message' && event.data.source.kind === 'user'
}

function safeContent(blocks: readonly { type: string; text?: string }[]): SafeHistoryContentV1 | undefined {
  const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '').join('\n').trim()
  const imageCount = blocks.filter(block => block.type === 'image').length
  if (text === '' && imageCount === 0) return undefined
  return {
    format: 'markdown',
    ...(text === '' ? {} : { text }),
    ...(imageCount === 0 ? {} : { imageCount }),
  }
}

function eventContent(event: SessionEvent): SafeHistoryContentV1 | undefined {
  if (event.type === 'user/message') return safeContent(event.data.content)
  if (event.type === 'assistant/message') return safeContent(event.data.message.content)
  return undefined
}

function sameContent(left: SafeHistoryContentV1, right: SafeHistoryContentV1): boolean {
  return left.text === right.text && (left.imageCount ?? 0) === (right.imageCount ?? 0)
}

function eventRef(event: SessionEvent): HistoryEventRefV1 {
  if (event.type === 'tool/call') {
    return { seq: event.seq, time: event.time, type: event.type, turn: event.data.turn, step: event.data.step, name: event.data.name }
  }
  if (event.type === 'tool/result') {
    return {
      seq: event.seq, time: event.time, type: event.type, turn: event.data.turn, step: event.data.step,
      status: event.data.error === undefined ? 'completed' : 'failed',
    }
  }
  if (event.type === 'assistant/message') {
    return { seq: event.seq, time: event.time, type: event.type, turn: event.data.turn, step: event.data.step }
  }
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    return { seq: event.seq, time: event.time, type: event.type, turn: event.data.turn }
  }
  return { seq: event.seq, time: event.time, type: event.type }
}

function outcomeFor(event: Extract<SessionEvent, { type: 'turn/end' }>): HistoryOutcomeV1['kind'] {
  const reason = event.data.reason.kind
  if (reason === 'completed') return 'completed'
  if (reason === 'error') return 'failed'
  if (reason === 'blocked' || reason === 'max-tokens') return 'blocked'
  return 'interrupted'
}

function isTechnicalTrace(event: SessionEvent): boolean {
  if (event.type === 'tool/call' || event.type === 'tool/result') return true
  return /(?:subagent|status|completion)/u.test(event.type)
}

/** Classify one session using durable header facts and only local direct-human input. */
export function classifySessionV1(header: SessionHeader, events: readonly SessionEvent[]): SessionClassificationV1 {
  const localFromSeq = header.seedLength ?? 0
  const hasLocalHuman = events.some(event => directHuman(event, localFromSeq) && eventContent(event) !== undefined)
  const hasMessages = events.some(event => event.type === 'user/message' || event.type === 'assistant/message')
  const hasTurnLifecycle = events.some(event => event.type === 'turn/start' || event.type === 'turn/end')
  const topology: SessionTopologyV1 = header.origin === 'subagent' ? 'subagent'
    : header.parentSession === undefined ? 'root' : 'fork'
  const provenance: SessionProvenanceV1 = hasMessages && !hasTurnLifecycle ? 'legacy' : 'native'
  const audience: SessionAudienceV1 = header.origin === 'subagent' ? 'internal' : hasLocalHuman ? 'human' : 'internal'
  const bucket: SessionBucketV1 = topology === 'subagent' ? 'subagent'
    : audience === 'human' && provenance !== 'legacy' ? 'human'
      : provenance === 'legacy' ? 'legacy' : 'internal'
  const reasons = [
    topology === 'subagent' ? 'header.origin=subagent'
      : topology === 'fork' ? 'header.parentSession present' : 'no parentSession',
    hasLocalHuman ? 'local direct human input present' : 'no local direct human input',
    provenance === 'legacy' ? 'messages without turn lifecycle' : 'native turn lifecycle or empty journal',
    ...(header.seedLength === undefined ? [] : [`seedLength=${header.seedLength}`]),
  ]
  return {
    audience, topology, provenance, bucket, reasons,
    confidence: provenance === 'legacy' || !hasLocalHuman ? 'medium' : 'high',
    classifierVersion: SESSION_HISTORY_CLASSIFIER_VERSION,
  }
}

/** Pure deterministic raw-journal to semantic DTO projection. */
export function projectSessionHistoryV1(header: SessionHeader, events: readonly SessionEvent[]): SessionHistoryProjectionV1 {
  const classification = classifySessionV1(header, events)
  const interactions: Array<{
    id: string
    turn?: number
    input: HistoryInputV1
    answer?: HistoryAnswerV1
    outcome: HistoryOutcomeV1
    technicalTrace: HistoryEventRefV1[]
    inputSeq: number
  }> = []
  const latestByTurn = new Map<number, number>()
  const assistantsByTurn = new Map<number, Extract<SessionEvent, { type: 'assistant/message' }>[]>()
  let openTurn: number | undefined

  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    if (event.type === 'assistant/message') {
      const rows = assistantsByTurn.get(event.data.turn) ?? []
      rows.push(event)
      assistantsByTurn.set(event.data.turn, rows)
    }
    if (directHuman(event, 0)) {
      const content = eventContent(event)
      if (content !== undefined) {
        const turn = openTurn
        const previous = turn === undefined ? undefined : interactions[latestByTurn.get(turn) ?? -1]
        if (previous !== undefined && sameContent(previous.input.content, content)) continue
        const steering = turn !== undefined && previous !== undefined
        const index = interactions.length
        interactions.push({
          id: turn === undefined ? `event:${event.seq}` : `turn:${turn}:${event.seq}`,
          ...(turn === undefined ? {} : { turn }),
          input: { kind: steering ? 'steering' : 'input', content, ref: eventRef(event) },
          outcome: { kind: turn === undefined ? 'unknown' : 'open' },
          technicalTrace: [],
          inputSeq: event.seq,
        })
        if (turn !== undefined) latestByTurn.set(turn, index)
      }
    }
    if (isTechnicalTrace(event)) {
      const target = openTurn === undefined ? interactions.at(-1) : interactions[latestByTurn.get(openTurn) ?? -1]
      if (target !== undefined && event.seq >= target.inputSeq) target.technicalTrace.push(eventRef(event))
    }
    if (event.type === 'turn/end') {
      const index = latestByTurn.get(event.data.turn)
      const interaction = index === undefined ? undefined : interactions[index]
      if (interaction !== undefined) {
        const kind = outcomeFor(event)
        interaction.outcome = { kind, ref: eventRef(event) }
        if (kind === 'completed') {
          const answerEvent = [...(assistantsByTurn.get(event.data.turn) ?? [])].reverse()
            .find(candidate => candidate.data.interrupted !== true && eventContent(candidate) !== undefined)
          const content = answerEvent === undefined ? undefined : eventContent(answerEvent)
          if (answerEvent !== undefined && content !== undefined) {
            interaction.answer = { content, confidence: 'explicit', ref: eventRef(answerEvent) }
          }
        }
      }
      if (openTurn === event.data.turn) openTurn = undefined
    }
  }

  if (classification.provenance === 'legacy') {
    for (let index = 0; index < interactions.length; index += 1) {
      const interaction = interactions[index]!
      const nextInteraction = interactions[index + 1]
      if (nextInteraction === undefined) continue
      const nextSeq = nextInteraction.inputSeq
      const answerEvent = events.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> =>
        event.type === 'assistant/message' && event.seq > interaction.inputSeq && event.seq < nextSeq
          && event.data.interrupted !== true && eventContent(event) !== undefined).at(-1)
      const content = answerEvent === undefined ? undefined : eventContent(answerEvent)
      if (answerEvent !== undefined && content !== undefined) {
        interaction.answer = { content, confidence: 'inferred', ref: eventRef(answerEvent) }
      }
    }
  }

  const localHuman = events.filter(event => directHuman(event, 0)).map(eventContent)
    .filter((content): content is SafeHistoryContentV1 => content !== undefined)
  const explicitTitle = events.reduce<string | undefined>((title, event) => event.type === 'session/title' ? event.data.title : title, undefined)
  const label = (content: SafeHistoryContentV1 | undefined): string | undefined => content?.text
    ?? (content?.imageCount === 1 ? 'Image' : content?.imageCount === undefined ? undefined : `${content.imageCount} images`)
  const title = explicitTitle ?? label(localHuman[0]) ?? header.id
  const last = label(localHuman.at(-1))
  const finalOutcome = [...interactions].reverse().find(row => row.outcome.kind !== 'unknown')?.outcome.kind
  const status = finalOutcome === undefined || finalOutcome === 'open' || finalOutcome === 'unknown' ? undefined : finalOutcome
  return {
    version: SESSION_HISTORY_DTO_VERSION,
    sessionId: header.id,
    createdAt: header.createdAt,
    updatedAt: events.at(-1)?.time ?? header.createdAt,
    asOfSeq: events.at(-1)?.seq ?? -1,
    title,
    ...(last === undefined || last === title ? {} : { preview: last }),
    ...(status === undefined ? {} : { status }),
    classification,
    interactions: interactions.map(({ inputSeq: _inputSeq, ...interaction }) => interaction),
  }
}

function catalogOrder(left: SessionHistoryProjectionV1, right: SessionHistoryProjectionV1): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId)
}

function cursorFor(item: SessionHistoryProjectionV1): string {
  return `shp1:${item.updatedAt}:${item.createdAt}:${encodeURIComponent(item.sessionId)}`
}

/** Stable exclusive-cursor pagination for catalog/history carriers. */
export function paginateSessionHistoryV1(
  projections: readonly SessionHistoryProjectionV1[],
  options: { readonly limit: number; readonly cursor?: string; readonly bucket?: SessionBucketV1 },
): SessionHistoryCatalogPageV1 {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)))
  const ordered = projections.filter(item => options.bucket === undefined || item.classification.bucket === options.bucket)
    .slice().sort(catalogOrder)
  const start = options.cursor === undefined ? 0 : ordered.findIndex(item => cursorFor(item) === options.cursor) + 1
  const boundedStart = start <= 0 && options.cursor !== undefined ? ordered.length : start
  const items = ordered.slice(boundedStart, boundedStart + limit)
  const hasMore = boundedStart + items.length < ordered.length
  return {
    version: SESSION_HISTORY_DTO_VERSION,
    items,
    ...(hasMore && items.length > 0 ? { nextCursor: cursorFor(items.at(-1)!) } : {}),
  }
}

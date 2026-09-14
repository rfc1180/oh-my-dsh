/**
 * Active-agent/session runtime shared by the runner and command plugins.
 *
 * This is the deep module between Harness runtime services and the TUI:
 * Agent creation, replacement, persistence lookup, model selection, recent
 * sessions, projections, command routing, and cleanup stay behind one API.
 * @module @agi-fans/dsh-tui/session-controller
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset, type AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  createUserMessage,
  type LlmResolvedModelInfo,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type {} from '@deepseek-ai/dsh-attachment'
import { isTokenDelta } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-commands'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/types'
import { isUserInvocable, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ToolPresentationMode } from '@deepseek-ai/dsh-tools'
import type {
  TuiCommand,
  TuiInspectedSubagent,
  TuiRecentSession,
  TuiService,
  TuiSessionManagerSource,
  TuiSessionManagerSession,
  TuiSessionCatalogPage,
  TuiSessionCatalogRequest,
  TuiSessionCatalogRow,
  TuiSessionHistoryInteraction,
  TuiSessionHistoryPage,
  TuiSessionHistoryPageRequest,
  TuiSessionControls,
  TuiSessionStats,
  TuiSubmission,
  TuiInputImage,
} from '../definition.ts'
import { descendantDepth, isSteerableSubagent, SubagentRoster } from './subagent-roster.ts'
import type {} from '../runtime/tool-presentation.ts'
import type { StartupMilestone } from '../runtime/startup-telemetry.ts'
import * as commandPermission from '../commands/permission.ts'
import {
  defaultToolPresentation,
  isBlankSession,
  resolveToolPresentation,
  type SessionConfiguration,
} from './session-configuration.ts'
import { stripComposerImageMarkers } from '../input/image-paste.ts'
import { activeTranscriptSource } from './active-transcript-source.ts'

const SESSION_INFO_COALESCE_MS = 50

/** Keep transcript delivery immediate while coalescing aggregate footer projections. */
export class SessionPresentationController {
  readonly #tui: TuiService
  readonly #pushSessionInfo: () => void
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(tui: TuiService, pushSessionInfo: () => void) {
    this.#tui = tui
    this.#pushSessionInfo = pushSessionInfo
  }

  event(event: SessionEvent, presentation?: Parameters<TuiService['event']>[1]): void {
    this.#tui.event(event, presentation)
    if (event.type === 'assistant/chunk') this.#schedule()
    else this.flush()
  }

  sessionInfoChanged(): void {
    this.#schedule()
  }

  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#disposed) this.#pushSessionInfo()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#disposed) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#disposed) this.#pushSessionInfo()
    }, SESSION_INFO_COALESCE_MS)
  }
}

interface ActiveSession {
  handle: AgentHandle
  selection: ModelSelectionRef
  contextWindow: number | undefined
  reasoningEffort: string | undefined
  configuration: SessionConfiguration
  disposeToolPresentation: () => void
}

interface ConfiguredAgentContext extends SessionConfiguration {
  disposeToolPresentation: () => void
}

export type DetachedConversationForkMode = 'completed' | 'current-task'

/** Durable identity and lineage of a detached fork of the active conversation. */
export interface DetachedConversationFork {
  readonly childSessionId: SessionId
  readonly parentSessionId: SessionId
  readonly cwd: string
  readonly seedLength: number
}

/** Build a balanced snapshot, optionally retaining the active human request as context. */
export function detachedConversationSeed(
  events: readonly SessionEvent[],
  status: Agent['status'],
  mode: DetachedConversationForkMode,
): readonly SessionEvent[] {
  if (status === 'idle') return Object.freeze([...events])

  const lastCompletedIndex = events.findLastIndex(event => event.type === 'turn/end')
  const completed = events.slice(0, lastCompletedIndex + 1)
  if (mode === 'completed') return Object.freeze(completed)

  let currentTask: SessionEvent<'user/message'> | undefined
  for (let index = lastCompletedIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') currentTask = event
  }
  if (currentTask === undefined) return Object.freeze(completed)
  return Object.freeze([
    ...completed,
    {
      type: 'user/message',
      seq: completed.length,
      time: currentTask.time,
      data: currentTask.data,
      surfaceOp: 'append',
    },
  ])
}

async function setupAgentContext(
  agentCtx: Context,
  selection: ModelSelectionRef,
  restoreDurableSelection = false,
): Promise<ConfiguredAgentContext> {
  const agent = agentCtx.agent
  if (agent === undefined) throw new Error('agent setup context has no agent')
  if (restoreDurableSelection && selection.current !== undefined) {
    selection.current = resolveDurableModelSelection(agent.session.events, selection.current)
  }
  installModelSelection(agentCtx, selection)
  const agentPresets = agentCtx.get('agentPresets')
  const tools = agentCtx.get('tools')
  if (agentPresets === undefined || tools === undefined) throw new Error('agent configuration services are unavailable')
  const agentPreset = resolveSessionPreset(agent.session) ?? agentPresets.defaultId
  const mounted = await agentPresets.mount(agentCtx, agentPreset)
  const presentation = resolveToolPresentation(agent.session.events, mounted.id)
  const disposeToolPresentation = tools.presentAs(presentation.tools)
  try {
    await agentCtx.plugin(commandPermission)
    return { agentPreset: mounted.id, ...presentation, disposeToolPresentation }
  } catch (error: unknown) {
    disposeToolPresentation()
    throw error
  }
}

function parseControl(line: string): { name: string; input: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?)(?:\s+(.*))?$/su.exec(line.trim())
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1].toLowerCase(), input: match[2]?.trim() ?? '' }
}

/** Projection values consumed as one consistent snapshot when the units exist. */
export interface TuiStatsProjection {
  sessionStats?: SessionStatsProjection
  tokenUsage?: TokenUsageProjection
  contextPressure?: ContextPressureProjection
  plan?: PlanProjection
  permissions?: PermissionSelect
}

/** Present only the session controls whose owning Harness plugins are composed. */
export function sessionControls(projection?: TuiStatsProjection): TuiSessionControls {
  return {
    ...(projection?.plan === undefined ? {} : { plan: { ...projection.plan } }),
    ...(projection?.permissions === undefined ? {} : { permission: projection.permissions.currentValue }),
  }
}

/** Composer projection of a Harness model selection and its adapter default. */
export function modelStatus(
  selection: ModelSelection,
  info?: Pick<LlmResolvedModelInfo, 'reasoning'>,
): { model: string; reasoningEffort?: string } {
  const effort = selection.reasoningEffort ?? info?.reasoning?.defaultEffort
  return {
    model: selection.model,
    ...(effort === undefined ? {} : { reasoningEffort: String(effort) }),
  }
}

/** Resume with this conversation's last durable request route, not a mutable global default. */
export function resolveDurableModelSelection(
  events: readonly SessionEvent[],
  fallback: ModelSelection,
): ModelSelection {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const config = event.data.header.config
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
  }
  return fallback
}

/** Fold a complete log as the capability-absence fallback for projections. */
export function sessionStats(
  events: readonly SessionEvent[],
  contextWindow?: number,
  projection?: TuiStatsProjection,
): TuiSessionStats {
  const projectedStats = projection?.sessionStats
  const projectedUsage = projection?.tokenUsage
  const pressure = projection?.contextPressure
  const projectedContext = pressure?.projectedTokens ?? pressure?.pressureTokens
  const projectedWindow = pressure?.contextWindow ?? contextWindow
  if (projectedStats !== undefined && projectedUsage !== undefined && projectedContext !== undefined) {
    const first = events[0]?.time
    const last = events[events.length - 1]?.time
    return {
      ...projectedStats,
      inputTokens: projectedUsage.uncachedInputTokens
        + projectedUsage.cacheReadTokens
        + projectedUsage.cacheWriteTokens,
      outputTokens: projectedUsage.outputTokens,
      cacheReadTokens: projectedUsage.cacheReadTokens,
      cacheWriteTokens: projectedUsage.cacheWriteTokens,
      contextTokens: projectedContext,
      ...(projectedWindow === undefined ? {} : { contextWindow: projectedWindow }),
      ...(first === undefined || last === undefined ? {} : { elapsedMs: Math.max(0, last - first) }),
    }
  }
  let turns = 0
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let contextTokens: number | undefined
  let first: number | undefined
  let last: number | undefined
  let lastTurn: number | undefined
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime?: number } | undefined
  const pendingCalls = new Map<string, number>()
  for (const event of events) {
    first ??= event.time
    last = event.time
    switch (event.type) {
      case 'step/start':
        openStep = { turn: event.data.turn, step: event.data.step, startTime: event.time }
        break
      case 'assistant/chunk':
        if (openStep !== undefined
          && openStep.turn === event.data.turn
          && openStep.step === event.data.step
          && openStep.firstTokenTime === undefined
          && isTokenDelta(event.data.chunk)) {
          openStep.firstTokenTime = event.time
        }
        break
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) {
          const read = usage.cacheReadTokens ?? 0
          const write = usage.cacheWriteTokens ?? 0
          const billedInput = usage.inputTokens + read + write
          inputTokens += billedInput
          outputTokens += usage.outputTokens
          cacheReadTokens += read
          cacheWriteTokens += write
          contextTokens = billedInput + usage.outputTokens
        }
        if (openStep === undefined || openStep.turn !== event.data.turn || openStep.step !== event.data.step) break
        llmMs += Math.max(0, event.time - openStep.startTime)
        if (openStep.firstTokenTime !== undefined) {
          ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
          ttftSteps += 1
          if (usage !== undefined) {
            decodeMs += Math.max(0, event.time - openStep.firstTokenTime)
            decodeTokens += usage.outputTokens
          }
        }
        openStep = undefined
        break
      }
      case 'tool/call':
        pendingCalls.set(event.data.callId, event.time)
        break
      case 'tool/result': {
        const source = event.data.message.source
        if (source.kind !== 'tool') break
        const dispatched = pendingCalls.get(source.callId)
        if (dispatched === undefined) break
        toolMs += Math.max(0, event.time - dispatched)
        pendingCalls.delete(source.callId)
        break
      }
      case 'step/end':
        turns += lastTurn === event.data.turn ? 0 : 1
        steps += 1
        lastTurn = event.data.turn
        openStep = undefined
        break
      case 'turn/end':
        pendingCalls.clear()
        break
    }
  }
  const projectedInput = projectedUsage === undefined
    ? undefined
    : projectedUsage.uncachedInputTokens + projectedUsage.cacheReadTokens + projectedUsage.cacheWriteTokens
  const fallbackContext = projectedContext ?? contextTokens
  return {
    turns: projectedStats?.turns ?? turns,
    steps: projectedStats?.steps ?? steps,
    llmMs: projectedStats?.llmMs ?? llmMs,
    toolMs: projectedStats?.toolMs ?? toolMs,
    ttftMs: projectedStats?.ttftMs ?? ttftMs,
    ttftSteps: projectedStats?.ttftSteps ?? ttftSteps,
    decodeMs: projectedStats?.decodeMs ?? decodeMs,
    decodeTokens: projectedStats?.decodeTokens ?? decodeTokens,
    inputTokens: projectedInput ?? inputTokens,
    outputTokens: projectedUsage?.outputTokens ?? outputTokens,
    cacheReadTokens: projectedUsage?.cacheReadTokens ?? cacheReadTokens,
    cacheWriteTokens: projectedUsage?.cacheWriteTokens ?? cacheWriteTokens,
    ...(fallbackContext === undefined ? {} : { contextTokens: fallbackContext }),
    ...(projectedWindow === undefined ? {} : { contextWindow: projectedWindow }),
    ...(first === undefined || last === undefined ? {} : { elapsedMs: Math.max(0, last - first) }),
  }
}

function explicitSessionTitle(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title') return event.data.title
  }
  return undefined
}

function humanMessageText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const text = event.data.content
    .filter((block): block is Extract<(typeof event.data.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text === '' ? undefined : text
}

/** One direct human turn that can become a safe fork boundary. */
export interface ConversationTurn {
  /** Harness turn number shown to the user. */
  turn: number
  /** Index of the direct user/message event in the immutable log. */
  messageIndex: number
  /** Balanced seed boundary immediately before this turn starts. */
  branchIndex: number
  /** Single-line selector preview. */
  preview: string
  /** Number of image blocks in the selected message. */
  imageCount: number
}

/** Find direct human messages whose preceding log prefix is safe to seed into a fork. */
export function conversationTurns(events: readonly SessionEvent[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let open: { turn: number; branchIndex: number } | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/start') {
      open = { turn: event.data.turn, branchIndex: index }
      continue
    }
    if (event.type === 'turn/end') {
      if (open?.turn === event.data.turn) open = undefined
      continue
    }
    if (open === undefined || event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block): block is Extract<(typeof event.data.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .replace(/\s+/gu, ' ')
      .trim()
    const imageCount = event.data.content.filter(block => block.type === 'image').length
    if (text === '' && imageCount === 0) continue
    turns.push({
      turn: open.turn,
      messageIndex: index,
      branchIndex: open.branchIndex,
      preview: text === '' ? (imageCount === 1 ? 'Image' : `${imageCount} images`) : text,
      imageCount,
    })
  }
  return turns
}

/** Title and latest-human-message preview for durable session discovery. */
export function recentSessionContent(events: readonly SessionEvent[]): { title: string; preview?: string } | undefined {
  const generatedTitle = explicitSessionTitle(events)
  const firstMessage = events.map(humanMessageText).find((text): text is string => text !== undefined)
  if (firstMessage === undefined) return undefined
  let lastMessage: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    lastMessage = humanMessageText(events[index] as SessionEvent)
    if (lastMessage !== undefined) break
  }
  const title = generatedTitle ?? firstMessage
  return {
    title,
    ...(lastMessage === undefined || lastMessage === title ? {} : { preview: lastMessage }),
  }
}

export function recentSessionStatus(events: readonly SessionEvent[]): TuiRecentSession['status'] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') return 'interrupted'
    if (event?.type !== 'turn/end') continue
    if (event.data.reason.kind === 'completed') return 'done'
    if (event.data.reason.kind === 'error') return 'failed'
    if (event.data.reason.kind === 'blocked' || event.data.reason.kind === 'max-tokens') return 'blocked'
    return 'interrupted'
  }
  return undefined
}

/** Convert the human-visible part of a skill catalog into slash commands. */
export function userSkillCommands(skills: readonly SkillSummary[]): TuiCommand[] {
  return skills.filter(isUserInvocable).map(skill => ({
    name: `skill:${skill.name}`,
    description: compactDescription(skill.description),
  }))
}

function skillNameFromCommand(name: string): string {
  return name.startsWith('skill:') ? name.slice('skill:'.length) : name
}

function compactDescription(value: string, maxLength: number = 140): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 1).trimEnd() + '…'
}

interface SubmissionAttachmentStore {
  validateImage(input: SaveImageAttachment): Promise<void>
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}

interface RestoreAttachmentStore {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

/** Validate all drafts, persist them, then build one atomic mixed user message. */
export async function createSubmissionMessage(
  submission: TuiSubmission,
  attachments?: SubmissionAttachmentStore,
) {
  const inputs: SaveImageAttachment[] = submission.images.map(image => ({
    data: image.data,
    mediaType: image.mediaType,
    ...(image.name === undefined ? {} : { name: image.name }),
  }))
  if (inputs.length > 0 && attachments === undefined) throw new Error('Attachment storage is not configured.')
  const refs: ImageAttachmentRef[] = []
  if (attachments !== undefined) {
    for (const input of inputs) await attachments.validateImage(input)
    for (const input of inputs) refs.push(await attachments.saveImage(input))
  }
  const content = [
    ...(submission.text === '' ? [] : [{ type: 'text' as const, text: submission.text }]),
    ...refs.map(attachment => ({ type: 'image' as const, attachment })),
  ]
  if (content.length === 0) throw new Error('Cannot submit an empty message.')
  return createUserMessage({ content, source: { kind: 'user' } })
}

/** Encode composer drafts for `ctx.commands.execute`. */
export function encodeComposerImages(images: readonly TuiInputImage[]): EncodedImageAttachment[] {
  return images.map(image => ({
    mediaType: image.mediaType,
    data: Buffer.from(image.data).toString('base64'),
    ...(image.name === undefined ? {} : { name: image.name }),
  }))
}

/** Rehydrate one durable human inbox message into an editable composer draft. */
export async function restoreSubmissionMessage(
  message: UserMessage,
  attachments?: RestoreAttachmentStore,
): Promise<TuiSubmission> {
  const text = message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  const refs = message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'image' }> => block.type === 'image')
    .map(block => block.attachment)
  if (refs.length > 0 && attachments === undefined) {
    throw new Error('The queued message contains images, but attachment storage is unavailable.')
  }
  const images = await Promise.all(refs.map(async (ref) => {
    const stored = await attachments?.readImage(ref)
    if (stored === undefined) throw new Error('Unable to restore an image from the queued message.')
    return {
      data: stored.data,
      mediaType: stored.ref.mediaType,
      ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
      width: stored.ref.width,
      height: stored.ref.height,
    }
  }))
  return { text, images }
}

interface ViewportPersistenceExtension {
  omdshViewportTail?: (id: string, signal?: AbortSignal) => Promise<{
    id: string
    revision: string
    checkpointSeq: number
    eventCount: number
    events: readonly SessionEvent[]
  } | undefined>
  omdshRefreshViewportTail?: (id: string, knownNextSeq?: number, signal?: AbortSignal) => Promise<void>
}

/** Own one switchable top-level Agent and project it onto a TuiService. */
export class SessionRuntime {
  readonly #ctx: Context
  readonly #tui: TuiService
  #active: ActiveSession | undefined
  #recent: TuiRecentSession[] = []
  #skillCommands: TuiCommand[] = []
  #started = false
  readonly #hydrations = new Set<Promise<void>>()
  readonly #retired: AgentHandle[] = []
  #disposed = false
  readonly #off: Array<() => void> = []
  readonly #subagents = new SubagentRoster()
  #subagentEpoch = 0
  #inspectEpoch = 0
  #inspectedId: string | undefined
  readonly #presentation: SessionPresentationController

  constructor(ctx: Context, tui: TuiService) {
    this.#ctx = ctx
    this.#tui = tui
    this.#presentation = new SessionPresentationController(tui, () => { this.#pushSessionInfo() })
    this.#off.push(tui.onInspectSubagent(id => { void this.#inspectSubagent(id) }))
    this.#off.push(tui.onInspectClose(() => { this.#closeInspect() }))
    this.#off.push(tui.onInspectSubmit(submission => { void this.#steerInspected(submission) }))
    tui.setSessionSearch(async (query, signal) => {
      const agent = this.#active?.handle.agent
      const resolver = this.#ctx.get('sessionReferenceResolver')
      if (agent === undefined || resolver === undefined) return []
      return resolver.listCandidates(agent, query, 20, signal)
    })
    const fileReferences = this.#ctx.get('fileReferences')
    if (fileReferences !== undefined) {
      tui.setFileSearch(async (query, signal) => {
        const agent = this.#active?.handle.agent
        if (agent === undefined) return []
        return fileReferences.list(agent, query, signal ?? new AbortController().signal)
      })
    }
    const attachments = this.#ctx.get('attachments')
    if (attachments !== undefined) {
      tui.setImageValidator(image => attachments.validateImage({
        data: image.data,
        mediaType: image.mediaType,
        ...(image.name === undefined ? {} : { name: image.name }),
      }))
    }
    this.#off.push(ctx.on('agent/status', (payload) => {
      if (payload.agent === this.#active?.handle.agent) {
        if (this.#inspectedId === undefined) tui.setStatus(payload.status)
        return
      }
      if (payload.agent.id === this.#inspectedId) tui.setStatus(payload.status)
      this.#noteSubagentStatus(payload.agent.session, payload.status)
    }))
    this.#off.push(ctx.on('session/created', (session) => {
      this.#noteSubagentSession(session)
    }))
    this.#off.push(ctx.on('session/disposed', (session) => {
      if (!this.#subagents.owns(session.id)) return
      this.#subagents.setAgentStatus(session.id, 'gone')
      this.#pushSubagents()
    }))
    this.#off.push(ctx.on('session/event', (session, event) => {
      const active = this.#active
      if (active === undefined) return
      if (session.id === this.#inspectedId) {
        const child = ctx.get('agents')?.get(session.id)
        tui.event(event, child === undefined ? undefined : ctx.get('tuiToolPresentation')?.event(child, event))
        this.#noteSubagentEvent(session, event)
        return
      }
      if (session === active.handle.agent.session) {
        if (this.#inspectedId === undefined) {
          this.#presentation.event(event, ctx.get('tuiToolPresentation')?.event(active.handle.agent, event))
        } else {
          this.#presentation.sessionInfoChanged()
        }
        if (event.type === 'session/title') void this.refreshRecent()
        return
      }
      this.#noteSubagentEvent(session, event)
    }))
    if (ctx.get('commands') !== undefined) {
      this.#off.push(ctx.on('commands/change', () => { this.#pushCommands() }))
    }
    if (ctx.get('skills') !== undefined) {
      this.#off.push(ctx.on('skills/change', () => { void this.#refreshSkills() }))
    }
    if (ctx.get('tools') !== undefined) {
      this.#off.push(ctx.on('tools/change', () => {
        this.#pushTools()
        const active = this.#active
        if (active !== undefined) this.#replaceVisibleTranscript()
      }))
    }
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined) {
      this.#off.push(projections.onChanged((session, key) => {
        if (session !== this.#active?.handle.agent.session) return
        if (key === 'sessionStats' || key === 'tokenUsage' || key === 'contextPressure'
          || key === 'plan' || key === 'permissions') this.#presentation.sessionInfoChanged()
      }))
    }
  }

  get agent(): Agent | undefined {
    return this.#active?.handle.agent
  }

  /**
   * Interrupt the visible continuable child when one is inspected.
   * @returns true when this consumed the gesture so the parent turn stays running.
   */
  interruptVisible(): boolean {
    if (this.#inspectedId === undefined) return false
    const root = this.#active?.handle.agent
    if (root !== undefined) {
      this.#ctx.get('subagents')?.interrupt(SessionId(this.#inspectedId), { kind: 'ancestor', agent: root })
    }
    return true
  }

  async start(
    resumeId?: string,
    signal?: AbortSignal,
    milestone?: (milestone: StartupMilestone) => void,
  ): Promise<void> {
    if (this.#started) return
    this.#started = true
    const defaults = this.#ctx.get('agentDefaultModel')?.currentSelection()
    if (defaults === undefined) throw new Error('agent default model is unavailable')
    let targetSettled = false
    const persistence = this.#ctx.get('sessionPersistence') as unknown as ViewportPersistenceExtension | undefined
    const viewport = resumeId === undefined ? undefined : persistence?.omdshViewportTail?.(resumeId, signal)
    if (viewport !== undefined) {
      void viewport.then((snapshot) => {
        if (!targetSettled && snapshot !== undefined && snapshot.id === resumeId) {
          this.#tui.replaceViewportTail(snapshot.events)
        }
      }, () => undefined)
    }
    let active: ActiveSession
    try {
      active = resumeId === undefined
        ? await this.#create(defaults)
        : await this.#resume(resumeId, defaults, signal)
    } finally {
      // A late cache read must never replace the validated target frame.
      targetSettled = true
    }
    milestone?.('targetAgentReady')
    this.#activate(active, false)
    milestone?.('targetFrame')
    this.#hydrate(active, milestone)
  }

  /** Settle background startup catalogs for tests, shutdown, and explicit diagnostics. */
  async whenHydrated(): Promise<void> {
    await Promise.allSettled([...this.#hydrations])
  }

  /** Submit one human composer value; active turns retain it as a later follow-up. */
  async send(input: string | TuiSubmission, agent: Agent = this.#requiredAgent()): Promise<void> {
    this.assertActive(agent)
    const submission = typeof input === 'string' ? { text: input, images: [] } : input
    const message = await createSubmissionMessage(submission, this.#ctx.get('attachments'))
    this.assertActive(agent)
    agent.followup(message)
  }

  /** Remove and rehydrate the newest durable human follow-up for queue browsing. */
  async editLatestFollowup(agent: Agent = this.#requiredAgent()): Promise<TuiSubmission | undefined> {
    this.assertActive(agent)
    const message = agent.inbox.nextTurn.findLast(candidate => candidate.source.kind === 'user')
    if (message === undefined || !agent.inbox.remove(message.id)) return undefined
    try {
      const submission = await restoreSubmissionMessage(message, this.#ctx.get('attachments'))
      this.assertActive(agent)
      return submission
    } catch (error: unknown) {
      try { agent.inbox.append('next-turn', message) } catch { /* agent retired or message was restored elsewhere */ }
      throw error
    }
  }

  /** Execute a plugin-owned slash command, falling back to user-invocable skills. */
  async execute(
    line: string,
    signal: AbortSignal,
    images: readonly TuiInputImage[] = [],
  ): Promise<boolean> {
    const commandLine = stripComposerImageMarkers(line, images)
    const parsed = parseControl(commandLine)
    if (parsed === undefined) return false
    const commands = this.#ctx.get('commands')
    const execution = await (async () => {
      try {
        return await commands?.execute(
          this.#requiredAgent(),
          commandLine,
          encodeComposerImages(images),
          signal,
        )
      } finally {
        await this.#disposeRetired()
      }
    })()
    if (execution === undefined) {
      const skill = await this.#findUserSkill(skillNameFromCommand(parsed.name), signal)
      if (skill === undefined) return false
      if (images.length > 0) {
        this.#tui.restoreInput({ text: line, images })
        this.#tui.notice(`/${parsed.name} does not accept image attachments`, { level: 'error' })
        return true
      }
      await this.send('/' + skill.name + (parsed.input === '' ? '' : ' ' + parsed.input))
      return true
    }
    const result = execution.result
    if (result.kind === 'error' && images.length > 0) this.#tui.restoreInput({ text: line, images })
    if (result.text !== undefined) {
      if (result.kind === 'error') this.#tui.notice(result.text, { level: 'error' })
      else this.#tui.commandOutput(parsed.name, result.text)
    }
    return true
  }

  /** Fail when a command invocation targets a stale or background Agent. */
  assertActive(agent: Agent): void {
    if (agent !== this.#requiredAgent()) throw new Error('the command does not target the active omdsh session')
  }

  /** Immutable recent-session view used by the resume command. */
  get recentSessions(): readonly TuiRecentSession[] {
    return this.#recent
  }

  /** Current model selection for the active Agent. */
  selection(agent: Agent = this.#requiredAgent()): ModelSelection {
    this.assertActive(agent)
    const current = this.#requiredActive().selection.current
    if (current === undefined) throw new Error('active agent has no model selection')
    return current
  }

  /** Replace the active Agent's selection and persist it as the next default. */
  async changeSelection(agent: Agent, selection: ModelSelection, info?: LlmResolvedModelInfo): Promise<void> {
    this.assertActive(agent)
    const active = this.#requiredActive()
    active.selection.current = selection
    const resolved = info ?? await this.#resolveModelInfo(selection)
    active.contextWindow = resolved?.context?.contextWindow
    const status = modelStatus(selection, resolved)
    active.reasoningEffort = status.reasoningEffort
    this.#tui.setModel(status.model, status.reasoningEffort)
    this.#pushSessionInfo()
    await this.#ctx.get('agentDefaultModel')?.saveSelection(selection)
  }

  /** Start a new top-level session with the current model selection. */
  async newSession(agent: Agent): Promise<void> {
    this.assertActive(agent)
    this.#activate(await this.#create(this.selection(agent)))
  }

  /** Replace the active top-level session with one durable session. */
  async resumeSession(agent: Agent, id: string, signal: AbortSignal): Promise<void> {
    this.assertActive(agent)
    this.#activate(await this.#resume(id, this.selection(agent), signal))
  }

  /**
   * Durably publish a detached child from an immutable conversation snapshot.
   * During an active turn the default seed ends at the last completed response;
   * the optional current-task mode also retains the active human request.
   * The active Agent and composer remain untouched; the temporary child is
   * disposed after persistence drains its published seed.
   */
  async createDetachedFork(
    signal?: AbortSignal,
    mode: DetachedConversationForkMode = 'completed',
  ): Promise<DetachedConversationFork> {
    const parent = this.#requiredAgent()
    const parentWasIdle = parent.status === 'idle'
    const cwd = parent.session.header.cwd
    if (cwd === undefined) throw new Error('The active session has no working directory.')
    const active = this.#requiredActive()
    const agentPreset = active.configuration.agentPreset
    const selection = { ...this.selection(parent) }
    const seed = detachedConversationSeed(parent.session.events, parent.status, mode)
    const childSessionId = SessionId('session-' + randomUUID())
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    let configured: ConfiguredAgentContext | undefined
    let handle: AgentHandle
    try {
      handle = await this.#ctx.agents.create({
        sessionId: childSessionId,
        seed,
        meta: {
          cwd,
          parentSession: parent.id,
          seedLength: seed.length,
          agentPreset,
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        ...(signal === undefined ? {} : { signal }),
        setup: async (agentCtx) => {
          configured = await setupAgentContext(agentCtx, ref)
          return {
            commit: () => {
              this.assertActive(parent)
              const currentSelection = this.selection(parent)
              const idleConversationChanged = parentWasIdle && (
                parent.status !== 'idle'
                || parent.session.events.length !== seed.length
                || parent.session.events.at(-1)?.seq !== seed.at(-1)?.seq
              )
              const parentChanged = idleConversationChanged
                || parent.session.header.cwd !== cwd
                || this.#requiredActive().configuration.agentPreset !== agentPreset
                || currentSelection.provider !== selection.provider
                || currentSelection.model !== selection.model
                || currentSelection.reasoningEffort !== selection.reasoningEffort
              if (parentChanged) {
                throw new Error('The active conversation changed before the fork was published.')
              }
            },
          }
        },
      })
    } catch (error: unknown) {
      configured?.disposeToolPresentation()
      throw error
    }
    try {
      this.assertActive(parent)
      if (configured === undefined) {
        throw new Error('detached fork was published without session configuration')
      }
      return {
        childSessionId,
        parentSessionId: parent.id,
        cwd,
        seedLength: seed.length,
      }
    } finally {
      try {
        configured?.disposeToolPresentation()
      } finally {
        await handle.dispose()
      }
    }
  }

  /** Fork before a selected human turn and restore that message as an editable draft. */
  async rewindToTurn(signal: AbortSignal): Promise<void> {
    const agent = this.#requiredAgent()
    if (agent.status !== 'idle') return
    const events = agent.session.events
    const turns = conversationTurns(events)
    if (turns.length === 0) {
      this.#tui.notice('No conversation turns are available to rewind.')
      return
    }
    const newestFirst = [...turns].reverse()
    const answer = await this.#tui.prompt({
      title: 'Rewind Conversation',
      question: '',
      detail: 'original session preserved',
      options: newestFirst.map(turn => ({
        label: `Turn ${turn.turn}`,
        value: String(turn.messageIndex),
        preview: turn.preview,
        description: turn.imageCount === 0
          ? 'Branch before this message'
          : `Branch before this message · ${turn.imageCount} ${turn.imageCount === 1 ? 'image' : 'images'}`,
      })),
      initialValue: String(newestFirst[0]?.messageIndex),
      presentation: 'fullscreen-list',
      optionLayout: 'spacious',
      filterable: true,
      allowCustom: false,
      submitLabel: 'rewind',
      signal,
    })
    if (answer === null) return
    this.assertActive(agent)
    if (agent.status !== 'idle') throw new Error('Finish or interrupt the active turn before rewinding.')
    const selected = turns.find(turn => String(turn.messageIndex) === answer)
    if (selected === undefined) throw new Error('The selected conversation turn is no longer available.')
    const message = events[selected.messageIndex]
    if (message?.type !== 'user/message' || message.data.source.kind !== 'user') {
      throw new Error('The selected conversation turn is no longer available.')
    }
    const text = message.data.content
      .filter((block): block is Extract<(typeof message.data.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const imageRefs = message.data.content
      .filter((block): block is Extract<(typeof message.data.content)[number], { type: 'image' }> => block.type === 'image')
      .map(block => block.attachment)
    const attachments = this.#ctx.get('attachments')
    if (imageRefs.length > 0 && attachments === undefined) {
      throw new Error('The selected message contains images, but attachment storage is unavailable.')
    }
    const images = await Promise.all(imageRefs.map(async (ref) => {
      const stored = await attachments?.readImage(ref, signal)
      if (stored === undefined) throw new Error('Unable to restore an image from the selected message.')
      return {
        data: stored.data,
        mediaType: stored.ref.mediaType,
        ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
        width: stored.ref.width,
        height: stored.ref.height,
      }
    }))
    this.assertActive(agent)
    const selection = this.selection(agent)
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    const active = this.#requiredActive()
    let configured: ConfiguredAgentContext | undefined
    const handle = await this.#ctx.agents.create({
      sessionId: SessionId('session-' + randomUUID()),
      seed: events.slice(0, selected.branchIndex),
      meta: {
        ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
        parentSession: agent.id,
        seedLength: selected.branchIndex,
        agentPreset: active.configuration.agentPreset,
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      signal,
      setup: async (agentCtx) => { configured = await setupAgentContext(agentCtx, ref) },
    })
    try {
      this.assertActive(agent)
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    const configuration = configured
    if (configuration === undefined) {
      await handle.dispose()
      throw new Error('forked agent was published without session configuration')
    }
    this.#pinToolPresentation(handle.agent, configuration)
    await this.#activate({
      handle,
      selection: ref,
      contextWindow: undefined,
      reasoningEffort: undefined,
      configuration: {
        agentPreset: configuration.agentPreset,
        tools: configuration.tools,
        toolsSource: configuration.toolsSource,
      },
      disposeToolPresentation: configuration.disposeToolPresentation,
    })
    this.#tui.restoreInput({ text, images })
    this.#tui.notice(`Rewound to before turn ${selected.turn}. The original session remains available in /resume.`)
    await this.#disposeRetired()
  }

  /** Whole-session figures for the active Agent. */
  stats(agent: Agent = this.#requiredAgent()): TuiSessionStats {
    this.assertActive(agent)
    return this.#stats(this.#requiredActive())
  }

  /** Effective reasoning effort after applying the selected model's adapter default. */
  reasoningEffort(agent: Agent = this.#requiredAgent()): string | undefined {
    this.assertActive(agent)
    return this.#requiredActive().reasoningEffort
  }

  /** Harness-owned workflow/access state plus creation-time Agent/tool configuration. */
  controls(agent: Agent = this.#requiredAgent()): TuiSessionControls {
    this.assertActive(agent)
    const active = this.#requiredActive()
    return this.#sessionControls(active, this.#projection(active))
  }

  /** Agent presets available from the live Harness roster. */
  async agentPresets(): Promise<readonly AgentPreset[]> {
    return (await this.#ctx.agentPresets.list()).sort((left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id))
  }

  /** Recompose one blank session and restore that preset's recommended tool presentation. */
  async changeAgentPreset(agent: Agent, id: string): Promise<SessionConfiguration> {
    this.assertActive(agent)
    if (!isBlankSession(agent.session)) {
      throw new Error('Agent is locked after the first prompt. Start /new, then choose the Agent before sending a message.')
    }
    const active = this.#requiredActive()
    if (active.configuration.agentPreset === id) return { ...active.configuration }
    const previousPreset = active.configuration.agentPreset
    const preset = await this.#ctx.agentPresets.recompose(agent.ctx, id)
    try {
      this.#replaceToolPresentation(active, defaultToolPresentation(preset.id), 'preset-default')
    } catch (error: unknown) {
      await this.#ctx.agentPresets.recompose(agent.ctx, previousPreset)
      throw error
    }
    active.configuration.agentPreset = preset.id
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
    this.#pushTools()
    this.#pushCommands()
    await this.#refreshSkills()
    this.#replaceTranscript(agent)
    this.#pushSessionInfo()
    return { ...active.configuration }
  }

  /** Change how one blank session exposes its real Harness tool registry to the model. */
  changeToolPresentation(agent: Agent, mode: ToolPresentationMode): SessionConfiguration {
    this.assertActive(agent)
    if (!isBlankSession(agent.session)) {
      throw new Error('Tools are locked after the first prompt. Start /new, then choose the tool presentation before sending a message.')
    }
    const active = this.#requiredActive()
    if (active.configuration.tools !== mode || active.configuration.toolsSource !== 'user') {
      this.#replaceToolPresentation(active, mode, 'user')
      this.#pushTools()
      this.#replaceTranscript(agent)
      this.#pushSessionInfo()
    }
    return { ...active.configuration }
  }

  /** Select the Harness Plan Mode controller and immediately refresh terminal state. */
  changeWorkflow(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    this.assertActive(agent)
    const planMode = this.#ctx.get('planMode')
    if (planMode === undefined) throw new Error('Plan workflow is not configured.')
    const outcome = planMode.set(agent, active)
    this.#pushSessionInfo()
    return outcome
  }

  async refreshRecent(expected: ActiveSession | undefined = this.#active): Promise<void> {
    await this.#refreshSessions(8, expected)
  }

  sessionManagerSource(agent: Agent): TuiSessionManagerSource {
    this.assertActive(agent)
    const active = this.#requiredActive()
    const persistence = this.#ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session persistence is not configured.')
    const accelerated = persistence as typeof persistence & {
      omdshSemanticSessionCatalog?: (signal?: AbortSignal) => Promise<{
        readonly sessions: readonly TuiSessionCatalogRow[]
        readonly stale: boolean
      }>
      omdshHydrateSessionCatalog?: (signal?: AbortSignal) => Promise<TuiRecentSession[]>
      omdshViewportTail?: (id: string, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[] } | undefined>
      omdshProjectSessionHistory?: (id: string, signal?: AbortSignal) => Promise<{
        readonly version: 1
        readonly sessionId: string
        readonly title: string
        readonly createdAt: number
        readonly updatedAt: number
        readonly status?: 'completed' | 'failed' | 'blocked' | 'interrupted'
        readonly classification: { readonly bucket: 'human' | 'internal' | 'subagent' | 'legacy' }
        readonly interactions: readonly TuiSessionHistoryInteraction[]
      }>
    }
    const hydrateCatalog = accelerated.omdshHydrateSessionCatalog
    let rows: readonly TuiRecentSession[] = []
    const catalogCursor = (request: TuiSessionCatalogRequest, id: string): string =>
      `catalog-v1:${request.scope}:${request.sortField}:${request.sortDirection}:${encodeURIComponent(request.query ?? '')}:${encodeURIComponent(id)}`
    const historyCursors = new Map<string, { readonly id: string; readonly beforeSeq: number }>()
    const historyCursor = (id: string, beforeSeq: number): string => {
      const cursor = randomUUID()
      historyCursors.set(cursor, { id, beforeSeq })
      const oldest = historyCursors.size > 512 ? historyCursors.keys().next().value : undefined
      if (oldest !== undefined) historyCursors.delete(oldest)
      return cursor
    }
    const catalog = async (request: TuiSessionCatalogRequest, signal?: AbortSignal): Promise<TuiSessionCatalogPage> => {
      signal?.throwIfAborted()
      let classified: TuiSessionCatalogRow[]
      let stale = false
      if (accelerated.omdshSemanticSessionCatalog !== undefined) {
        if (request.hydrate === true && hydrateCatalog !== undefined) {
          await hydrateCatalog.call(persistence, signal)
          signal?.throwIfAborted()
        }
        const semantic = await accelerated.omdshSemanticSessionCatalog.call(persistence, signal)
        classified = semantic.sessions.map(row => ({ ...row }))
        stale = semantic.stale
        rows = classified.filter(row => row.scope === 'human').map(row => ({ ...row }))
      } else {
        await this.refreshAllSessions(active)
        signal?.throwIfAborted()
        rows = this.#recent.map(row => ({ ...row }))
        const summaries = new Map(rows.map(row => [row.id, row]))
        const headers = await persistence.list(signal)
        signal?.throwIfAborted()
        classified = headers.map(header => {
          const summary = summaries.get(header.id)
          const scope = header.origin === 'subagent' ? 'subagent' as const
            : summary === undefined ? 'internal' as const : 'human' as const
          return {
            id: header.id,
            title: summary?.title ?? header.id,
            ...(summary?.preview === undefined ? {} : { preview: summary.preview }),
            ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
            createdAt: header.createdAt,
            updatedAt: summary?.updatedAt ?? header.createdAt,
            eventCount: summary?.eventCount ?? 0,
            ...(summary?.status === undefined ? {} : { status: summary.status }),
            scope,
            turns: summary?.turns ?? 0,
            canResume: scope !== 'subagent',
          }
        })
      }
      const counts = {
        human: classified.filter(row => row.scope === 'human').length,
        internal: classified.filter(row => row.scope === 'internal').length,
        subagent: classified.filter(row => row.scope === 'subagent').length,
        legacy: classified.filter(row => row.scope === 'legacy').length,
      }
      const needle = request.query?.trim().toLocaleLowerCase() ?? ''
      const values = classified.filter(row => row.scope === request.scope && (needle === '' || [
        row.title, row.preview ?? '', row.id, row.cwd ?? '', row.status ?? '',
      ].some(value => value.toLocaleLowerCase().includes(needle))))
      const compareText = (left: string, right: string): number => left.localeCompare(right, undefined, { sensitivity: 'base' })
      values.sort((left, right) => {
        const primary = request.sortField === 'updated'
          ? (left.updatedAt ?? left.createdAt) - (right.updatedAt ?? right.createdAt)
          : request.sortField === 'created' ? left.createdAt - right.createdAt
            : request.sortField === 'project' ? compareText(left.cwd ?? '', right.cwd ?? '')
              : request.sortField === 'title' ? compareText(left.title, right.title)
                : request.sortField === 'status' ? compareText(left.status ?? '', right.status ?? '')
                  : left.turns - right.turns
        const directed = request.sortDirection === 'asc' ? primary : -primary
        return directed || left.id.localeCompare(right.id)
      })
      const expectedPrefix = `catalog-v1:${request.scope}:${request.sortField}:${request.sortDirection}:${encodeURIComponent(request.query ?? '')}:`
      const afterId = request.cursor?.startsWith(expectedPrefix) === true
        ? decodeURIComponent(request.cursor.slice(expectedPrefix.length)) : undefined
      const found = afterId === undefined ? -1 : values.findIndex(row => row.id === afterId)
      const start = afterId === undefined ? 0 : found < 0 ? values.length : found + 1
      const limit = Math.max(1, Math.min(request.limit ?? 50, 200))
      const sessions = values.slice(start, start + limit)
      const hasMore = start + sessions.length < values.length
      return {
        schemaVersion: 1,
        activeSessionId: agent.id,
        counts,
        sessions,
        ...(hasMore && sessions.at(-1) !== undefined ? { nextCursor: catalogCursor(request, sessions.at(-1)!.id) } : {}),
        hasMore,
        stale,
      }
    }
    const historyPage = async (request: TuiSessionHistoryPageRequest, signal?: AbortSignal): Promise<TuiSessionHistoryPage> => {
      const project = accelerated.omdshProjectSessionHistory
      if (project === undefined) throw new Error('Semantic session history is unavailable.')
      const cursor = request.cursor === undefined ? undefined : historyCursors.get(request.cursor)
      if (request.cursor !== undefined && cursor === undefined) throw new Error('Malformed or expired session history cursor.')
      if (cursor !== undefined && cursor.id !== request.id) throw new Error('Session history cursor belongs to another session.')
      signal?.throwIfAborted()
      const projection = await project.call(persistence, request.id, signal)
      signal?.throwIfAborted()
      const beforeSeq = cursor?.beforeSeq ?? Number.MAX_SAFE_INTEGER
      const eligible = projection.interactions.filter(interaction => interaction.input.ref.seq < beforeSeq)
      const limit = Math.max(1, Math.min(request.limit ?? 20, 50))
      const interactions = eligible.slice(-limit)
      const first = interactions[0]
      const hasMore = first !== undefined && eligible.some(interaction => interaction.input.ref.seq < first.input.ref.seq)
      return {
        schemaVersion: 1,
        sessionId: projection.sessionId,
        counts: {
          conversation: projection.interactions.length,
          prompts: projection.interactions.length,
          answers: projection.interactions.filter(interaction => interaction.answer !== undefined).length,
          technical: projection.interactions.reduce((total, interaction) => total + interaction.technicalTrace.length, 0),
        },
        interactions,
        ...(hasMore && first !== undefined ? { previousCursor: historyCursor(request.id, first.input.ref.seq) } : {}),
        hasMore,
      }
    }
    return {
      activeSessionId: agent.id,
      catalog,
      historyPage,
      list: async (signal) => {
        signal?.throwIfAborted()
        await this.refreshAllSessions(active)
        signal?.throwIfAborted()
        rows = this.#recent.map(row => ({ ...row }))
        return rows
      },
      ...(hydrateCatalog === undefined ? {} : {
        hydrate: async (signal?: AbortSignal) => {
          const hydrated = await hydrateCatalog.call(persistence, signal)
          signal?.throwIfAborted()
          // Hydration is authoritative classification, not a sticky metadata merge:
          // rows without local direct-human input must disappear instead of surviving as id placeholders.
          rows = hydrated.map(row => ({ ...row }))
          return rows
        },
      }),
      inspect: async (id, signal): Promise<TuiSessionManagerSession> => {
        signal?.throwIfAborted()
        const tail = await accelerated.omdshViewportTail?.(id, signal)
        const events = tail?.events ?? (await persistence.inspect(SessionId(id), signal)).events
        signal?.throwIfAborted()
        const existing = rows.find(row => row.id === id)
        const content = recentSessionContent(events)
        const createdAt = existing?.createdAt ?? events[0]?.time ?? Date.now()
        const status = recentSessionStatus(events)
        const indexedTitle = existing?.title === id ? undefined : existing?.title
        const title = indexedTitle ?? content?.title ?? id
        const preview = content?.preview ?? (content?.title === title ? undefined : content?.title) ?? existing?.preview
        return {
          id,
          title,
          ...(preview === undefined ? {} : { preview }),
          ...(existing?.cwd === undefined ? {} : { cwd: existing.cwd }),
          createdAt,
          updatedAt: events.at(-1)?.time ?? existing?.updatedAt ?? createdAt,
          eventCount: Math.max(existing?.eventCount ?? 0, events.length),
          ...(status === undefined ? existing?.status === undefined ? {} : { status: existing.status } : { status }),
          events,
        }
      },
    }
  }

  async refreshAllSessions(expected: ActiveSession | undefined = this.#active): Promise<void> {
    const persistence = this.#ctx.get('sessionPersistence')
    const accelerated = persistence as typeof persistence & {
      omdshSessionCatalog?: (signal?: AbortSignal) => Promise<TuiRecentSession[]>
    }
    if (accelerated?.omdshSessionCatalog !== undefined) {
      try {
        const rows = await accelerated.omdshSessionCatalog()
        if (expected !== this.#active) return
        this.#recent = rows
        this.#pushSessionInfo()
        return
      } catch {
        // Fail closed: the rc.8 inspect path remains authoritative for stale/corrupt indexes.
      }
    }
    await this.#refreshSessions(undefined, expected)
  }

  async #refreshSessions(limit: number | undefined, expected: ActiveSession | undefined): Promise<void> {
    const persistence = this.#ctx.get('sessionPersistence')
    if (persistence === undefined) {
      if (expected !== this.#active) return
      this.#recent = []
      this.#pushSessionInfo()
      return
    }
    const accelerated = persistence as typeof persistence & {
      omdshRecentSessions?: (limit: number, signal?: AbortSignal) => Promise<TuiRecentSession[]>
    }
    if (limit !== undefined && accelerated.omdshRecentSessions !== undefined) {
      try {
        const rows = await accelerated.omdshRecentSessions(limit)
        if (expected !== this.#active) return
        this.#recent = rows
        this.#pushSessionInfo()
        return
      } catch {
        // Fail closed: the rc.8 inspect path remains authoritative for stale/corrupt indexes.
      }
    }
    const headers = (await persistence.list()).filter(header => header.origin !== 'subagent')
      .sort((left, right) => right.createdAt - left.createdAt)
    const rows: TuiRecentSession[] = []
    for (const header of headers) {
      try {
        const inspected = await persistence.inspect(header.id)
        const status = recentSessionStatus(inspected.events)
        const content = recentSessionContent(inspected.events)
        if (content === undefined) continue
        rows.push({
          id: header.id,
          ...content,
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
          createdAt: header.createdAt,
          updatedAt: inspected.events.at(-1)?.time ?? header.createdAt,
          eventCount: inspected.events.length,
          ...(status === undefined ? {} : { status }),
        })
        if (limit !== undefined && rows.length >= limit) break
      } catch {
        rows.push({
          id: header.id,
          title: '(unavailable session)',
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
          createdAt: header.createdAt,
        })
        if (limit !== undefined && rows.length >= limit) break
      }
    }
    if (expected !== this.#active) return
    this.#recent = rows
    this.#pushSessionInfo()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#presentation.dispose()
    this.#subagentEpoch += 1
    this.#inspectedId = undefined
    this.#subagents.reset()
    this.#tui.setInspectedSubagent(undefined)
    this.#tui.setSubagents(undefined)
    this.#tui.setSessionSearch()
    this.#tui.setFileSearch()
    this.#tui.setImageValidator()
    this.#tui.setActiveTranscriptSource?.()
    for (const off of this.#off.splice(0).reverse()) off()
    await Promise.allSettled(this.#retired.splice(0).map(handle => handle.dispose()))
    await this.#active?.handle.dispose()
    this.#active = undefined
  }

  async #resume(id: string, selection: ModelSelection, signal?: AbortSignal): Promise<ActiveSession> {
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    let configured: ConfiguredAgentContext | undefined
    const handle = await this.#ctx.agents.resume({
      resumeSessionId: SessionId(id),
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(signal === undefined ? {} : { signal }),
      setup: async (agentCtx) => { configured = await setupAgentContext(agentCtx, ref, true) },
    })
    const configuration = configured
    if (configuration === undefined) {
      await handle.dispose()
      throw new Error('resumed agent was published without session configuration')
    }
    this.#pinToolPresentation(handle.agent, configuration)
    return {
      handle,
      selection: ref,
      contextWindow: undefined,
      reasoningEffort: undefined,
      configuration: {
        agentPreset: configuration.agentPreset,
        tools: configuration.tools,
        toolsSource: configuration.toolsSource,
      },
      disposeToolPresentation: configuration.disposeToolPresentation,
    }
  }

  async #create(selection: ModelSelection): Promise<ActiveSession> {
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    const preset = await this.#ctx.agentPresets.resolve()
    let configured: ConfiguredAgentContext | undefined
    const handle = await this.#ctx.agents.create({
      sessionId: SessionId('session-' + randomUUID()),
      meta: { cwd: process.cwd(), agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => { configured = await setupAgentContext(agentCtx, ref) },
    })
    const configuration = configured
    if (configuration === undefined) {
      await handle.dispose()
      throw new Error('created agent was published without session configuration')
    }
    this.#pinToolPresentation(handle.agent, configuration)
    return {
      handle,
      selection: ref,
      contextWindow: undefined,
      reasoningEffort: undefined,
      configuration: {
        agentPreset: configuration.agentPreset,
        tools: configuration.tools,
        toolsSource: configuration.toolsSource,
      },
      disposeToolPresentation: configuration.disposeToolPresentation,
    }
  }

  async #resolveModelInfo(selection: ModelSelection): Promise<LlmResolvedModelInfo | undefined> {
    try {
      return await this.#ctx.get('llm')?.resolveModelInfo(selection.provider, selection.model)
    } catch {
      return undefined
    }
  }

  #activate(next: ActiveSession, hydrate = true): void {
    const previous = this.#active
    this.#active = next
    const agent = next.handle.agent
    const managerSource = this.#ctx.get('sessionPersistence') === undefined
      ? undefined
      : this.sessionManagerSource(agent)
    this.#tui.setActiveTranscriptSource?.(managerSource === undefined
      ? undefined
      : activeTranscriptSource(managerSource, () => this.#active === next && !this.#disposed))
    this.#inspectedId = undefined
    this.#skillCommands = []
    this.#tui.setInspectedSubagent(undefined)
    this.#tui.setStatus(agent.status)
    this.#syncSubagents()
    this.#replaceTranscript(agent)
    this.#pushTools()
    const status = modelStatus(this.selection(agent))
    next.reasoningEffort = status.reasoningEffort
    this.#tui.setModel(status.model, status.reasoningEffort)
    this.#pushCommands()
    this.#pushSessionInfo()
    if (previous !== undefined) this.#retired.push(previous.handle)
    this.#tui.activateInput()
    if (hydrate) this.#hydrate(next)
  }

  #hydrate(active: ActiveSession, milestone?: (milestone: StartupMilestone) => void): void {
    const persistence = this.#ctx.get('sessionPersistence') as unknown as ViewportPersistenceExtension | undefined
    const events = active.handle.agent.session.events
    const knownNextSeq = (events.at(-1)?.seq ?? -1) + 1
    const tasks = [
      this.refreshRecent(active).finally(() => { milestone?.('recentReady') }),
      this.#hydrateModel(active).finally(() => { milestone?.('modelReady') }),
      this.#refreshSkills(undefined, active).finally(() => { milestone?.('skillsReady') }),
      persistence?.omdshRefreshViewportTail?.(active.handle.agent.id, knownNextSeq) ?? Promise.resolve(),
    ]
    const hydration = Promise.allSettled(tasks).then(() => undefined)
    this.#hydrations.add(hydration)
    void hydration.finally(() => { this.#hydrations.delete(hydration) })
  }

  async #hydrateModel(active: ActiveSession): Promise<void> {
    const selected = active.selection.current
    if (selected === undefined) return
    const info = await this.#resolveModelInfo(selected)
    if (this.#active !== active) return
    active.contextWindow = info?.context?.contextWindow
    const status = modelStatus(selected, info)
    active.reasoningEffort = status.reasoningEffort
    this.#tui.setModel(status.model, status.reasoningEffort)
    this.#pushSessionInfo()
  }

  #pushCommands(): void {
    const agent = this.agent
    const runtime = agent === undefined ? [] : (this.#ctx.get('commands')?.list(agent) ?? [])
    const commands: TuiCommand[] = runtime.map(command => ({
      name: command.name,
      description: command.description,
      ...(command.input?.hint === undefined ? {} : { inputHint: command.input.hint }),
    }))
    const names = new Set(commands.map(command => command.name))
    for (const skill of this.#skillCommands) {
      if (names.has(skill.name)) continue
      commands.push(skill)
      names.add(skill.name)
    }
    this.#tui.setCommands(commands)
  }

  #pushTools(): void {
    const agent = this.agent
    const tools = agent === undefined
      ? []
      : (this.#ctx.get('tools')?.schemas(agent).map(schema => ({
          name: schema.name,
          description: schema.description,
        })) ?? [])
    this.#tui.setTools(tools)
  }

  async #refreshSkills(signal?: AbortSignal, expected: ActiveSession | undefined = this.#active): Promise<void> {
    const agent = expected?.handle.agent
    const skills = this.#ctx.get('skills')
    const commands = agent === undefined || skills === undefined
      ? []
      : userSkillCommands(await skills.list({ cwd: agent.session.header.cwd, scope: agent, signal }))
    if (expected !== this.#active) return
    this.#skillCommands = commands
    this.#pushCommands()
  }

  async #findUserSkill(name: string, signal: AbortSignal): Promise<SkillSummary | undefined> {
    const agent = this.#requiredAgent()
    const skills = this.#ctx.get('skills')
    if (skills === undefined) return undefined
    const list = await skills.list({ cwd: agent.session.header.cwd, scope: agent, signal })
    return list.find(skill => skill.name === name && isUserInvocable(skill))
  }

  #lookupSession = (id: string): Session | undefined => this.#ctx.get('sessions')?.get(SessionId(id))

  #subagentDepth(session: Session): number | undefined {
    const rootId = this.#active?.handle.agent.id
    if (rootId === undefined) return undefined
    return descendantDepth(session, rootId, this.#lookupSession)
  }

  #noteSubagentSession(session: Session): void {
    const depth = this.#subagentDepth(session)
    if (depth === undefined) return
    const parentId = session.header.parentSession
    this.#subagents.remember({
      id: session.id,
      ...(parentId === undefined ? {} : { parentId }),
      depth,
      phase: this.#ctx.get('agents')?.get(session.id)?.status === 'running' ? 'running' : 'starting',
    })
    this.#pushSubagents()
  }

  #noteSubagentEvent(session: Session, event: SessionEvent): void {
    const depth = this.#subagentDepth(session)
    if (depth === undefined) return
    this.#subagents.apply(session, depth, event, this.#ctx.get('agents')?.get(session.id)?.status)
    this.#pushSubagents()
  }

  #noteSubagentStatus(session: Session, status: 'idle' | 'running'): void {
    if (this.#subagents.owns(session.id)) {
      this.#subagents.setAgentStatus(session.id, status)
      this.#pushSubagents()
      return
    }
    const depth = this.#subagentDepth(session)
    if (depth === undefined) return
    this.#subagents.hydrate(session, depth, this.#ctx.get('agents')?.get(session.id)?.status ?? status)
    this.#pushSubagents()
  }

  #syncSubagents(): void {
    const root = this.#active?.handle.agent
    const epoch = this.#subagentEpoch + 1
    this.#subagentEpoch = epoch
    if (root === undefined) {
      this.#subagents.reset()
      this.#tui.setSubagents(undefined)
      return
    }
    this.#subagents.reset(root.id)
    for (const session of this.#ctx.get('sessions')?.list() ?? []) {
      const depth = descendantDepth(session, root.id, this.#lookupSession)
      if (depth === undefined) continue
      this.#subagents.hydrate(session, depth, this.#ctx.get('agents')?.get(session.id)?.status)
    }
    this.#pushSubagents()
    const listed = this.#ctx.get('subagents')?.listChildren(root.id)
    if (listed === undefined) return
    void listed.then((entries) => {
      if (epoch !== this.#subagentEpoch || this.#active?.handle.agent !== root) return
      for (const entry of entries) {
        if (entry.kind !== 'child') continue
        this.#subagents.remember({
          id: entry.id,
          depth: 1,
          mode: entry.mode,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          phase: entry.activity === 'running' ? 'running' : 'waiting',
        })
      }
      this.#pushSubagents()
    }, () => undefined)
  }

  #inspectView(id: string, fallbackPhase: TuiInspectedSubagent['phase'] = 'waiting'): TuiInspectedSubagent {
    const view = this.#subagents.snapshot()?.agents.find(agent => agent.id === id)
    const mode = view?.mode
    return {
      id,
      label: view?.label ?? id,
      phase: view?.phase ?? fallbackPhase,
      ...(mode === undefined ? {} : { mode }),
      writable: isSteerableSubagent(mode),
    }
  }

  #pushSubagents(): void {
    this.#tui.setSubagents(this.#subagents.snapshot())
    if (this.#inspectedId === undefined) return
    this.#tui.setInspectedSubagent(this.#inspectView(this.#inspectedId))
  }

  #pushSessionInfo(): void {
    const active = this.#active
    if (active === undefined) return
    const agent = active.handle.agent
    const projection = this.#projection(active)
    this.#tui.setSession({
      id: agent.id,
      recent: this.#recent.filter(row => row.id !== agent.id),
      stats: this.#stats(active, projection),
      controls: this.#sessionControls(active, projection),
    })
  }

  #pinToolPresentation(agent: Agent, configuration: SessionConfiguration): void {
    const selected = resolveToolPresentation(agent.session.events, configuration.agentPreset)
    if (agent.session.events.some(event => event.type === 'omdsh/tools-selected')) return
    agent.session.append('omdsh/tools-selected', {
      mode: selected.tools,
      source: selected.toolsSource,
    })
  }

  #replaceToolPresentation(
    active: ActiveSession,
    mode: ToolPresentationMode,
    source: SessionConfiguration['toolsSource'],
  ): void {
    const previousMode = active.configuration.tools
    active.disposeToolPresentation()
    try {
      const tools = active.handle.agent.ctx.get('tools')
      if (tools === undefined) throw new Error('tool registry is unavailable')
      active.disposeToolPresentation = tools.presentAs(mode)
    } catch (error: unknown) {
      const tools = active.handle.agent.ctx.get('tools')
      if (tools === undefined) throw error
      active.disposeToolPresentation = tools.presentAs(previousMode)
      throw error
    }
    active.configuration.tools = mode
    active.configuration.toolsSource = source
    active.handle.agent.session.append('omdsh/tools-selected', { mode, source })
  }

  #replaceTranscript(agent: Agent): void {
    const events = agent.session.events
    this.#tui.replaceSession(events, this.#ctx.get('tuiToolPresentation')?.session(agent, events), agent.status)
  }

  #replaceVisibleTranscript(): void {
    if (this.#inspectedId !== undefined) {
      void this.#inspectSubagent(this.#inspectedId)
      return
    }
    const agent = this.#active?.handle.agent
    if (agent !== undefined) this.#replaceTranscript(agent)
  }

  #closeInspect(): void {
    if (this.#inspectedId === undefined) return
    this.#inspectEpoch += 1
    this.#inspectedId = undefined
    this.#tui.setInspectedSubagent(undefined)
    const agent = this.#active?.handle.agent
    if (agent === undefined) return
    this.#replaceTranscript(agent)
    this.#tui.setStatus(agent.status)
  }

  async #inspectSubagent(id: string): Promise<void> {
    const request = this.#inspectEpoch + 1
    this.#inspectEpoch = request
    if (!this.#subagents.owns(id)) {
      this.#tui.notice('That subagent is no longer available.', { level: 'error' })
      return
    }
    const live = this.#ctx.get('sessions')?.get(SessionId(id))
    let events: readonly SessionEvent[]
    if (live !== undefined) {
      events = live.events.slice(live.header.seedLength ?? 0)
    } else {
      try {
        const inspected = await this.#ctx.get('sessionPersistence')?.inspect(SessionId(id))
        if (inspected === undefined) throw new Error('subagent transcript is unavailable')
        events = inspected.events.slice(inspected.meta.seedLength ?? 0)
      } catch {
        if (request === this.#inspectEpoch) {
          this.#tui.notice('Unable to open that subagent transcript.', { level: 'error' })
        }
        return
      }
    }
    if (request !== this.#inspectEpoch) return
    this.#inspectedId = id
    const child = this.#ctx.get('agents')?.get(SessionId(id))
    this.#tui.replaceSession(
      events,
      child === undefined ? undefined : this.#ctx.get('tuiToolPresentation')?.session(child, events),
      child?.status ?? 'idle',
    )
    this.#tui.setInspectedSubagent(this.#inspectView(
      id,
      child?.status === 'running' ? 'running' : 'waiting',
    ))
    this.#tui.setStatus(child?.status ?? 'idle')
  }

  async #steerInspected(submission: TuiSubmission): Promise<void> {
    const childId = this.#inspectedId
    const root = this.#active?.handle.agent
    if (childId === undefined || root === undefined) {
      this.#tui.restoreInput(submission)
      return
    }
    const view = this.#inspectView(childId)
    if (!view.writable) {
      this.#tui.restoreInput(submission)
      this.#tui.notice('This subagent is a completed run and cannot take more messages.')
      return
    }
    const live = this.#ctx.get('sessions')?.get(SessionId(childId))
    const rosterParent = this.#subagents.snapshot()?.agents.find(agent => agent.id === childId)?.parentId
    const parentId = live?.header.parentSession ?? rosterParent
    const parent = parentId === undefined || parentId === root.id
      ? root
      : this.#ctx.get('agents')?.get(SessionId(parentId))
    const subagents = this.#ctx.get('subagents')
    if (parent === undefined || subagents === undefined) {
      this.#tui.restoreInput(submission)
      this.#tui.notice(parent === undefined
        ? 'The parent of this subagent is not live, so it cannot take a follow-up.'
        : 'Subagent follow-up is unavailable in this composition.')
      return
    }
    try {
      const message = await createSubmissionMessage(submission, this.#ctx.get('attachments'))
      if (this.#inspectedId !== childId || this.#active?.handle.agent !== root) {
        this.#tui.restoreInput(submission)
        return
      }
      await subagents.followup(parent, SessionId(childId), message.content, {
        source: { kind: 'user' },
        signal: new AbortController().signal,
      })
    } catch (error: unknown) {
      this.#tui.restoreInput(submission)
      this.#tui.notice(error instanceof Error ? error.message : String(error), { level: 'error' })
    }
  }

  #sessionControls(active: ActiveSession, projection: TuiStatsProjection | undefined): TuiSessionControls {
    const controls = sessionControls(projection)
    const livePlan = this.#ctx.get('planMode')?.get(active.handle.agent)
    return {
      ...controls,
      agentPreset: active.configuration.agentPreset,
      tools: active.configuration.tools,
      ...(livePlan === undefined
        ? {}
        : { plan: { active: livePlan.active, pending: livePlan.pending !== undefined } }),
    }
  }

  /** Read one consistent projection cut, with the complete-log fold as fallback. */
  #projection(active: ActiveSession): TuiStatsProjection | undefined {
    return this.#ctx.get('sessionProjections')?.snapshot(active.handle.agent.session).values
  }

  #stats(active: ActiveSession, projection: TuiStatsProjection | undefined = this.#projection(active)): TuiSessionStats {
    const agent = active.handle.agent
    return sessionStats(agent.session.events, active.contextWindow, projection)
  }

  #requiredActive(): ActiveSession {
    if (this.#active === undefined) throw new Error('no active session')
    return this.#active
  }

  #requiredAgent(): Agent {
    return this.#requiredActive().handle.agent
  }

  async #disposeRetired(): Promise<void> {
    await Promise.allSettled(this.#retired.splice(0).map(handle => handle.dispose()))
  }
}

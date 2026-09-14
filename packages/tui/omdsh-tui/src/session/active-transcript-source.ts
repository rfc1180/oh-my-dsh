import type {
  TuiActiveTranscriptPageRequestV2,
  TuiActiveTranscriptPageV2,
  TuiActiveTranscriptSource,
  TuiSessionHistoryContent,
  TuiSessionManagerSource,
} from '../definition.ts'

function content(value: TuiSessionHistoryContent): TuiSessionHistoryContent {
  return {
    format: 'markdown',
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.imageCount === undefined ? {} : { imageCount: value.imageCount }),
  }
}

function assertRequest(request: TuiActiveTranscriptPageRequestV2, sessionId: string): void {
  if (request === null || typeof request !== 'object'
    || request.method !== 'session.history.page.v2'
    || typeof request.sessionId !== 'string') {
    throw new Error('Malformed session.history.page.v2 request.')
  }
  if (request.sessionId !== sessionId) {
    throw new Error('session.history.page.v2 may target only the current active session.')
  }
  if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor === '')) {
    throw new Error('Malformed session.history.page.v2 cursor.')
  }
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50)) {
    throw new Error('session.history.page.v2 limit must be an integer from 1 to 50.')
  }
}

/**
 * Restrict the manager's semantic history projector to one revocable active
 * session and remove all technical metadata from the terminal-host DTO.
 */
export function activeTranscriptSource(
  manager: TuiSessionManagerSource,
  isCurrent: () => boolean,
): TuiActiveTranscriptSource {
  const sessionId = manager.activeSessionId
  return {
    activeSessionId: sessionId,
    async request(request, signal): Promise<TuiActiveTranscriptPageV2> {
      assertRequest(request, sessionId)
      if (!isCurrent()) throw new Error('The active transcript source is no longer current.')
      const historyPage = manager.historyPage
      if (historyPage === undefined) throw new Error('Semantic session history is unavailable.')
      signal?.throwIfAborted()
      const page = await historyPage({
        id: sessionId,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }, signal)
      signal?.throwIfAborted()
      if (!isCurrent() || page.sessionId !== sessionId) {
        throw new Error('The active transcript changed while history was loading.')
      }
      return {
        schemaVersion: 2,
        sessionId,
        interactions: page.interactions.map(interaction => ({
          id: interaction.id,
          user: content(interaction.input.content),
          ...(interaction.answer?.confidence !== 'explicit' || interaction.outcome.kind !== 'completed'
            ? {}
            : { assistant: content(interaction.answer.content) }),
        })),
        ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
        hasMore: page.hasMore,
      }
    },
  }
}

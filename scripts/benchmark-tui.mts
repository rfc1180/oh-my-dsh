import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MainScreenRenderer } from '../packages/tui/omdsh-tui/src/chrome/main-screen-renderer.ts'
import {
  replayEvents,
  renderView,
} from '../packages/tui/omdsh-tui/src/views/event-views.ts'
import {
  sessionStats,
  SessionPresentationController,
} from '../packages/tui/omdsh-tui/src/session/session-controller.ts'
import { LocalTui, type TerminalLike } from '../packages/tui/omdsh-tui/src/runtime/provider-local.ts'

const RUNS = 7

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5)
}

function benchmark(label: string, run: () => void): void {
  run()
  const samples: number[] = []
  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  console.log(`${label.padEnd(42)} ${median(samples).toFixed(2).padStart(9)} ms`)
}

function conversationEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({
      seq: events.length + 1,
      time: events.length + 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `question ${turn}` }] },
    } as unknown as SessionEvent)
    events.push({
      seq: events.length + 1,
      time: events.length + 1,
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: { content: [{ type: 'text', text: `answer ${turn}` }] },
      },
    } as unknown as SessionEvent)
  }
  return events
}

function toolEvents(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    time: index + 1,
    type: 'tool/call',
    data: {
      turn: 1,
      step: index + 1,
      callId: `call-${index}`,
      name: 'bash',
      arguments: { command: 'true' },
    },
  } as unknown as SessionEvent))
}

const conversation = conversationEvents(10_000)
const tools = toolEvents(10_000)
const projectedEvents: SessionEvent[] = []
const projection = {
  sessionStats: {
    turns: 1,
    steps: 1,
    llmMs: 1,
    toolMs: 0,
    ttftMs: 1,
    ttftSteps: 1,
    decodeMs: 1,
    decodeTokens: 1,
  },
  tokenUsage: {
    uncachedInputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    outputTokens: 1,
  },
  contextPressure: {
    projectedTokens: 3,
    contextWindow: 1_000_000,
  },
}

console.log('oh-my-dsh TUI microbenchmarks')
console.log(`Node ${process.version} · ${process.platform}/${process.arch} · median of ${RUNS} measured runs`)
console.log('')

benchmark('Resume 10,000 conversation turns', () => {
  replayEvents(conversation)
})

benchmark('Resume 10,000 tool calls', () => {
  replayEvents(tools)
})

benchmark('Apply 10,000 projected stats updates', () => {
  projectedEvents.length = 0
  for (let index = 0; index < 10_000; index += 1) {
    projectedEvents.push({
      seq: index + 1,
      time: index + 1,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } },
    } as unknown as SessionEvent)
    sessionStats(projectedEvents, 1_000_000, projection)
  }
})

const largeTranscript = replayEvents(conversation.slice(0, 10_000))
benchmark('Render 200 cached 5,000-turn frames', () => {
  for (let index = 0; index < 200; index += 1) {
    renderView(largeTranscript, {
      width: 160,
      height: 50,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      input: '',
      inputCursor: 0,
      colors: false,
      pwd: '~/project',
      sessionStats: {
        turns: 5_000,
        steps: 5_000,
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadTokens: 90_000,
        cacheWriteTokens: 0,
        llmMs: 1_000,
        toolMs: 100,
        ttftMs: 100,
        ttftSteps: 100,
        decodeMs: 900,
        decodeTokens: 10_000,
        elapsedMs: index,
      },
    })
  }
})

benchmark('Render 200 streaming 5,000-turn frames', () => {
  for (let index = 0; index < 200; index += 1) {
    const liveBlock = {
      kind: 'assistant',
      reasoning: '',
      text: `streaming ${index}`,
      streaming: true,
    } as unknown as (typeof largeTranscript.blocks)[number]
    renderView({
      ...largeTranscript,
      status: 'running',
      blocks: [...largeTranscript.blocks, liveBlock],
    }, {
      width: 160,
      height: 50,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      input: '',
      inputCursor: 0,
      colors: false,
      pwd: '~/project',
    })
  }
})

let terminalWrites = 0
let terminalBytes = 0
const terminalRenderer = new MainScreenRenderer(
  {
    write(chunk) {
      terminalWrites += 1
      terminalBytes += Buffer.byteLength(chunk)
    },
  },
  { width: 160, height: 50, synchronized: false },
)
terminalRenderer.render(renderView(largeTranscript, {
  width: 160,
  height: 50,
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
  input: '',
  inputCursor: 0,
  colors: false,
  pwd: '~/project',
}))
terminalWrites = 0
terminalBytes = 0
for (let index = 0; index < 200; index += 1) {
  const liveBlock = {
    kind: 'assistant',
    reasoning: '',
    text: `streaming ${index}`,
    streaming: true,
  } as unknown as (typeof largeTranscript.blocks)[number]
  terminalRenderer.render(renderView({
    ...largeTranscript,
    status: 'running',
    blocks: [...largeTranscript.blocks, liveBlock],
  }, {
    width: 160,
    height: 50,
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    input: '',
    inputCursor: 0,
    colors: false,
    pwd: '~/project',
  }))
}
console.log(`${'Terminal output for 200 streaming frames'.padEnd(42)} ${String(terminalWrites).padStart(6)} writes · ${(terminalBytes / 1024).toFixed(2)} KiB`)

const STREAM_CHUNKS = 10_000
let streamWrites = 0
let streamBytes = 0
const streamInput = Object.assign(new PassThrough(), {
  isTTY: true,
  setRawMode: (_on: boolean): void => {},
})
const streamTerminal: TerminalLike = {
  output: {
    isTTY: true,
    write(chunk) {
      streamWrites += 1
      streamBytes += Buffer.byteLength(chunk)
      return true
    },
  },
  input: streamInput,
  width: () => 160,
  height: () => 50,
}
const streamTui = new LocalTui(streamTerminal, 'benchmark-model', false, 'dark', async () => {}, {
  cwd: process.cwd(),
  streamRenderMs: 10,
})
let projectedOutputTokens = 0
const streamController = new SessionPresentationController(streamTui, () => {
  streamTui.setSession({
    id: 'benchmark-session',
    recent: [],
    stats: {
      turns: 1,
      steps: 1,
      llmMs: projectedOutputTokens,
      toolMs: 0,
      ttftMs: 1,
      ttftSteps: 1,
      decodeMs: projectedOutputTokens,
      decodeTokens: projectedOutputTokens,
      inputTokens: 1,
      outputTokens: projectedOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  })
})
streamWrites = 0
streamBytes = 0
const chunkSamples: number[] = []
const growingStart = performance.now()
for (let index = 0; index < STREAM_CHUNKS; index += 1) {
  projectedOutputTokens = index + 1
  const start = performance.now()
  streamController.event({
    seq: index + 1,
    time: index + 1,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
  } as SessionEvent)
  chunkSamples.push(performance.now() - start)
}
const growingDispatchMs = performance.now() - growingStart
await new Promise<void>(resolve => { setTimeout(resolve, 15) })
const writesBeforeSettlement = streamWrites
const bytesBeforeSettlement = streamBytes
const settlementStart = performance.now()
streamController.event({
  seq: STREAM_CHUNKS + 1,
  time: STREAM_CHUNKS + 1,
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: 'settled synthetic stream' }] },
  },
} as SessionEvent)
streamController.event({
  seq: STREAM_CHUNKS + 2,
  time: STREAM_CHUNKS + 2,
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'completed' } },
} as SessionEvent)
const settlementMs = performance.now() - settlementStart
console.log(`${`Growing stream ${STREAM_CHUNKS.toLocaleString()} chunks`.padEnd(42)} ${growingDispatchMs.toFixed(2).padStart(9)} ms`)
console.log(`${'Chunk event latency'.padEnd(42)} p95 ${(percentile(chunkSamples, 0.95) * 1_000).toFixed(2)} µs · p99 ${(percentile(chunkSamples, 0.99) * 1_000).toFixed(2)} µs`)
console.log(`${'Coalesced growing-stream output'.padEnd(42)} ${String(writesBeforeSettlement).padStart(6)} writes · ${(bytesBeforeSettlement / 1024).toFixed(2)} KiB`)
console.log(`${'Settlement spike'.padEnd(42)} ${settlementMs.toFixed(2).padStart(9)} ms · ${streamWrites - writesBeforeSettlement} writes · ${((streamBytes - bytesBeforeSettlement) / 1024).toFixed(2)} KiB`)
streamController.dispose()
streamTui.dispose()

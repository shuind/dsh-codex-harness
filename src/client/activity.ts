/** Client-only inference used while the host activity projection frame is in flight. */

import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

export type ActivitySessionSnapshot = Pick<ConversationSnapshot, 'running'> & {
  /** Optional because older/newer hosts can publish the shell snapshot before the chat slice. */
  readonly partial?: ConversationSnapshot['partial']
  readonly runningCalls?: ConversationSnapshot['runningCalls']
  readonly turnTimings?: ConversationSnapshot['turnTimings']
  /** Optional for hosts that predate the assembled Chat snapshot. */
  readonly chat?: ConversationSnapshot['chat']
}

type PartialAssistantWithTiming = NonNullable<ActivitySessionSnapshot['partial']> & {
  readonly replyStartedAt?: number
}

export type CodexModelActivity = {
  activity: 'requesting-model' | 'model-reply'
  startedAt: number
}

/** Equality for selector hooks, whose default is reference identity. */
export function sameModelActivity(
  left: CodexModelActivity | undefined,
  right: CodexModelActivity | undefined,
): boolean {
  return left?.activity === right?.activity && left?.startedAt === right?.startedAt
}

/** Infer the request-phase clock from the existing conversation snapshot. */
export function awaitingModelStartedAt(snapshot: ActivitySessionSnapshot): number | undefined {
  if (!snapshot.running || (snapshot.runningCalls?.length ?? 0) > 0) return undefined
  if (snapshot.turnTimings === undefined) return undefined
  let latest: number | undefined
  for (const timing of snapshot.turnTimings.values()) {
    if (timing.endTime === undefined) latest = timing.startTime
  }
  return latest
}

/** Infer the first non-empty model token timestamp from the current snapshot. */
export function modelReplyStartedAt(snapshot: ActivitySessionSnapshot): number | undefined {
  if (!snapshot.running || (snapshot.runningCalls?.length ?? 0) > 0) return undefined
  if (snapshot.turnTimings === undefined) return undefined
  let openTurn: { turn: number; startTime: number } | undefined
  for (const [turn, timing] of snapshot.turnTimings) {
    if (timing.endTime === undefined) openTurn = { turn, startTime: timing.startTime }
  }
  if (openTurn === undefined) return undefined
  if (snapshot.partial !== undefined && snapshot.partial !== null && snapshot.partial.turn === openTurn.turn) {
    const partialReplyStartedAt = (snapshot.partial as PartialAssistantWithTiming).replyStartedAt
    if (partialReplyStartedAt !== undefined) return partialReplyStartedAt
  }

  // A non-streaming adapter has no partial row. The assembled Chat view still
  // carries the reply boundary, but only accept it for the currently open step
  // so an earlier tool step in the same turn cannot mask a new request.
  const chat = snapshot.chat
  const turn = chat?.timeline.turns.get(openTurn.turn)
  const step = turn?.steps.findLast(candidate => candidate.end === undefined)
  if (step === undefined) return undefined
  for (const node of [...(chat?.nodes.values() ?? [])].reverse()) {
    if (node.kind !== 'assistant-step') continue
    const data = node.data as { turn?: unknown; step?: unknown; replyStartedAt?: unknown }
    if (data.turn === openTurn.turn && data.step === step.step && typeof data.replyStartedAt === 'number') {
      return data.replyStartedAt
    }
  }
  return undefined
}

/** Infer the two-phase model activity from the current client snapshot. */
export function modelActivity(snapshot: ActivitySessionSnapshot): CodexModelActivity | undefined {
  const startedAt = awaitingModelStartedAt(snapshot)
  if (startedAt === undefined) return undefined
  const replyStartedAt = modelReplyStartedAt(snapshot)
  return replyStartedAt === undefined
    ? { activity: 'requesting-model', startedAt }
    : { activity: 'model-reply', startedAt: replyStartedAt }
}

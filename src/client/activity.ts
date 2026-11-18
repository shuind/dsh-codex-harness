/** Client-only inference used while the host activity projection frame is in flight. */

/**
 * The legacy conversation slice is no longer part of the current Session
 * snapshot. Keep this fallback structural so both generations can load without
 * depending on the removed dsh-client-runtime package.
 */
export interface ActivitySessionSnapshot {
  readonly running: boolean
  readonly partial?: { readonly turn: number; readonly replyStartedAt?: number | undefined } | null | undefined
  readonly runningCalls?: readonly unknown[] | undefined
  readonly turnTimings?: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number | undefined }> | undefined
  readonly chat?: {
    readonly timeline: { readonly turns: ReadonlyMap<number, { readonly steps: readonly { readonly step: number; readonly end?: unknown }[] }> }
    readonly nodes: { values(): Iterable<{ readonly kind: string; readonly data: unknown }> }
  } | undefined
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
    const partialReplyStartedAt = snapshot.partial.replyStartedAt
    if (partialReplyStartedAt !== undefined) return partialReplyStartedAt
  }

  // A non-streaming adapter has no partial row. The assembled Chat view still
  // carries the reply boundary, but only accept it for the currently open step
  // so an earlier tool step in the same turn cannot mask a new request.
  const chat = snapshot.chat
  const turn = chat?.timeline.turns.get(openTurn.turn)
  const step = turn?.steps.findLast(candidate => candidate.end === undefined)
  if (step === undefined) return undefined
  let matched: number | undefined
  for (const node of chat?.nodes.values() ?? []) {
    if (node.kind !== 'assistant-step') continue
    const data = node.data as { turn?: unknown; step?: unknown; replyStartedAt?: unknown }
    if (data.turn === openTurn.turn && data.step === step.step && typeof data.replyStartedAt === 'number') {
      matched = data.replyStartedAt
    }
  }
  return matched
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

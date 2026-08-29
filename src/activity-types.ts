/** Pure client/host-shared type for the Codex activity projection value. */

export type CodexActivity = {
  activity: 'compaction' | 'awaiting-model'
  startedAt: number
}


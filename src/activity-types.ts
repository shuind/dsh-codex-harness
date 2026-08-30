/** Pure client/host-shared type for the Codex activity projection value. */

export type CodexActivity = {
  activity: 'compaction' | 'requesting-model' | 'model-reply' | 'awaiting-model'
  startedAt: number
}


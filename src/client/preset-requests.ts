/** Only transport failures from a read can be retried without duplicating writes. */
export function isPresetConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to fetch|NetworkError|Load failed|network request failed|no active Connection|connection.*(?:closed|offline)/i.test(message)
}

export async function readPresetWithRetry<T>(read: () => Promise<T>, active: () => boolean): Promise<T> {
  try { return await read() }
  catch (error) {
    if (!isPresetConnectionError(error) || !active()) throw error
    await new Promise(resolve => setTimeout(resolve, 300))
    if (!active()) throw error
    return read()
  }
}

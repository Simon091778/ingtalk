/** Serialize refreshes, preserving one trailing read for events arriving mid-request. */
export function createRefreshQueue<T>(task: (isCurrent: () => boolean) => Promise<T>) {
  let running: Promise<T | undefined> | null = null
  let queued = false
  let generation = 0
  const run = (): Promise<T | undefined> => {
    queued = true
    if (running) return running
    // Start on a microtask so synchronous bursts share the same first read.
    running = Promise.resolve().then(async () => {
      try {
        let result: T | undefined
        while (queued) {
          queued = false
          const ticket = generation
          try {
            result = await task(() => ticket === generation)
          } catch (error) {
            if (!queued && ticket === generation) throw error
          }
        }
        return result
      } finally { running = null }
    })
    return running
  }
  return { run, cancel: () => { generation++; queued = false } }
}

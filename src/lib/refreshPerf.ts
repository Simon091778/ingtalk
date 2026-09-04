type RefreshTrace = {
  id: number
  mark: (stage: string, duration?: number, details?: Record<string, number | boolean>) => void
  step: <T>(stage: string, work: () => PromiseLike<T>) => Promise<T>
  sync: <T>(stage: string, work: () => T) => T
  end: () => void
}
let nextRequest = 0
const run = Date.now().toString(36)
const latest = new Map<string, RefreshTrace>()
const navigation = new Map<string, number>()
export const isRefreshPerfEnabled = () => __DEV__ && process.env.EXPO_PUBLIC_REFRESH_PERF === '1'

/** Opt-in development logs only. Never logs payloads, IDs, locations or errors. */
export function startRefreshPerf(screen: string): RefreshTrace {
  const enabled = isRefreshPerfEnabled()
  const now = () => performance.now()
  const started = enabled ? now() : 0
  const id = enabled ? ++nextRequest : 0
  const parentCycle = enabled ? navigation.get(screen.split('.')[0] ?? screen) : undefined
  const mark = (stage: string, duration?: number, details?: Record<string, number | boolean>) => {
    if (!enabled) return
    const atMs = now()
    console.info('[PERF] ' + JSON.stringify({ run, screen, cycle: id, parentCycle, stage, atMs, elapsedMs: atMs - started, durationMs: duration, ...details }))
  }
  if (enabled) mark('start', 0)
  const trace = {
    id,
    mark,
    async step<T>(stage: string, work: () => PromiseLike<T>): Promise<T> {
      const before = enabled ? now() : 0
      if (enabled) mark(`${stage} start`)
      try { return await work() } finally { if (enabled) mark(`${stage} end`, now() - before) }
    },
    sync<T>(stage: string, work: () => T): T {
      const before = enabled ? now() : 0
      try { return work() } finally { if (enabled) mark(stage, now() - before) }
    },
    end: () => { if (enabled) mark('end') },
  }
  if (enabled) latest.set(screen, trace)
  return trace
}

export function markRefreshNavigation(screen: string, trigger: string) {
  if (!isRefreshPerfEnabled()) return
  const trace = startRefreshPerf(`${screen}.navigation`)
  navigation.set(screen, trace.id)
  trace.mark(trigger)
}

export const latestRefreshPerf = (screen: string) => latest.get(screen)
export const clearRefreshPerfScreen = (screen: string) => { latest.delete(screen) }

/** Do not record URL parameters, storage object paths, headers, or response bodies. */
export const refreshPerfFetch: typeof fetch = async (input, init) => {
  if (!isRefreshPerfEnabled()) return fetch(input, init)
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let category = 'other'
  try {
    const path = new URL(raw).pathname
    const match = path.match(/^\/rest\/v1\/(?:rpc\/)?([a-z_][a-z_0-9]*)$/)
    category = match ? match[1]! : path.startsWith('/auth/') ? 'auth' : path.startsWith('/storage/') ? 'storage' : 'other'
  } catch { /* Unparseable addresses are deliberately not logged. */ }
  const trace = startRefreshPerf(`Network.${category}`)
  try {
    const response = await trace.step('fetch', () => fetch(input, init))
    trace.mark('response', undefined, { status: response.status })
    return response
  } finally { trace.end() }
}

export async function measureRefresh<T>(screen: string, work: () => PromiseLike<T>) {
  const perf = startRefreshPerf(screen)
  try { return await perf.step('query', work) } finally { perf.end() }
}

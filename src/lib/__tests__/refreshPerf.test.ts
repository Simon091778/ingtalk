import { markRefreshNavigation, measureRefresh, refreshPerfFetch, startRefreshPerf } from '../refreshPerf'

test('refresh timing logs are opt-in and disabled in production', async () => {
  const previous = process.env.EXPO_PUBLIC_REFRESH_PERF
  const runtime = globalThis as unknown as { __DEV__: boolean }
  const development = runtime.__DEV__
  const log = jest.spyOn(console, 'info').mockImplementation(() => {})
  try {
    delete process.env.EXPO_PUBLIC_REFRESH_PERF
    await measureRefresh('Test', () => Promise.resolve(1))
    expect(log).not.toHaveBeenCalled()
    process.env.EXPO_PUBLIC_REFRESH_PERF = '1'
    runtime.__DEV__ = false
    await measureRefresh('Test', () => Promise.resolve(1))
    expect(log).not.toHaveBeenCalled()
    runtime.__DEV__ = true
    const perf = startRefreshPerf('Test')
    await expect(perf.step('query', () => Promise.reject(new Error('private payload')))).rejects.toThrow('private payload')
    perf.end()
    expect(log).toHaveBeenCalledTimes(4)
    expect(log.mock.calls.flat().join(' ')).not.toContain('private payload')
  } finally {
    runtime.__DEV__ = development
    if (previous === undefined) delete process.env.EXPO_PUBLIC_REFRESH_PERF
    else process.env.EXPO_PUBLIC_REFRESH_PERF = previous
    log.mockRestore()
  }
})

test('network timing preserves fetch arguments and excludes URLs, IDs and credentials', async () => {
  const previous = process.env.EXPO_PUBLIC_REFRESH_PERF
  process.env.EXPO_PUBLIC_REFRESH_PERF = '1'
  const originalFetch = globalThis.fetch
  const fetchMock = jest.fn().mockResolvedValue({ ok: true })
  globalThis.fetch = fetchMock
  const log = jest.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const url = 'https://private-host.example/rest/v1/profiles?id=eq.private-user'
    const init = { headers: { Authorization: 'private-token' } }
    await refreshPerfFetch(url, init)
    expect(fetchMock).toHaveBeenCalledWith(url, init)
    const output = log.mock.calls.flat().join(' ')
    expect(output).toContain('Network.profiles')
    expect(output).not.toContain('private-')
    expect(output).toContain('fetch start')
    expect(output).toContain('fetch end')
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.EXPO_PUBLIC_REFRESH_PERF
    else process.env.EXPO_PUBLIC_REFRESH_PERF = previous
    log.mockRestore()
  }
})

test('an old request retains its original navigation cycle after a new trigger', () => {
  const previous = process.env.EXPO_PUBLIC_REFRESH_PERF
  process.env.EXPO_PUBLIC_REFRESH_PERF = '1'
  const log = jest.spyOn(console, 'info').mockImplementation(() => {})
  try {
    markRefreshNavigation('Test', 'tab press')
    const old = startRefreshPerf('Test')
    markRefreshNavigation('Test', 'manual refresh')
    old.end()
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line).slice(7)))
    const oldEvents = events.filter(event => event.cycle === old.id)
    expect(oldEvents.at(-1).parentCycle).toBe(oldEvents[0].parentCycle)
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_REFRESH_PERF
    else process.env.EXPO_PUBLIC_REFRESH_PERF = previous
    log.mockRestore()
  }
})

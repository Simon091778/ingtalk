import { Profiler, useLayoutEffect, useRef, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { clearRefreshPerfScreen, isRefreshPerfEnabled, latestRefreshPerf, markRefreshNavigation, startRefreshPerf } from '../lib/refreshPerf'

/** Observation only: never changes data, loading, subscriptions used by the app, or navigation. */
export function useRefreshPerfScreen(screen: string, data: unknown, ready: boolean, rows: number, scope: unknown = true, active = true, activationKey: unknown = 0) {
  const lifecycle = useRef<ReturnType<typeof startRefreshPerf> | null>(null)
  useLayoutEffect(() => {
    if (!isRefreshPerfEnabled() || scope == null) return
    clearRefreshPerfScreen(screen)
    const trace = startRefreshPerf(`${screen}.lifecycle`)
    lifecycle.current = trace
    trace.mark('MOUNT')
    return () => { trace.mark('UNMOUNT'); trace.end(); lifecycle.current = null }
  }, [screen, scope])
  useLayoutEffect(() => {
    if (!isRefreshPerfEnabled() || scope == null || !active) return
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') markRefreshNavigation(screen, 'foreground')
    })
    return () => subscription.remove()
  }, [screen, scope, active])
  useLayoutEffect(() => {
    if (!isRefreshPerfEnabled() || scope == null || !active) return
    const trace = latestRefreshPerf(screen) ?? lifecycle.current
    trace?.mark('state commit', undefined, { ready, rows })
    if (!ready) return
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => trace?.mark('usable UI candidate', undefined, { ready, rows }))
    })
    return () => { cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame) }
  }, [screen, data, ready, rows, scope, active])
  useLayoutEffect(() => {
    if (!isRefreshPerfEnabled() || !active || !ready || scope == null) return
    const navigation = latestRefreshPerf(screen + '.navigation')
    if (!navigation) return
    let second: number | undefined
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => navigation?.mark('UI_VISIBLE', undefined, { rows })) })
    return () => { cancelAnimationFrame(first); if (second !== undefined) cancelAnimationFrame(second) }
  }, [screen, active, activationKey, ready, scope])
}

export function RefreshPerfProfiler({ screen, children }: { screen: string; children: ReactNode }) {
  if (!isRefreshPerfEnabled()) return children
  return <Profiler id={screen} onRender={(_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    const trace = latestRefreshPerf(screen) ?? startRefreshPerf(`${screen}.render`)
    trace.mark(`React ${phase}`, actualDuration, { baseDuration, renderStart: startTime, commitTime })
  }}>{children}</Profiler>
}

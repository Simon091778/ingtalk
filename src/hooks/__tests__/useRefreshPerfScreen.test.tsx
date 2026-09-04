import { act, render } from '@testing-library/react-native'
import { AppState, View } from 'react-native'
import { useRefreshPerfScreen } from '../useRefreshPerfScreen'

function Screen({ ready = false, scope = 'screen' }: { ready?: boolean; scope?: string | null }) {
  useRefreshPerfScreen('TestScreen', ready, ready, 0, scope)
  return <View />
}

test('diagnostics distinguish a ready empty list and cancel pending frame probes on unmount', () => {
  const previous = process.env.EXPO_PUBLIC_REFRESH_PERF
  process.env.EXPO_PUBLIC_REFRESH_PERF = '1'
  const log = jest.spyOn(console, 'info').mockImplementation(() => {})
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id })
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(ticket => { frames.delete(ticket) })
  try {
    const screen = render(<Screen ready />)
    act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)) })
    expect(frames.size).toBe(1)
    screen.unmount()
    expect(frames.size).toBe(0)
    const events = log.mock.calls.map(([line]) => JSON.parse(String(line).slice(7)))
    expect(events.some(event => event.stage === 'state commit' && event.ready && event.rows === 0)).toBe(true)
    expect(events.some(event => event.stage === 'UNMOUNT')).toBe(true)
    expect(events.some(event => event.stage === 'usable UI candidate')).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_REFRESH_PERF
    else process.env.EXPO_PUBLIC_REFRESH_PERF = previous
    jest.restoreAllMocks()
  }
})

test('disabled diagnostics attach no foreground listener or frame probe', () => {
  const previous = process.env.EXPO_PUBLIC_REFRESH_PERF
  delete process.env.EXPO_PUBLIC_REFRESH_PERF
  const listener = jest.spyOn(AppState, 'addEventListener')
  const frame = jest.spyOn(globalThis, 'requestAnimationFrame')
  try {
    const screen = render(<Screen ready />)
    expect(listener).not.toHaveBeenCalled()
    expect(frame).not.toHaveBeenCalled()
    screen.unmount()
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_REFRESH_PERF
    else process.env.EXPO_PUBLIC_REFRESH_PERF = previous
    jest.restoreAllMocks()
  }
})

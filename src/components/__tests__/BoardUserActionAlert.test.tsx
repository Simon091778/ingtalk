import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { Alert, Platform, type AlertButton, type AlertOptions } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Board } from '../Board'

jest.mock('../../lib/supabase', () => {
  const post = {
    id: 'post-1',
    author_id: 'author-1',
    nickname: '테스트 작성자',
    gender: 'male',
    title: '테스트 게시글',
    body: '신고 메뉴 테스트',
    image_url: null,
    created_at: '2026-08-31T00:00:00.000Z',
    comment_count: 0,
    view_count: 0,
    like_count: 0,
    liked_by_me: false,
    dislike_count: 0,
    disliked_by_me: false,
  }
  const channel = { on: jest.fn(), subscribe: jest.fn() }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)
  return {
    isSupabaseConfigured: true,
    supabase: {
      rpc: jest.fn((name: string) => Promise.resolve({ data: name === 'list_board_posts' ? [post] : null, error: null })),
      channel: jest.fn(() => channel),
      removeChannel: jest.fn(() => Promise.resolve()),
    },
  }
})
jest.mock('../../lib/phoneAuth', () => ({ getAccountId: jest.fn(() => Promise.resolve('viewer-1')) }))
jest.mock('../BoardBannerAd', () => ({ BoardBannerAd: () => null }))

const originalPlatform = Platform.OS
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 360, height: 800 },
  insets: { top: 24, right: 0, bottom: 24, left: 0 },
}

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform })
  jest.useRealTimers()
  jest.restoreAllMocks()
})

async function openUserActionAlert() {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const screen = render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <Board />
    </SafeAreaProvider>,
  )
  await waitFor(() => expect(screen.getByText('테스트 작성자')).toBeTruthy())
  fireEvent(screen.getByText('테스트 작성자'), 'press', { stopPropagation: jest.fn() })
  const call = alert.mock.calls.find(([title, message]) => title === '테스트 작성자' && message === '원하는 기능을 선택해 주세요.')
  expect(call).toBeTruthy()
  return { alert, screen, call: call as [string, string, AlertButton[], AlertOptions] }
}

test('keeps the Android user action alert natively cancelable after report Alert cancellation', async () => {
  jest.useFakeTimers()
  const { alert, call } = await openUserActionAlert()
  const [, , actions, options] = call
  expect(options).toEqual(expect.objectContaining({ cancelable: true }))

  const report = actions.find(action => action.text === '신고하기')
  act(() => report?.onPress?.())
  const reportCall = alert.mock.calls.find(([title]) => title === '신고 사유 선택')
  expect(reportCall).toBeTruthy()

  const reportActions = reportCall?.[2] as AlertButton[]
  const cancelReport = reportActions.find(action => action.text === '취소')
  expect(cancelReport?.style).toBe('cancel')
  act(() => {
    cancelReport?.onPress?.()
    jest.runOnlyPendingTimers()
  })

  const reopenedCall = alert.mock.calls.at(-1) as [string, string, AlertButton[], AlertOptions]
  expect(reopenedCall[0]).toBe('테스트 작성자')
  expect(reopenedCall[3]).toEqual(expect.objectContaining({ cancelable: true }))
})

test('retains the internal cancel button and chat request action', async () => {
  const { call, screen } = await openUserActionAlert()
  const actions = call[2]
  expect(actions.find(action => action.text === '취소')?.style).toBe('cancel')
  act(() => actions.find(action => action.text === '대화 신청')?.onPress?.())
  expect(screen.getByText('테스트 작성자님에게')).toBeTruthy()
})

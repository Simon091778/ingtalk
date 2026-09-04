import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { AppState, FlatList } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ChatHub } from '../ChatFlow'
import { supabase } from '../../lib/supabase'

jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), channel: jest.fn(), removeChannel: jest.fn() } }))
jest.mock('../../lib/phoneAuth', () => ({ getAccountId: jest.fn().mockResolvedValue('viewer') }))
jest.mock('../../lib/observability', () => ({ captureAppError: jest.fn(), addAppBreadcrumb: jest.fn() }))
jest.mock('../../lib/chatNotificationState', () => ({ setActiveChatNotificationRoom: jest.fn(), dismissReadChatNotifications: jest.fn().mockResolvedValue(undefined) }))
jest.mock('react-native-gesture-handler', () => {
  const actual = jest.requireActual('react-native-gesture-handler')
  return { ...actual, GestureHandlerRootView: jest.requireActual('react-native').View, GestureDetector: ({ children }: { children: React.ReactNode }) => children }
})
jest.mock('../SwipeDismissView', () => ({ SwipeDismissView: ({ children }: { children: React.ReactNode }) => children }))

const room = { room_id: 'room', other_user_id: 'peer', other_nickname: 'Refresh peer', other_birth_year: 1990, last_message: 'previous', last_message_at: '2026-09-01T00:00:00Z', unread_count: 1 }
const rpc = jest.mocked(supabase!.rpc)
const renderHub = () => render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}><ChatHub /></SafeAreaProvider>)
const hub = (active = true, refreshKey = 0) => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}><ChatHub isActive={active} refreshKey={refreshKey} /></SafeAreaProvider>

beforeEach(() => {
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'my_chat_rooms' ? [room] : [], error: null }) as never)
  const channel = { on: jest.fn(), subscribe: jest.fn() }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)
  jest.mocked(supabase!.channel).mockReturnValue(channel as never)
})

test('header refresh keeps the existing chat list visible while the server is pending', async () => {
  const screen = renderHub()
  await screen.findByText('previous')
  rpc.mockImplementation(() => new Promise(() => {}) as never)
  fireEvent.press(screen.getByRole('button', { name: '대화 목록 새로고침' }))
  const visibleLists = screen.UNSAFE_queryAllByType(FlatList).length
  console.info('[PERF-TEST] header refresh visible lists while pending:', visibleLists)
  expect(visibleLists).toBe(1)
  screen.unmount()
})

test('messages become visible without waiting for mark_room_read', async () => {
  let finishRead!: (value: unknown) => void
  const readPending = new Promise(resolve => { finishRead = resolve })
  rpc.mockImplementation((name: string) => (name === 'mark_room_read' ? readPending : Promise.resolve({ data: name === 'my_chat_rooms' ? [room] : [], error: null })) as never)
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'gte', 'order']) query[method] = jest.fn(() => query)
  query.limit = jest.fn().mockResolvedValue({ data: [{ id: 1, room_id: 'room', sender_id: 'peer', body: 'fresh message', created_at: '2026-09-04T00:00:00Z' }], error: null })
  jest.mocked(supabase!.from).mockReturnValue(query as never)
  const screen = renderHub()
  fireEvent.press(await screen.findByText('previous'))
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('mark_room_read', { room_uuid: 'room' }))
  const visible = screen.queryByText('fresh message') !== null
  console.info('[PERF-TEST] message visible while read receipt pending:', visible)
  await act(async () => finishRead({ data: null, error: null }))
  expect(visible).toBe(true)
})

test('warm return preserves rows, stops hidden polling and ignores an obsolete response', async () => {
  jest.useFakeTimers()
  const screen = render(hub())
  await act(async () => {})
  expect(screen.getByText('previous')).toBeTruthy()
  let finish!: (value: unknown) => void
  rpc.mockImplementation((name: string) => (name === 'my_chat_rooms' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ data: [], error: null })) as never)
  fireEvent.press(screen.getByRole('button', { name: '대화 목록 새로고침' }))
  await act(async () => {})
  screen.rerender(hub(false))
  const reads = rpc.mock.calls.length
  await act(async () => { jest.advanceTimersByTime(12000) })
  expect(rpc.mock.calls.length).toBe(reads)
  await act(async () => finish({ data: [{ ...room, last_message: 'obsolete' }], error: null }))
  expect(screen.queryByText('obsolete')).toBeNull()
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'my_chat_rooms' ? [{ ...room, last_message: 'validated' }] : [], error: null }) as never)
  screen.rerender(hub())
  expect(screen.getByText('previous')).toBeTruthy()
  await act(async () => {})
  expect(screen.getByText('validated')).toBeTruthy()
  screen.unmount()
  jest.useRealTimers()
})

test('poll plus manual refresh runs one current read and one trailing read', async () => {
  jest.useFakeTimers()
  const originalState = AppState.currentState
  AppState.currentState = 'active'
  const screen = render(hub())
  await act(async () => {})
  const finish: Array<(value: unknown) => void> = []
  rpc.mockClear().mockImplementation((name: string) => (name === 'my_chat_rooms' ? new Promise(resolve => finish.push(resolve)) : Promise.resolve({ data: [], error: null })) as never)
  await act(async () => { jest.advanceTimersByTime(4000) })
  fireEvent.press(screen.getByRole('button', { name: '대화 목록 새로고침' }))
  await act(async () => {})
  expect(finish).toHaveLength(1)
  await act(async () => finish[0]!({ data: [room], error: null }))
  expect(finish).toHaveLength(2)
  await act(async () => finish[1]!({ data: [room], error: null }))
  expect(finish).toHaveLength(2)
  screen.unmount()
  AppState.currentState = originalState
  jest.useRealTimers()
})

test('reselecting the active tab during manual refresh cannot strand its spinner', async () => {
  const screen = render(hub())
  await screen.findByText('previous')
  const finish: Array<(value: unknown) => void> = []
  rpc.mockImplementation((name: string) => (name === 'my_chat_rooms' ? new Promise(resolve => finish.push(resolve)) : Promise.resolve({ data: [], error: null })) as never)
  fireEvent.press(screen.getByRole('button', { name: '대화 목록 새로고침' }))
  await act(async () => {})
  screen.rerender(hub(true, 1))
  await act(async () => finish[0]!({ data: [room], error: null }))
  expect(finish).toHaveLength(2)
  await act(async () => finish[1]!({ data: [room], error: null }))
  expect(screen.getByRole('button', { name: '대화 목록 새로고침' }).props.accessibilityState.busy).toBe(false)
  expect(screen.getByText('previous')).toBeTruthy()
  screen.unmount()
})

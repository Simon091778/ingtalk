import { act, render, waitFor } from '@testing-library/react-native'
import { FlatList } from 'react-native'
import { Swipeable } from 'react-native-gesture-handler'
import { Home } from '../../../App'
import { supabase } from '../../lib/supabase'

jest.mock('../../lib/supabase', () => ({ isSupabaseConfigured: true, supabase: { rpc: jest.fn(), from: jest.fn(), channel: jest.fn(), removeChannel: jest.fn() } }))
jest.mock('../../lib/phoneAuth', () => ({ getAccountId: jest.fn().mockResolvedValue('viewer') }))
jest.mock('expo-location', () => ({ getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }) }))
jest.mock('../OpenChatAudio', () => ({ OpenChatAudioMessage: () => null, OpenChatVoiceRecorder: () => null }))

test('public discovery can complete while the unrelated own-card query is pending', async () => {
  let finishOwn!: (value: unknown) => void
  const pending = new Promise(resolve => { finishOwn = resolve })
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'gt', 'order']) query[method] = jest.fn(() => query)
  query.limit = jest.fn(() => pending)
  jest.mocked(supabase!.from).mockReturnValue(query as never)
  jest.mocked(supabase!.rpc).mockResolvedValue({ data: [], error: null } as never)
  const channel = { on: jest.fn(), subscribe: jest.fn() }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)
  jest.mocked(supabase!.channel).mockReturnValue(channel as never)
  render(<Home onRequest={jest.fn()} onWrite={jest.fn()} guestProfile={{ nickname: '나', age: 30, gender: 'male' }} refreshKey={0} distanceFilter="전체" onDistanceFilterChange={jest.fn()} />)
  await waitFor(() => expect(query.limit).toHaveBeenCalled())
  const reads = jest.mocked(supabase!.rpc).mock.calls.filter(([name]) => name === 'discover_conversation_cards').length
  console.info('[PERF-TEST] discovery reads started while own-card query pending:', reads)
  await act(async () => finishOwn({ data: [], error: null }))
  expect(reads).toBe(1)
})

test('hidden discovery retains its list and validates on return without accepting the previous visit response', async () => {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'gt', 'order']) query[method] = jest.fn(() => query)
  query.limit = jest.fn().mockResolvedValue({ data: [], error: null })
  jest.mocked(supabase!.from).mockReturnValue(query as never)
  const channel = { on: jest.fn(), subscribe: jest.fn() }
  channel.on.mockReturnValue(channel); channel.subscribe.mockReturnValue(channel)
  jest.mocked(supabase!.channel).mockReturnValue(channel as never)
  const row = { id: 'card', author_id: 'peer', nickname: 'Saved peer', birth_year: 1990, topic: 'retained topic', created_at: '2026-09-04T00:00:00Z' }
  const rpc = jest.mocked(supabase!.rpc)
  rpc.mockResolvedValue({ data: [row], error: null } as never)
  const tree = (isActive: boolean, refreshKey = 0) => <Home isActive={isActive} onRequest={jest.fn()} onWrite={jest.fn()} guestProfile={{ nickname: '나', age: 30, gender: 'male' }} refreshKey={refreshKey} distanceFilter="전체" onDistanceFilterChange={jest.fn()} />
  const screen = render(tree(true))
  expect(screen.getByLabelText('발견 목록 불러오는 중')).toBeTruthy()
  await waitFor(() => expect(screen.UNSAFE_getByType(FlatList).props.data).toHaveLength(1))
  let finishOld!: (value: unknown) => void
  rpc.mockImplementation(() => new Promise(resolve => { finishOld = resolve }) as never)
  screen.rerender(tree(true, 1))
  await act(async () => {})
  screen.rerender(tree(false, 1))
  expect(screen.UNSAFE_getAllByType(Swipeable).every(view => view.props.enabled === false)).toBe(true)
  const reads = rpc.mock.calls.length
  await act(async () => finishOld({ data: [{ ...row, topic: 'obsolete' }], error: null }))
  expect(rpc.mock.calls.length).toBe(reads)
  let finishNew!: (value: unknown) => void
  rpc.mockImplementation(() => new Promise(resolve => { finishNew = resolve }) as never)
  screen.rerender(tree(true, 1))
  expect(screen.UNSAFE_getAllByType(Swipeable).every(view => view.props.enabled === true)).toBe(true)
  expect(screen.UNSAFE_getByType(FlatList).props.data[0].topic).toBe('retained topic')
  expect(screen.queryByLabelText('발견 목록 불러오는 중')).toBeNull()
  await act(async () => {})
  await act(async () => finishNew({ data: [{ ...row, topic: 'validated' }], error: null }))
  expect(screen.UNSAFE_getByType(FlatList).props.data[0].topic).toBe('validated')
  screen.unmount()
})

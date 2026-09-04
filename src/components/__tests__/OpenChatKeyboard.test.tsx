import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { Alert, DeviceEventEmitter, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, StyleSheet, type KeyboardEvent } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { OpenChat } from '../OpenChat'
import { Text } from '../../i18n/localizedUi'
import { ChatRoomSafeArea } from '../ChatRoomSafeArea'
import { SwipeDismissView } from '../SwipeDismissView'
import { supabase } from '../../lib/supabase'
import { pickOpenChatPhoto, uploadOpenChatPhoto } from '../../lib/openChatPhoto'
import { uploadOpenChatCover } from '../../lib/openChatCover'
import { logOpenChatDiagnostic } from '../../lib/openChatDiagnostics'

const mockLoadNotificationPreferences = jest.fn()
const mockSaveNotificationPreferences = jest.fn()

jest.mock('react-native', () => {
  const original = jest.requireActual('react-native')
  Object.defineProperty(original.Platform, 'OS', { configurable: true, value: 'android' })
  return original
})
jest.mock('../../lib/phoneAuth', () => ({ getAccountId: jest.fn().mockResolvedValue('current-user') }))
jest.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock('../../lib/observability', () => ({ captureAppError: jest.fn() }))
jest.mock('../../lib/openChatAudio', () => ({
  removeUnsentOpenChatAudio: jest.fn(),
  uploadOpenChatAudio: jest.fn(),
}))
jest.mock('../../lib/openChatPhoto', () => ({
  createOpenChatPhotoUrl: jest.fn().mockResolvedValue('https://example.com/photo.jpg'),
  OPEN_CHAT_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
  pickOpenChatPhoto: jest.fn(),
  removeUnsentOpenChatPhoto: jest.fn().mockResolvedValue(undefined),
  uploadOpenChatPhoto: jest.fn(),
}))
jest.mock('../../lib/openChatCover', () => ({
  getOpenChatCoverUrl: jest.fn((path?: string | null) => path ? `https://example.com/${path}` : null),
  OPEN_CHAT_COVER_MAX_BYTES: 8 * 1024 * 1024,
  removeOpenChatCover: jest.fn().mockResolvedValue(undefined),
  uploadOpenChatCover: jest.fn(),
}))
jest.mock('../../lib/openChatDiagnostics', () => ({ logOpenChatDiagnostic: jest.fn() }))
jest.mock('../../lib/notificationPreferences', () => ({
  loadNotificationPreferences: () => mockLoadNotificationPreferences(),
  saveNotificationPreferences: (preferences: unknown) => mockSaveNotificationPreferences(preferences),
}))
jest.mock('../OpenChatAudio', () => {
  const { View } = jest.requireActual('react-native')
  return {
    OpenChatAudioMessage: () => <View />,
    OpenChatVoiceRecorder: () => <View />,
  }
})
jest.mock('../SwipeDismissView', () => {
  const { View } = jest.requireActual('react-native')
  const MockSwipeDismissView = ({ children }: { children: React.ReactNode }) => <View>{children}</View>
  return { SwipeDismissView: MockSwipeDismissView }
})

const room = {
  room_id: 'room-1', title: '테스트 방', description: '설명', notice: '', category: '수다', region: null,
  tags: [] as string[], member_count: 1, max_members: 20, recent_message_at: null, is_member: true,
  owner_user_id: 'current-user', created_at: '2026-08-31T00:00:00.000Z',
  owner_nickname: '나', cover_storage_path: null, cover_width: null, cover_height: null,
}
const memberRoom = { ...room, owner_user_id: 'other-owner' }
const otherRoom = {
  ...room, room_id: 'room-2', title: '다른 방', is_member: false, owner_user_id: 'other-owner',
}
const participant = {
  user_id: 'current-user', nickname: '나', avatar_url: null as string | null, gender: 'male', birth_year: 1990,
  joined_at: '2026-08-31T00:00:00.000Z', is_owner: true,
}
const otherParticipant = {
  user_id: 'other-user', nickname: '상대방', avatar_url: null as string | null, gender: 'female', birth_year: 1992,
  joined_at: '2026-08-31T00:00:00.000Z', is_owner: false,
}
const rpc = jest.mocked(supabase!.rpc)
const from = jest.mocked(supabase!.from)
const channel = jest.mocked(supabase!.channel)
const pickPhoto = jest.mocked(pickOpenChatPhoto)
const uploadPhoto = jest.mocked(uploadOpenChatPhoto)
const uploadCover = jest.mocked(uploadOpenChatCover)
const openChatDiagnostic = jest.mocked(logOpenChatDiagnostic)
let listedRooms = [room]
let listedMessages: Array<Record<string, unknown>> = []
let listedParticipants = [participant, otherParticipant]
const renderOpenChat = () => render(<SafeAreaProvider initialMetrics={{
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
}}><OpenChat /></SafeAreaProvider>)
const openListedRoom = async (screen: ReturnType<typeof renderOpenChat>) => {
  fireEvent.press(await screen.findByText('테스트 방'))
  await screen.findByTestId('open-chat-room-keyboard-viewport')
}
const openOtherParticipantActions = async (screen: ReturnType<typeof renderOpenChat>) => {
  const participantModal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.testID === 'open-chat-participants-modal')
  if (!participantModal) throw new Error('Expected the participant list modal')
  fireEvent.press(screen.getByRole('button', { name: '상대방님 프로필 및 대화 신청' }))
  if (Platform.OS === 'ios') act(() => participantModal.props.onDismiss?.())
  await screen.findByTestId('open-chat-participant-detail-sheet')
}
const finishParticipantDetailDismiss = (screen: ReturnType<typeof renderOpenChat>) => {
  if (Platform.OS !== 'ios') return
  const detailModal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.testID === 'open-chat-participant-detail-modal')
  if (!detailModal) throw new Error('Expected the participant detail modal')
  act(() => detailModal.props.onDismiss?.())
}

beforeEach(() => {
  listedRooms = [room]
  listedMessages = []
  listedParticipants = [participant, otherParticipant]
  pickPhoto.mockReset()
  uploadPhoto.mockReset()
  uploadCover.mockReset()
  mockLoadNotificationPreferences.mockReset()
  mockSaveNotificationPreferences.mockReset()
  mockLoadNotificationPreferences.mockReturnValue(new Promise(() => undefined))
  mockSaveNotificationPreferences.mockResolvedValue(undefined)
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'list_open_chat_rooms' ? listedRooms
      : name === 'open_chat_participant_profiles' ? listedParticipants
        : name === 'my_blocked_users' ? [] : null,
    error: null,
  }) as never)
  from.mockImplementation((table: string) => {
    const query = {
      select: jest.fn(), eq: jest.fn(), order: jest.fn(),
      limit: jest.fn(async (count: number) => ({ data: table === 'open_chat_messages'
        ? [...listedMessages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id)).slice(0, count) : [], error: null })),
    }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.order.mockReturnValue(query)
    return query as never
  })
  const realtimeChannel = {
    on: jest.fn(), subscribe: jest.fn(),
  }
  realtimeChannel.on.mockReturnValue(realtimeChannel)
  realtimeChannel.subscribe.mockReturnValue(realtimeChannel)
  channel.mockReturnValue(realtimeChannel as never)
})

test('Android room creation uses the proven keyboard-aware sticky-footer layout', async () => {
  listedRooms = [memberRoom]
  const screen = renderOpenChat()
  await waitFor(() => expect(screen.getByText('테스트 방')).toBeTruthy())
  fireEvent.press(screen.getByText('방 만들기'))
  const viewport = screen.getByTestId('open-chat-create-viewport')
  expect(StyleSheet.flatten(viewport.props.style)).toEqual(expect.objectContaining({ flex: 1 }))
  const keyboardViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-create-viewport')
  expect(keyboardViewport?.props.enabled).toBe(true)
  expect(keyboardViewport?.props.behavior).toBe('padding')
  expect(keyboardViewport?.props.keyboardVerticalOffset).toBe(0)
  if (!viewport.findByProps({ testID: 'open-chat-create-footer' })) throw new Error('Expected the create actions inside the resized modal viewport')
  const form = screen.getByTestId('open-chat-create-form')
  if (form.findAllByProps({ testID: 'open-chat-create-footer' }).length > 0) throw new Error('Expected the create actions outside the scrolling form')
  expect(form.props.automaticallyAdjustKeyboardInsets).toBe(false)
  expect(StyleSheet.flatten(form.props.contentContainerStyle)).toEqual(expect.objectContaining({ paddingBottom: 50 }))
  expect(screen.getByTestId('open-chat-create-region-input').props.onFocus).toBeUndefined()
  expect(screen.getByTestId('open-chat-create-tags-input').props.onFocus).toBeUndefined()
  expect(StyleSheet.flatten(screen.getByTestId('open-chat-create-footer').props.style)).not.toEqual(expect.objectContaining({ position: 'absolute' }))
  fireEvent(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), 'focus')
  expect(screen.getByText('취소')).toBeTruthy()
  expect(screen.getByText('만들기 · 100P')).toBeTruthy()
  expect(screen.getByText('함께 이야기할 방의 정보를 입력해 주세요. 만들 때 100P가 사용돼요.')).toBeTruthy()
})

test('header refresh button reloads the room list from the server', async () => {
  const screen = renderOpenChat()
  await screen.findByText('테스트 방')
  const listCallsBeforeRefresh = rpc.mock.calls.filter(([name]) => name === 'list_open_chat_rooms').length

  fireEvent.press(screen.getByRole('button', { name: '수다방 새로고침' }))

  await waitFor(() => expect(rpc.mock.calls.filter(([name]) => name === 'list_open_chat_rooms')).toHaveLength(listCallsBeforeRefresh + 1))
  const headerActions = screen.getByTestId('open-chat-header-actions')
  expect(headerActions.findByProps({ accessibilityLabel: '수다방 새로고침' })).toBeTruthy()
  expect(headerActions.findByProps({ accessibilityLabel: '수다방 만들기' })).toBeTruthy()
})

test('message event bursts queue one fresh read after the in-flight room refresh', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  const realtime = channel.mock.results[channel.mock.results.length - 1]!.value
  const onMessage = realtime.on.mock.calls.find((args: unknown[]) => (args[1] as { table: string }).table === 'open_chat_messages')[2]
  const baseline = from.mock.calls.length
  const rpcBaseline = rpc.mock.calls.length
  const pending: Array<(value: unknown) => void> = []
  const originalRpc = rpc.getMockImplementation()!
  rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'open_chat_participant_profiles'
    ? new Promise(resolve => pending.push(resolve)) as never
    : (originalRpc as Function)(name, ...args))
  await act(async () => { onMessage() })
  await act(async () => { onMessage(); onMessage() })
  const concurrentReads = from.mock.calls.length - baseline
  console.info('[PERF-TEST] open chat burst concurrent message reads:', concurrentReads)
  // Release the first wave, then the trailing refresh. No event may be lost.
  await act(async () => { pending.splice(0).forEach(resolve => resolve({ data: listedParticipants, error: null })) })
  await act(async () => { pending.splice(0).forEach(resolve => resolve({ data: listedParticipants, error: null })) })
  const refreshRequests = from.mock.calls.length - baseline + rpc.mock.calls.slice(rpcBaseline).filter(([name]) => name === 'open_chat_participant_profiles' || name === 'my_blocked_users').length
  console.info('[PERF-TEST] open chat burst total refresh requests:', refreshRequests)
  expect(concurrentReads).toBe(1)
  expect(from.mock.calls.length - baseline).toBe(2)
})

test('search filters rooms from the right side of the sort row and can be cleared', async () => {
  listedRooms = [room, { ...otherRoom, description: '독서 이야기를 나눠요', category: '취미', tags: ['책'] as string[] }]
  const screen = renderOpenChat()
  await screen.findByText('테스트 방')

  fireEvent.press(screen.getByRole('button', { name: '수다방 검색' }))
  const searchInput = screen.getByPlaceholderText('방 이름, 소개, 카테고리 검색')
  fireEvent.changeText(searchInput, '책')

  expect(screen.queryByText('테스트 방')).toBeNull()
  expect(screen.getByText('다른 방')).toBeTruthy()

  fireEvent.changeText(searchInput, '없는 검색어')
  expect(screen.getByText('“없는 검색어” 검색 결과가 없어요.')).toBeTruthy()

  fireEvent.press(screen.getByRole('button', { name: '수다방 검색어 지우기' }))
  expect(screen.getByText('테스트 방')).toBeTruthy()
  expect(screen.getByText('다른 방')).toBeTruthy()
})

test('room list uses the shared primary-tab left and top starting lines', async () => {
  const screen = renderOpenChat()
  await screen.findByText('테스트 방')

  expect(StyleSheet.flatten(screen.getByTestId('open-chat-sort-bar').props.style)).toEqual(expect.objectContaining({
    paddingHorizontal: 20,
    paddingBottom: 16,
  }))
  expect(StyleSheet.flatten(screen.getByTestId('open-chat-room-list').props.contentContainerStyle)).toEqual(expect.objectContaining({
    paddingHorizontal: 20,
    paddingTop: 0,
  }))

  fireEvent.press(screen.getByRole('button', { name: '수다방 검색' }))
  expect(StyleSheet.flatten(screen.getByTestId('open-chat-search-row').props.style)).toEqual(expect.objectContaining({
    marginHorizontal: 20,
    marginBottom: 16,
  }))
})

test('room creation uses a compact capacity stepper and sends the selected number', async () => {
  listedRooms = [{ ...memberRoom, is_member: false }]
  const screen = renderOpenChat()
  await waitFor(() => expect(screen.getByText('테스트 방')).toBeTruthy())
  fireEvent.press(screen.getByText('방 만들기'))

  expect(screen.getByTestId('open-chat-capacity-stepper')).toBeTruthy()
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(screen.getByLabelText('최대 인원 10명')).toBeTruthy()
  const decrement = screen.getByRole('button', { name: '최대 인원 1명 줄이기' })
  fireEvent.press(decrement)
  fireEvent.press(decrement)
  fireEvent.press(decrement)
  expect(screen.getByLabelText('최대 인원 7명')).toBeTruthy()
  fireEvent.changeText(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), '저녁 수다방')
  fireEvent.changeText(screen.getByPlaceholderText('방을 짧게 소개해 주세요'), '함께 이야기해요')
  await act(async () => {
    fireEvent.press(screen.getByText('만들기 · 100P'))
    await Promise.resolve()
    await Promise.resolve()
  })

  await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_open_chat_room', expect.objectContaining({ room_max_members: 7 })))
})

test('room creation explains the 100 point requirement when the wallet is insufficient', async () => {
  listedRooms = [{ ...memberRoom, is_member: false }]
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'list_open_chat_rooms' ? listedRooms : null,
    error: name === 'create_open_chat_room' ? { message: 'insufficient_points' } : null,
  }) as never)
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    await screen.findByText('테스트 방')
    fireEvent.press(screen.getByText('방 만들기'))
    fireEvent.changeText(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), '포인트 확인방')
    fireEvent.changeText(screen.getByPlaceholderText('방을 짧게 소개해 주세요'), '잔액 부족 테스트')
    await act(async () => {
      fireEvent.press(screen.getByText('만들기 · 100P'))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(alertSpy).toHaveBeenCalledWith('포인트가 부족해요', '수다방을 만들려면 100P가 필요합니다.')
  } finally {
    screen.unmount()
    alertSpy.mockRestore()
  }
})

test('room creation uploads an optional representative photo', async () => {
  listedRooms = [{ ...memberRoom, is_member: false }]
  pickPhoto.mockResolvedValue({ uri: 'file:///cover.jpg', width: 1600, height: 1000, mimeType: 'image/jpeg', fileSize: 2048 } as never)
  uploadCover.mockResolvedValue('new-room/current-user/cover-id.jpg')
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'list_open_chat_rooms' ? listedRooms : name === 'create_open_chat_room' ? 'new-room' : null,
    error: null,
  }) as never)
  const screen = renderOpenChat()
  await screen.findByText('테스트 방')
  fireEvent.press(screen.getByText('방 만들기'))
  fireEvent.press(screen.getByRole('button', { name: '대표사진 선택' }))
  await screen.findByRole('button', { name: '대표사진 변경' })
  fireEvent.changeText(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), '사진 있는 방')
  fireEvent.changeText(screen.getByPlaceholderText('방을 짧게 소개해 주세요'), '대표사진 테스트')
  await act(async () => {
    fireEvent.press(screen.getByText('만들기 · 100P'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  })
  await waitFor(() => expect(uploadCover).toHaveBeenCalledWith('new-room', 'current-user', 'file:///cover.jpg', 'image/jpeg'))
  expect(rpc).toHaveBeenCalledWith('set_open_chat_room_cover', {
    room_uuid: 'new-room', cover_path: 'new-room/current-user/cover-id.jpg', image_width: 1600, image_height: 1000,
  })
  screen.unmount()
})

test('iPhone keeps create actions above the keyboard and lets the form adjust to the focused field', async () => {
  listedRooms = [memberRoom]
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  const keyboardListeners = new Map<string, (event: KeyboardEvent) => void>()
  const keyboardSpy = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
    keyboardListeners.set(event, listener)
    return { remove: () => { keyboardListeners.delete(event) } } as ReturnType<typeof Keyboard.addListener>
  })
  const screen = renderOpenChat()
  try {
    await waitFor(() => expect(screen.getByText('테스트 방')).toBeTruthy())
    fireEvent.press(screen.getByText('방 만들기'))
    const viewport = screen.getByTestId('open-chat-create-viewport')
    const keyboardViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-create-viewport')
    expect(keyboardViewport?.props.enabled).toBe(false)
    expect(keyboardViewport?.props.behavior).toBeUndefined()
    if (!viewport.findByProps({ testID: 'open-chat-create-footer' })) throw new Error('Expected the iPhone create actions inside the resized viewport')
    const form = screen.getByTestId('open-chat-create-form')
    if (form.findAllByProps({ testID: 'open-chat-create-footer' }).length > 0) throw new Error('Expected the iPhone create actions outside the scrolling form')
    expect(form.props.automaticallyAdjustKeyboardInsets).toBe(true)
    act(() => keyboardListeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { screenY: 100 } } as KeyboardEvent))
    await waitFor(() => {
      const safeAreaStyle = StyleSheet.flatten(screen.getByTestId('open-chat-create-safe-area').props.style)
      if (!(Number(safeAreaStyle?.paddingBottom) > 0)) throw new Error('Expected the create footer safe area to move above the iPhone keyboard')
      expect(StyleSheet.flatten(screen.getByTestId('open-chat-create-form').props.contentContainerStyle)).toEqual(expect.objectContaining({ paddingBottom: 50 }))
    })
  } finally {
    screen.unmount()
    keyboardSpy.mockRestore()
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  }
})

test('room owner can open creation but must leave before submitting or entering another room', async () => {
  listedRooms = [room, otherRoom]
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    await screen.findByText('테스트 방')
    fireEvent.press(screen.getByText('방 만들기'))
    expect(screen.getByText('수다방 만들기')).toBeTruthy()
    fireEvent.changeText(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), '새로운 수다방')
    fireEvent.changeText(screen.getByPlaceholderText('방을 짧게 소개해 주세요'), '새로운 방 설명')
    fireEvent.press(screen.getByText('만들기 · 100P'))
    expect(alertSpy).toHaveBeenCalledWith(
      '새 수다방을 만들 수 없습니다',
      '방장으로 운영 중인 “테스트 방”에서 먼저 나간 후 새 수다방을 만들어 주세요.',
    )
    expect(rpc).not.toHaveBeenCalledWith('create_open_chat_room', expect.anything())

    fireEvent.press(screen.getByText('취소'))
    fireEvent.press(screen.getByText('다른 방'))
    fireEvent.press(screen.getByRole('button', { name: '입장하기' }))
    expect(alertSpy).toHaveBeenCalledWith(
      '다른 수다방에 입장할 수 없습니다',
      '방장으로 운영 중인 “테스트 방”에서 먼저 나간 후 다른 수다방에 입장해 주세요.',
    )
    expect(rpc).not.toHaveBeenCalledWith('join_open_chat_room', expect.anything())
  } finally {
    alertSpy.mockRestore()
  }
})

test('non-owner member confirms automatic leave before entering another room', async () => {
  listedRooms = [memberRoom, otherRoom]
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    await screen.findByText('테스트 방')
    fireEvent.press(screen.getByText('다른 방'))
    fireEvent.press(screen.getByRole('button', { name: '입장하기' }))

    expect(rpc).not.toHaveBeenCalledWith('join_open_chat_room', expect.anything())
    const confirmation = alertSpy.mock.calls.find(([title]) => title === '기존 수다방에서 나가게 됩니다')
    expect(confirmation?.[1]).toBe('“다른 방”에 입장하면 현재 참여 중인 “테스트 방”에서 자동으로 퇴장합니다. 계속할까요?')
    const confirmButton = confirmation?.[2]?.find(button => button.text === '퇴장 후 입장')
    await act(async () => {
      confirmButton?.onPress?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('join_open_chat_room', { room_uuid: 'room-2' }))
    await screen.findByTestId('open-chat-room-keyboard-viewport')
  } finally {
    screen.unmount()
    alertSpy.mockRestore()
  }
})

test('non-owner member confirms automatic leave before creating a room', async () => {
  listedRooms = [memberRoom]
  rpc.mockImplementation((name: string) => Promise.resolve({
    data: name === 'list_open_chat_rooms' ? listedRooms : name === 'create_open_chat_room' ? 'new-room' : null,
    error: null,
  }) as never)
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    await screen.findByText('테스트 방')
    fireEvent.press(screen.getByText('방 만들기'))
    fireEvent.changeText(screen.getByPlaceholderText('어떤 대화를 나눌까요?'), '내가 만드는 방')
    fireEvent.changeText(screen.getByPlaceholderText('방을 짧게 소개해 주세요'), '자동 퇴장 확인')
    fireEvent.press(screen.getByText('만들기 · 100P'))

    expect(rpc).not.toHaveBeenCalledWith('create_open_chat_room', expect.anything())
    const confirmation = alertSpy.mock.calls.find(([title]) => title === '기존 수다방에서 나가게 됩니다')
    expect(confirmation?.[1]).toBe('새 수다방을 만들면 현재 참여 중인 “테스트 방”에서 자동으로 퇴장하며 100P가 사용됩니다. 계속할까요?')
    const confirmButton = confirmation?.[2]?.find(button => button.text === '퇴장 후 만들기')
    await act(async () => {
      confirmButton?.onPress?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_open_chat_room', expect.objectContaining({ room_title: '내가 만드는 방' })))
  } finally {
    screen.unmount()
    alertSpy.mockRestore()
  }
})

test('room composer and room editor keep actions above the Android keyboard', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByTestId('open-chat-room-keyboard-viewport')).toBeTruthy())
  const roomViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-room-keyboard-viewport')
  expect(roomViewport?.props.enabled).toBe(true)
  expect(roomViewport?.props.behavior).toBe('padding')
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('방 정보 및 공지 관리'))
  const editViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-edit-keyboard-viewport')
  expect(editViewport?.props.enabled).toBe(true)
  expect(editViewport?.props.behavior).toBe('padding')
})

test('room anchors the newest dynamic-height message above the in-flow composer', async () => {
  listedMessages = [
    { id: 1, room_id: 'room-1', sender_user_id: 'other-user', message_type: 'text', content: '먼저 온 메시지', created_at: '2026-08-31T00:00:00.000Z' },
    { id: 2, room_id: 'room-1', sender_user_id: 'current-user', message_type: 'audio', content: null, audio_storage_path: 'room/audio.m4a', audio_duration_ms: 3000, created_at: '2026-08-31T00:01:00.000Z' },
    { id: 3, room_id: 'room-1', sender_user_id: 'other-user', message_type: 'text', content: '가장 최근 메시지', created_at: '2026-08-31T00:02:00.000Z' },
  ]
  const screen = renderOpenChat()
  try {
    await openListedRoom(screen)

    const viewport = screen.getByTestId('open-chat-room-keyboard-viewport')
    const list = viewport.findByType(FlatList)
    const composer = screen.getByTestId('open-chat-composer')
    expect(list.props.inverted).toBe(true)
    expect(list.props.data.map((message: { id: number }) => message.id)).toEqual([3, 2, 1])
    expect(StyleSheet.flatten(composer.props.style).position).not.toBe('absolute')
  } finally {
    screen.unmount()
  }
})

test('room messages and participant list use the Discover gender nickname colors', async () => {
  listedMessages = [
    { id: 1, room_id: 'room-1', sender_user_id: 'other-user', message_type: 'text', content: '여성 참여자 메시지', created_at: '2026-08-31T00:00:00.000Z' },
    { id: 2, room_id: 'room-1', sender_user_id: 'current-user', message_type: 'text', content: '내 메시지', created_at: '2026-08-31T00:01:00.000Z' },
  ]
  const screen = renderOpenChat()
  try {
    await openListedRoom(screen)

    expect(StyleSheet.flatten(screen.getByTestId('open-chat-message-sender-1').props.style).color).toBe('#E04468')
    expect(StyleSheet.flatten(screen.getByTestId('open-chat-message-sender-2').props.style).color).toBe('#827670')

    fireEvent.press(screen.getByText('☰'))
    fireEvent.press(screen.getByText('참여자 보기'))
    expect(StyleSheet.flatten(screen.getByTestId('open-chat-participant-name-current-user').props.style).color).toBe('#2563EB')
    expect(StyleSheet.flatten(screen.getByTestId('open-chat-participant-name-other-user').props.style).color).toBe('#E04468')
  } finally {
    screen.unmount()
  }
})

test('room card opens an information preview before entering the room', async () => {
  listedRooms = [{ ...room, is_member: false, owner_user_id: 'other-owner' }]
  const screen = renderOpenChat()
  fireEvent.press(await screen.findByText('테스트 방'))
  expect(screen.getByText('수다방 미리보기')).toBeTruthy()
  expect(screen.getByText('현재 인원')).toBeTruthy()
  expect(screen.getByText('방장')).toBeTruthy()
  expect(screen.queryByTestId('open-chat-room-keyboard-viewport')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '입장하기' }))
  await screen.findByTestId('open-chat-room-keyboard-viewport')
  screen.unmount()
})

test('joined room opens immediately without showing the room preview', async () => {
  listedRooms = [memberRoom]
  const screen = renderOpenChat()

  fireEvent.press(await screen.findByRole('button', { name: '테스트 방 수다방 바로 열기' }))

  await screen.findByTestId('open-chat-room-keyboard-viewport')
  expect(screen.queryByText('수다방 미리보기')).toBeNull()
  expect(rpc).not.toHaveBeenCalledWith('join_open_chat_room', expect.anything())
  screen.unmount()
})

test('room menu opens existing room details above the participant action without another enter button', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())

  fireEvent.press(screen.getByText('☰'))
  const menu = screen.getByTestId('open-chat-room-menu')
  expect(menu.findByProps({ testID: 'open-chat-room-info-action' })).toBeTruthy()
  expect(menu.findByProps({ testID: 'open-chat-participants-action' })).toBeTruthy()
  fireEvent.press(screen.getByText('수다방 정보 보기'))

  expect(screen.getByText('수다방 정보')).toBeTruthy()
  expect(screen.getByText('설명')).toBeTruthy()
  expect(screen.getByText('2/20명')).toBeTruthy()
  expect(screen.getByText('나')).toBeTruthy()
  expect(screen.queryByText('수다방 들어가기')).toBeNull()
  expect(screen.queryByText('입장하기')).toBeNull()
  fireEvent.press(screen.getByRole('button', { name: '수다방 정보 닫기' }))
  expect(screen.queryByText('수다방 정보')).toBeNull()
  expect(screen.getByTestId('open-chat-room-keyboard-viewport')).toBeTruthy()
})

test('room menu toggles the same global open-chat notification preference used by settings', async () => {
  mockLoadNotificationPreferences.mockResolvedValue({
    message_enabled: true,
    open_chat_enabled: true,
    request_enabled: true,
    preview_enabled: true,
    sound_enabled: true,
    vibration_enabled: true,
  })
  const screen = renderOpenChat()
  await openListedRoom(screen)

  fireEvent.press(screen.getByText('☰'))
  await screen.findByText('수다방 알림 끄기')
  const disableButton = screen.getByTestId('open-chat-notification-toggle')
  expect(disableButton.props.accessibilityLabel).toBe('수다방 알림 끄기')
  fireEvent.press(disableButton)

  await waitFor(() => expect(mockSaveNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
    message_enabled: true,
    open_chat_enabled: false,
    request_enabled: true,
  })))
  expect(screen.getByRole('button', { name: '수다방 알림 켜기' })).toBeTruthy()

  fireEvent.press(screen.getByRole('button', { name: '수다방 알림 켜기' }))
  await waitFor(() => expect(mockSaveNotificationPreferences).toHaveBeenLastCalledWith(expect.objectContaining({
    open_chat_enabled: true,
  })))
  expect(screen.getByRole('button', { name: '수다방 알림 끄기' })).toBeTruthy()
  screen.unmount()
})

test('open room connects the left-to-right swipe gesture to the room list back action', async () => {
  listedRooms = [memberRoom]
  const screen = renderOpenChat()
  await openListedRoom(screen)

  const swipeBack = screen.UNSAFE_getByType(SwipeDismissView)
  expect(swipeBack.props.enterFromRight).toBe(false)
  expect(swipeBack.props.enabled).toBe(true)
  await act(async () => {
    swipeBack.props.onDismiss()
    await Promise.resolve()
    await Promise.resolve()
  })

  await screen.findByRole('button', { name: '테스트 방 수다방 바로 열기' })
  expect(screen.queryByTestId('open-chat-room-keyboard-viewport')).toBeNull()
  screen.unmount()
})

test('room composer selects and sends a photo from the leftmost attachment action', async () => {
  pickPhoto.mockResolvedValue({
    uri: 'file:///photo.jpg', width: 1200, height: 900, mimeType: 'image/jpeg', fileSize: 1024,
  } as never)
  uploadPhoto.mockResolvedValue('room-1/current-user/photo-id.jpg')
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await screen.findByTestId('open-chat-room-keyboard-viewport')

  fireEvent.press(screen.getByRole('button', { name: '사진 보내기' }))
  await screen.findByText('사진 첨부됨')
  fireEvent.changeText(screen.getByPlaceholderText('메시지 입력'), '사진 설명')
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: '메시지 전송' }))
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(uploadPhoto).toHaveBeenCalledWith('room-1', 'current-user', 'file:///photo.jpg', 'image/jpeg')
  expect(rpc).toHaveBeenCalledWith('create_open_chat_image_message', {
    room_uuid: 'room-1', image_path: 'room-1/current-user/photo-id.jpg', image_width: 1200,
    image_height: 900, text_content: '사진 설명', reply_message_id: null,
  })
  screen.unmount()
})

test('request dialog avoids the Android keyboard while report dialog relies on native resize', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  await openOtherParticipantActions(screen)
  fireEvent.press(screen.getByRole('button', { name: '상대방님에게 대화 신청' }))
  finishParticipantDetailDismiss(screen)
  await screen.findByTestId('open-chat-request-keyboard-viewport')
  const requestViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-request-keyboard-viewport')
  expect(requestViewport?.props.enabled).toBe(true)
  expect(requestViewport?.props.behavior).toBe('padding')
  expect(screen.getByRole('button', { name: '대화 신청 창 닫기' })).toBeTruthy()
  fireEvent.press(screen.getByText('취소'))
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  await openOtherParticipantActions(screen)
  fireEvent.press(screen.getByText('사용자 신고'))
  const reportViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-report-keyboard-viewport')
  expect(reportViewport?.props.enabled).toBe(true)
  expect(reportViewport?.props.behavior).toBe('padding')
  expect(screen.getByRole('button', { name: '신고 창 닫기' })).toBeTruthy()
})

test('participant selection sends a private chat request through the existing request inbox', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    await openListedRoom(screen)
    await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
    fireEvent.press(screen.getByText('☰'))
    fireEvent.press(screen.getByText('참여자 보기'))

    expect(screen.getByText('대화 신청')).toBeTruthy()
    expect(screen.getByRole('button', { name: '나님 내 프로필' })).toBeTruthy()
    await openOtherParticipantActions(screen)
    const requestAction = screen.getByRole('button', { name: '상대방님에게 대화 신청' })
    expect(screen.getByTestId('open-chat-participant-detail-sheet').findByProps({ testID: 'open-chat-participant-request-button' })).toBeTruthy()
    expect(screen.getByTestId('open-chat-participant-detail-backdrop')).toBeTruthy()
    expect(screen.getByText('사용자 신고')).toBeTruthy()
    expect(screen.getByText('사용자 차단')).toBeTruthy()
    expect(screen.getByText('방장 넘기기')).toBeTruthy()
    expect(screen.getByText('강퇴 및 재입장 제한')).toBeTruthy()
    fireEvent(requestAction, 'pressIn')
    fireEvent.press(requestAction)
    finishParticipantDetailDismiss(screen)
    const openingInput = await screen.findByPlaceholderText('첫 인사를 입력해 주세요')
    expect(openingInput.props.autoFocus).toBe(true)
    expect(openingInput.props.showSoftInputOnFocus).toBe(true)
    expect(screen.queryByText('참여자 2')).toBeNull()
    expect(screen.queryByTestId('open-chat-participant-detail-sheet')).toBeNull()
    expect(screen.getByText('상대방님에게 대화 신청')).toBeTruthy()
    await waitFor(() => {
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_BUTTON_PRESS_IN')
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_BUTTON_PRESS')
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_TARGET_SET')
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_DETAIL_CLOSE')
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_COMPOSER_OPEN')
      expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_COMPOSER_RENDER')
    })
    fireEvent.changeText(openingInput, '수다방에서 만나 반가웠어요!')
    await act(async () => {
      fireEvent.press(screen.getByText('대화 신청 · 100P'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(rpc).toHaveBeenCalledWith('create_open_chat_request', {
      room_uuid: 'room-1',
      receiver_uuid: 'other-user',
      opening_text: '수다방에서 만나 반가웠어요!',
    })
    expect(alertSpy).toHaveBeenCalledWith('대화 요청 완료', '기존 대화 탭에서 상대방의 수락을 기다려 주세요.')
  } finally {
    screen.unmount()
    alertSpy.mockRestore()
  }
})

test('Android opens participant actions without relying on native Modal onDismiss', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))

  const participantModal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.testID === 'open-chat-participants-modal')
  if (!participantModal) throw new Error('Expected the participant list modal')
  fireEvent.press(screen.getByRole('button', { name: '상대방님 프로필 및 대화 신청' }))

  expect(participantModal.props.visible).toBe(false)
  expect(screen.getByTestId('open-chat-participant-detail-inline')).toBeTruthy()
  expect(screen.getByRole('button', { name: '상대방님에게 대화 신청' })).toBeTruthy()
  expect(openChatDiagnostic).toHaveBeenCalledWith('OPEN_CHAT_REQUEST_DETAIL_OPEN')
})

test('Android Back closes only the inline request composer and keeps the room open', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  await openOtherParticipantActions(screen)
  fireEvent.press(screen.getByRole('button', { name: '상대방님에게 대화 신청' }))
  await screen.findByPlaceholderText('첫 인사를 입력해 주세요')

  const roomModal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.presentationStyle === 'fullScreen' && item.props.visible)
  if (!roomModal) throw new Error('Expected the room modal')
  act(() => roomModal.props.onRequestClose())

  expect(screen.queryByPlaceholderText('첫 인사를 입력해 주세요')).toBeNull()
  expect(screen.getByText('2명 · 방장 나')).toBeTruthy()
})

test('message sender and participant list open the same user action component', async () => {
  listedMessages = [{
    id: 1, room_id: 'room-1', sender_user_id: 'other-user', message_type: 'text', content: '반가워요',
    audio_storage_path: null, audio_duration_ms: null, image_storage_path: null, image_width: null,
    image_height: null, reply_to_message_id: null, created_at: '2026-08-31T00:00:00.000Z',
  }]
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await screen.findByText('반가워요')

  fireEvent.press(screen.getByRole('button', { name: '상대방님 사용자 메뉴' }))
  expect(screen.getByTestId('open-chat-participant-detail-sheet')).toBeTruthy()
  expect(screen.getByRole('button', { name: '상대방님에게 대화 신청' })).toBeTruthy()
  fireEvent.press(screen.getByText('닫기'))

  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  await openOtherParticipantActions(screen)
  expect(screen.getByTestId('open-chat-participant-detail-sheet')).toBeTruthy()
  expect(screen.getByRole('button', { name: '상대방님에게 대화 신청' })).toBeTruthy()
})

test('selecting the current user from participants hides request, report, block, and owner controls', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  const participantModal = screen.UNSAFE_getAllByType(Modal).find(item => item.props.testID === 'open-chat-participants-modal')
  if (!participantModal) throw new Error('Expected the participant list modal')
  fireEvent.press(screen.getByRole('button', { name: '나님 내 프로필' }))
  if (Platform.OS === 'ios') act(() => participantModal.props.onDismiss?.())
  await screen.findByTestId('open-chat-participant-detail-sheet')

  expect(screen.queryByText('대화 신청')).toBeNull()
  expect(screen.queryByText('사용자 신고')).toBeNull()
  expect(screen.queryByText('사용자 차단')).toBeNull()
  expect(screen.queryByText('방장 넘기기')).toBeNull()
  expect(screen.queryByText('강퇴 및 재입장 제한')).toBeNull()
})

test('participant action menu reuses the existing zoomable profile photo viewer', async () => {
  listedParticipants = [participant, { ...otherParticipant, avatar_url: 'https://example.com/profile.jpg' }]
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))
  await openOtherParticipantActions(screen)

  fireEvent.press(screen.getByRole('imagebutton', { name: '상대방님의 프로필 사진 크게 보기' }))
  expect(screen.getByText('두 손가락으로 확대 · 한 손가락으로 이동 · 두 번 탭으로 초기화')).toBeTruthy()
  fireEvent.press(screen.getByRole('button', { name: '프로필 사진 닫기' }))

  expect(screen.queryByRole('button', { name: '프로필 사진 닫기' })).toBeNull()
  expect(screen.getByRole('button', { name: '상대방님에게 대화 신청' })).toBeTruthy()
})

test('iPhone shows the participant request composer inside the room instead of stacking another native modal', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  const screen = renderOpenChat()
  try {
    await openListedRoom(screen)
    await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())
    fireEvent.press(screen.getByText('☰'))
    fireEvent.press(screen.getByText('참여자 보기'))
    await openOtherParticipantActions(screen)
    fireEvent.press(screen.getByRole('button', { name: '상대방님에게 대화 신청' }))
    finishParticipantDetailDismiss(screen)

    await screen.findByPlaceholderText('첫 인사를 입력해 주세요')
    const visibleNativeModals = screen.UNSAFE_getAllByType(Modal).filter(item => item.props.visible !== false)
    expect(visibleNativeModals).toHaveLength(1)
    expect(visibleNativeModals[0]?.props.presentationStyle).toBe('fullScreen')
  } finally {
    screen.unmount()
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  }
})

test('participant list keeps a visible close target and does not expose room leave', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await waitFor(() => expect(screen.getByText('2명 · 방장 나')).toBeTruthy())

  fireEvent.press(screen.getByText('☰'))
  fireEvent.press(screen.getByText('참여자 보기'))

  const closeButton = screen.getByRole('button', { name: '참여자 보기 닫기' })
  expect(StyleSheet.flatten(closeButton.props.style)).toEqual(expect.objectContaining({
    width: 68,
    minHeight: 48,
  }))
  expect(screen.queryByText('나가기')).toBeNull()
  expect(screen.getByText('참여자 2')).toBeTruthy()
})

test('iPhone room uses the same full-screen safe-area and newest-message anchor as direct chat', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  listedMessages = [
    { id: 1, room_id: 'room-1', sender_user_id: 'other-user', message_type: 'text', content: '먼저 온 메시지', created_at: '2026-08-31T00:00:00.000Z' },
    { id: 2, room_id: 'room-1', sender_user_id: 'current-user', message_type: 'text', content: '가장 최근 메시지', created_at: '2026-08-31T00:01:00.000Z' },
  ]
  const screen = renderOpenChat()
  try {
    await openListedRoom(screen)
    await waitFor(() => expect(screen.getByTestId('open-chat-room-keyboard-viewport')).toBeTruthy())
    const keyboardViewport = screen.UNSAFE_getAllByType(KeyboardAvoidingView).find(item => item.props.testID === 'open-chat-room-keyboard-viewport')
    if (keyboardViewport?.props.behavior !== 'padding') throw new Error(`Expected iOS padding behavior, received ${String(keyboardViewport?.props.behavior)}`)
    const fullScreenRoom = screen.UNSAFE_getAllByType(Modal).find(item => item.props.visible === true && item.props.presentationStyle === 'fullScreen')
    if (!fullScreenRoom) throw new Error('Expected the iPhone open-chat room to use a full-screen modal')
    const list = screen.getByTestId('open-chat-room-keyboard-viewport').findByType(FlatList)
    expect(list.props.inverted).toBe(true)
    expect(list.props.data.map((message: { id: number }) => message.id)).toEqual([2, 1])
    expect(screen.UNSAFE_getByType(ChatRoomSafeArea)).toBeTruthy()
  } finally {
    screen.unmount()
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' })
  }
})

test('system history survives duplicate Realtime events, background, reconnect, back and remount without membership writes', async () => {
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await screen.findByText('2명 · 방장 나')
  const subscribed = channel.mock.results.at(-1)!.value as { on: jest.Mock; subscribe: jest.Mock }
  const messageChanged = subscribed.on.mock.calls.find(([, filter]) => filter.table === 'open_chat_messages')![2]
  const participantChanged = subscribed.on.mock.calls.find(([, filter]) => filter.table === 'open_chat_participants')![2]
  const statusChanged = subscribed.subscribe.mock.calls.at(-1)![0]
  await act(async () => {
    DeviceEventEmitter.emit('appStateDidChange', { app_state: 'background' })
    DeviceEventEmitter.emit('appStateDidChange', { app_state: 'active' })
  })
  listedMessages = [{ id: 1, room_id: 'room-1', sender_user_id: null, message_type: 'system', content: '새참여자님이 입장했습니다.', created_at: '2026-09-04T01:00:00Z' }]
  await act(async () => { messageChanged(); participantChanged(); messageChanged() })
  expect(screen.getAllByText('새참여자님이 입장했습니다.')).toHaveLength(1)
  const list = screen.getByTestId('open-chat-room-keyboard-viewport').findByType(FlatList)
  const systemRow = list.props.renderItem({ item: listedMessages[0] })
  expect(systemRow.type).toBe(Text)
  expect(systemRow.props.onPress).toBeUndefined()
  expect(systemRow.props.onLongPress).toBeUndefined()
  listedMessages.push({ id: 2, room_id: 'room-1', sender_user_id: null, message_type: 'system', content: '새참여자님이 퇴장했습니다.', created_at: '2026-09-04T01:00:01Z' })
  await act(async () => { statusChanged('CHANNEL_ERROR'); statusChanged('SUBSCRIBED'); statusChanged('SUBSCRIBED') })
  expect(screen.getAllByText('새참여자님이 퇴장했습니다.')).toHaveLength(1)
  expect(list.props.data.map((item: { id: number }) => item.id)).toEqual([2, 1])
  fireEvent.press(screen.getByText('‹'))
  await act(async () => {})
  await openListedRoom(screen)
  await screen.findByText('새참여자님이 퇴장했습니다.')
  screen.unmount()
  const reopened = renderOpenChat()
  await openListedRoom(reopened)
  await reopened.findByText('새참여자님이 입장했습니다.')
  expect(rpc.mock.calls.some(([name]) => name === 'join_open_chat_room' || name === 'leave_open_chat_room')).toBe(false)
  expect(from.mock.calls.some(([table]) => table === 'open_chat_participants')).toBe(false)
  reopened.unmount()
})

test('latest 300 messages include new system notices and stable id order at equal timestamps', async () => {
  listedMessages = Array.from({ length: 302 }, (_, index) => ({ id: index + 1, room_id: 'room-1', sender_user_id: null, message_type: 'system', content: `참여자${index + 1}님이 입장했습니다.`, created_at: '2026-09-04T01:00:00Z' }))
  const screen = renderOpenChat()
  await openListedRoom(screen)
  await screen.findByText('참여자302님이 입장했습니다.')
  const list = screen.getByTestId('open-chat-room-keyboard-viewport').findByType(FlatList)
  expect(list.props.data).toHaveLength(300)
  expect(list.props.data[0].id).toBe(302)
  expect(list.props.data.at(-1).id).toBe(3)
  const query = from.mock.results.at(-1)!.value as { order: jest.Mock }
  expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false })
  expect(query.order).toHaveBeenCalledWith('id', { ascending: false })
  screen.unmount()
})

test('only explicit join and confirmed leave invoke membership RPCs; no local notice is fabricated', async () => {
  listedRooms = [{ ...room, is_member: false, owner_user_id: 'other-owner' }]
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const screen = renderOpenChat()
  try {
    fireEvent.press(await screen.findByText('테스트 방'))
    fireEvent.press(await screen.findByText('입장하기'))
    await screen.findByTestId('open-chat-room-keyboard-viewport')
    await screen.findByText('2명 · 방장 나')
    expect(rpc.mock.calls.filter(([name]) => name === 'join_open_chat_room')).toHaveLength(1)
    expect(screen.queryByText('나님이 입장했습니다.')).toBeNull()
    fireEvent.press(screen.getByText('☰'))
    fireEvent.press(screen.getByText('방 나가기'))
    expect(rpc.mock.calls.filter(([name]) => name === 'leave_open_chat_room')).toHaveLength(0)
    const confirmation = alert.mock.calls.find(([title]) => title === '방 나가기')![2]!.find(button => button.style === 'destructive')!
    await act(async () => { await confirmation.onPress?.() })
    expect(rpc.mock.calls.filter(([name]) => name === 'leave_open_chat_room')).toHaveLength(1)
  } finally { screen.unmount(); alert.mockRestore() }
})

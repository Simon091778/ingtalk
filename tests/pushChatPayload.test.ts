import { createChatPushMessage, getDisabledNotificationCategory, type PushRecord } from '../supabase/functions/push-chat-notification/payload'

const ios = { token: 'ExponentPushToken[test-ios]', platform: 'ios' as const }
const android = { token: 'ExponentPushToken[test-android]', platform: 'android' as const }
const record: PushRecord = {
  id: 1, user_id: 'recipient', title: '새 메시지', body: '안녕하세요!',
  data: { kind: 'message', room_id: 'room-a' },
}

it('keeps three iPhone messages as three payloads in one stack without replacing earlier alerts', () => {
  const messages = [1, 2, 3].map(id => createChatPushMessage(ios, { ...record, id, body: `메시지 ${id}` }, null))
  expect(messages.map(message => message.body)).toEqual(['메시지 1', '메시지 2', '메시지 3'])
  expect(new Set(messages.map(message => message.threadId))).toEqual(new Set(['ingtalk-chat-messages']))
  for (const message of messages) {
    expect(message).not.toHaveProperty('collapseId')
    expect(JSON.parse(JSON.stringify(message))).not.toHaveProperty('collapseId')
    expect(message.title).toBe('잉톡')
  }
})

it('groups different iPhone rooms together while preserving each notification destination', () => {
  const messages = ['room-a', 'room-b'].map(room_id => createChatPushMessage(ios, {
    ...record, data: { kind: 'message', room_id },
  }, null))
  expect(messages[0]?.threadId).toBe(messages[1]?.threadId)
  expect(messages.map(message => message.data.room_id)).toEqual(['room-a', 'room-b'])
})

it('retains Android routing, grouping, channel and message content', () => {
  expect(createChatPushMessage(android, record, null)).toEqual({
    to: android.token, sound: 'ingtalk_default_alarm.wav', channelId: 'messages-v3', title: '잉톡', body: '안녕하세요!',
    data: { kind: 'message', room_id: 'room-a' }, priority: 'high',
    collapseId: 'chat-room-a', threadId: 'chat-room-a',
  })
})

it.each([ios, android])('routes and groups open-chat messages independently on $platform', token => {
  const message = createChatPushMessage(token, {
    ...record,
    title: '저녁 수다방',
    body: '하늘: 반가워요!',
    data: { kind: 'open_chat_message', open_chat_room_id: 'open-room-a' },
  }, null)
  expect(message.title).toBe('수다방')
  expect(message.body).toBe('하늘: 반가워요!')
  expect(message.data).toEqual({ kind: 'open_chat_message', open_chat_room_id: 'open-room-a' })
  expect(message.threadId).toBe(token.platform === 'ios' ? 'ingtalk-open-chat-messages' : 'open-chat-open-room-a')
  if (token.platform === 'ios') expect(message).not.toHaveProperty('collapseId')
  else expect(message.collapseId).toBe('open-chat-open-room-a')
})

it.each([ios, android])('hides open-chat content when previews are disabled on $platform', token => {
  const message = createChatPushMessage(token, {
    ...record,
    body: '노출되면 안 되는 수다방 메시지',
    data: { kind: 'open_chat_message', open_chat_room_id: 'open-room-a' },
  }, { preview_enabled: false })
  expect(message.title).toBe('수다방')
  expect(message.body).toBe('수다방에 새 메시지가 도착했어요.')
  expect(JSON.stringify(message)).not.toContain('노출되면 안 되는 수다방 메시지')
})

it('disables only open-chat delivery when the separate room switch is off', () => {
  const openChatRecord = { ...record, data: { kind: 'open_chat_message', open_chat_room_id: 'open-room-a' } }
  const preferences = { message_enabled: true, open_chat_enabled: false, request_enabled: true }
  expect(getDisabledNotificationCategory(openChatRecord, preferences)).toBe('open_chat')
  expect(getDisabledNotificationCategory(record, preferences)).toBeNull()
  expect(getDisabledNotificationCategory({ ...record, data: { kind: 'chat_request' } }, preferences)).toBeNull()
})

it.each([ios, android])('respects disabled previews and sound on $platform', token => {
  const message = createChatPushMessage(token, record, { preview_enabled: false, sound_enabled: false, vibration_enabled: false })
  expect(message.title).toBe('잉톡')
  expect(message.body).toBe('새로운 메시지가 도착했어요.')
  expect(JSON.stringify(message)).not.toContain(record.body)
  expect(message.sound).toBeNull()
  expect(message.channelId).toBe('messages-silent')
})

it.each([ios, android])('leaves chat-request titles and grouping unchanged on $platform', token => {
  const message = createChatPushMessage(token, { ...record, data: { kind: 'chat_request', room_id: 'room-a' } }, null)
  expect(message.title).toBe('새 대화 신청')
  expect(message.body).toBe('새로운 대화 신청이 도착했어요.')
  expect(message.threadId).toBe('chat-requests')
  expect(message.collapseId).toBe('chat-requests')
})

it.each([
  [true, true, 'messages-v3'], [true, false, 'messages-sound-v3'],
  [false, true, 'messages-vibrate'], [false, false, 'messages-silent'],
] as const)('preserves the Android sound/vibration channel: %s/%s', (sound_enabled, vibration_enabled, channelId) => {
  expect(createChatPushMessage(android, record, { sound_enabled, vibration_enabled }).channelId).toBe(channelId)
})

it('uses platform-specific payloads when one user has both iPhone and Android tokens', () => {
  const [iphoneMessage, androidMessage] = [ios, android].map(token => createChatPushMessage(token, record, null))
  expect(iphoneMessage?.threadId).toBe('ingtalk-chat-messages')
  expect(iphoneMessage).not.toHaveProperty('collapseId')
  expect(androidMessage?.collapseId).toBe('chat-room-a')
})

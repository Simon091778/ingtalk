import { createClient } from 'jsr:@supabase/supabase-js@2'

type PushRecord = {
  id: number
  user_id: string
  title: string
  body: string
  data: Record<string, string | number>
}

type WebhookPayload = {
  type: 'INSERT'
  table: 'push_notifications'
  schema: 'public'
  record: PushRecord
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const webhookSecret = Deno.env.get('PUSH_WEBHOOK_SECRET')
  if (!webhookSecret || request.headers.get('x-webhook-secret') !== webhookSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = await request.json() as WebhookPayload
  if (payload.type !== 'INSERT' || payload.table !== 'push_notifications') {
    return Response.json({ skipped: true })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const [{ data: tokens, error }, { data: preferences }] = await Promise.all([
    supabase.from('push_tokens').select('token').eq('user_id', payload.record.user_id),
    supabase.from('notification_preferences').select('message_enabled, request_enabled, preview_enabled, sound_enabled, vibration_enabled').eq('user_id', payload.record.user_id).maybeSingle(),
  ])
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!tokens?.length) return Response.json({ sent: 0 })

  const kind = payload.record.data?.kind === 'chat_request' ? 'chat_request' : 'message'
  if (kind === 'message' && preferences?.message_enabled === false) return Response.json({ sent: 0, disabled: 'message' })
  if (kind === 'chat_request' && preferences?.request_enabled === false) return Response.json({ sent: 0, disabled: 'request' })
  const soundEnabled = preferences?.sound_enabled !== false
  const vibrationEnabled = preferences?.vibration_enabled !== false
  const previewEnabled = preferences?.preview_enabled !== false
  const channelId = soundEnabled ? (vibrationEnabled ? 'messages' : 'messages-sound') : (vibrationEnabled ? 'messages-vibrate' : 'messages-silent')
  const roomId = payload.record.data?.room_id
  const notificationGroup = kind === 'message' && roomId ? `chat-${roomId}` : 'chat-requests'
  const messages = tokens.map(({ token }) => ({
    to: token,
    sound: soundEnabled ? 'default' : null,
    channelId,
    title: kind === 'chat_request' ? '새 대화 신청' : '새 메시지',
    body: previewEnabled
      ? (kind === 'chat_request' ? '새로운 대화 신청이 도착했어요.' : payload.record.body)
      : (kind === 'chat_request' ? '새로운 대화 신청이 도착했어요.' : '새로운 메시지가 도착했어요.'),
    data: { kind, room_id: roomId },
    priority: 'high',
    collapseId: notificationGroup,
    threadId: notificationGroup,
  }))
  const expoAccessToken = Deno.env.get('EXPO_ACCESS_TOKEN')
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(expoAccessToken ? { Authorization: `Bearer ${expoAccessToken}` } : {}),
    },
    body: JSON.stringify(messages),
  })
  const result = await response.json()
  return Response.json(result, { status: response.status })
})

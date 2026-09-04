import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createChatPushMessage, getDisabledNotificationCategory, type PushRecord } from './payload.ts'

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
    supabase.rpc('active_account_push_tokens', { target_user: payload.record.user_id }),
    supabase.from('notification_preferences').select('message_enabled, open_chat_enabled, request_enabled, preview_enabled, sound_enabled, vibration_enabled').eq('user_id', payload.record.user_id).maybeSingle(),
  ])
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!tokens?.length) return Response.json({ sent: 0 })

  const disabled = getDisabledNotificationCategory(payload.record, preferences)
  if (disabled) return Response.json({ sent: 0, disabled })
  const messages = (tokens as Array<{ token: string; platform: 'android' | 'ios' }>).map(token => createChatPushMessage(token, payload.record, preferences))
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

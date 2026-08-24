import { createClient } from 'jsr:@supabase/supabase-js@2'

const headers = { 'Content-Type': 'application/json' }
const response = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers })
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RevenueCatEvent = {
  id?: string
  type?: string
  app_user_id?: string
  product_id?: string
  transaction_id?: string
  original_transaction_id?: string
  store?: string
  environment?: string
  purchased_at_ms?: number
  currency?: string
  country_code?: string
  price_in_purchased_currency?: number
}

Deno.serve(async request => {
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)
  const expectedAuthorization = Deno.env.get('REVENUECAT_WEBHOOK_AUTHORIZATION')
  if (!expectedAuthorization || request.headers.get('authorization') !== expectedAuthorization) {
    return response({ error: 'unauthorized' }, 401)
  }
  const url = Deno.env.get('SUPABASE_URL')
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !secret) return response({ error: 'server_not_configured' }, 500)

  const payload = await request.json().catch(() => null) as { event?: RevenueCatEvent } | null
  const event = payload?.event
  if (!event?.id || !event.type) return response({ error: 'invalid_event' }, 400)
  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } })

  try {
    if (event.type === 'NON_RENEWING_PURCHASE') {
      if (!event.app_user_id || !uuidPattern.test(event.app_user_id) || !event.product_id || !event.transaction_id) {
        return response({ error: 'invalid_purchase_event' }, 400)
      }
      const currency = event.currency?.trim().toUpperCase() ?? null
      const countryCode = event.country_code?.trim().toUpperCase() ?? null
      const purchasedAmount = typeof event.price_in_purchased_currency === 'number' && Number.isFinite(event.price_in_purchased_currency)
        ? event.price_in_purchased_currency
        : null
      if (currency && !/^[A-Z]{3}$/.test(currency)) return response({ error: 'invalid_purchase_currency' }, 400)
      if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) return response({ error: 'invalid_purchase_country' }, 400)
      if (purchasedAmount != null && purchasedAmount < 0) return response({ error: 'invalid_purchase_amount' }, 400)
      const { data, error } = await admin.rpc('credit_verified_point_purchase_v2', {
        event_identifier: event.id,
        transaction_identifier: event.transaction_id,
        target_user_id: event.app_user_id,
        purchased_product_id: event.product_id,
        purchase_store: event.store ?? 'UNKNOWN_STORE',
        purchase_environment: event.environment ?? 'PRODUCTION',
        purchased_at_ms: event.purchased_at_ms ?? null,
        purchased_currency: currency,
        purchased_amount: purchasedAmount,
        purchased_country_code: countryCode,
        event_payload: payload,
      })
      if (error) throw error
      return response({ processed: true, result: data?.[0] ?? null })
    }

    if (event.type === 'CANCELLATION' && (event.original_transaction_id || event.transaction_id)) {
      const { data, error } = await admin.rpc('refund_verified_point_purchase', {
        original_transaction_identifier: event.original_transaction_id ?? event.transaction_id,
        event_identifier: event.id,
        event_payload: payload,
      })
      if (error) throw error
      return response({ processed: true, result: data?.[0] ?? null })
    }
    return response({ processed: false, ignored: event.type })
  } catch (error) {
    console.error('revenuecat-webhook failed', { eventId: event.id, eventType: event.type, error })
    return response({ error: error instanceof Error ? error.message : 'purchase_processing_failed' }, 500)
  }
})

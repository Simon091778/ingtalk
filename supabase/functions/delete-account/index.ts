import { createClient } from 'jsr:@supabase/supabase-js@2'

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' }
const response = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers })

async function removeUserFolder(client: ReturnType<typeof createClient>, bucket: string, userId: string) {
  const { data, error } = await client.storage.from(bucket).list(userId, { limit: 1000 })
  if (error && !/not found/i.test(error.message)) throw error
  if (!data?.length) return 0
  const paths = data.filter(item => item.name && item.name !== '.emptyFolderPlaceholder').map(item => `${userId}/${item.name}`)
  if (!paths.length) return 0
  const { error: removeError } = await client.storage.from(bucket).remove(paths)
  if (removeError) throw removeError
  return paths.length
}

async function removeObjects(client: ReturnType<typeof createClient>, bucket: string, paths: string[]) {
  const uniquePaths = [...new Set(paths.filter(Boolean))]
  let removed = 0
  for (let index = 0; index < uniquePaths.length; index += 100) {
    const batch = uniquePaths.slice(index, index + 100)
    const { error } = await client.storage.from(bucket).remove(batch)
    if (error && !/not found/i.test(error.message)) throw error
    removed += batch.length
  }
  return removed
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return response({ error: 'authentication_required' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !secret) return response({ error: 'server_not_configured' }, 500)

  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } })
  const token = authorization.slice('Bearer '.length)
  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user) return response({ error: 'invalid_session' }, 401)

  const body = await request.json().catch(() => null) as { confirmation?: boolean } | null
  if (body?.confirmation !== true) return response({ error: 'confirmation_required' }, 400)

  try {
    const { data: memberships, error: membershipsError } = await admin
      .from('chat_members').select('room_id').eq('user_id', user.id)
    if (membershipsError) throw membershipsError
    const roomIds = (memberships ?? []).map(item => item.room_id as string)
    let chatImagePaths: string[] = []
    if (roomIds.length) {
      const { data: messages, error: messagesError } = await admin
        .from('messages').select('image_path').in('room_id', roomIds).not('image_path', 'is', null)
      if (messagesError) throw messagesError
      chatImagePaths = (messages ?? []).map(item => item.image_path as string).filter(Boolean)
    }

    const { data: deletion, error: dataError } = await admin.rpc('delete_account_data', { target_user_uuid: user.id })
    if (dataError) throw dataError
    const { error: authError } = await admin.auth.admin.deleteUser(user.id, false)
    if (authError) throw authError

    // Storage cleanup must not resurrect or block a successfully deleted account.
    // Log cleanup failures so orphaned objects can be retried operationally.
    const storageResults = await Promise.allSettled([
      removeUserFolder(admin, 'avatars', user.id),
      removeUserFolder(admin, 'board-images', user.id),
      removeObjects(admin, 'chat-images', chatImagePaths),
    ])
    const storageObjects = storageResults.reduce((total, result) =>
      total + (result.status === 'fulfilled' ? result.value : 0), 0)
    for (const result of storageResults) {
      if (result.status === 'rejected') console.error('delete-account storage cleanup failed', { userId: user.id, error: result.reason })
    }
    return response({ deleted: true, storage_objects: storageObjects, deletion })
  } catch (error) {
    console.error('delete-account failed', { userId: user.id, error })
    return response({ error: 'account_deletion_failed' }, 500)
  }
})

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { deletionOrder } from './identities.ts'

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' }
const response = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers })

async function removeUserFolder(client: SupabaseClient, bucket: string, userId: string) {
  const { data, error } = await client.storage.from(bucket).list(userId, { limit: 1000 })
  if (error && !/not found/i.test(error.message)) throw error
  if (!data?.length) return 0
  const paths = data.filter(item => item.name && item.name !== '.emptyFolderPlaceholder').map(item => `${userId}/${item.name}`)
  if (!paths.length) return 0
  const { error: removeError } = await client.storage.from(bucket).remove(paths)
  if (removeError) throw removeError
  return paths.length
}

async function removeObjects(client: SupabaseClient, bucket: string, paths: string[]) {
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

  // Auth.getUser alone accepts SMS-only sessions from a reassigned number.
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: accountId, error: accessError } = await caller.rpc('current_account_id')
  if (accessError) return response({ error: 'account_authorization_required' }, 403)

  const body = await request.json().catch(() => null) as { confirmation?: boolean } | null
  if (body?.confirmation !== true) return response({ error: 'confirmation_required' }, 400)

  try {
    async function deleteIdentities(ids: unknown) {
      for (const id of deletionOrder(ids, user!.id)) {
        const { error } = await admin.auth.admin.deleteUser(id, false)
        if (error && error.code !== 'user_not_found' && error.status !== 404) throw error
      }
    }
    if (!accountId) {
      // Only a service-created tombstone permits retrying the last identity delete.
      const { data: pending, error } = await admin.rpc('pending_account_identity_deletions', { identity_user: user.id })
      // Deploy this compatible Edge function before migration 103 enables linking.
      if (error?.code === 'PGRST202') {
        const legacy = await admin.rpc('pending_phone_identity_deletion', { identity_user: user.id })
        if (legacy.error || legacy.data !== true) return response({ error: 'account_authorization_required' }, 403)
        await deleteIdentities([user.id])
        return response({ deleted: true })
      }
      if (error || pending?.pending !== true) return response({ error: 'account_authorization_required' }, 403)
      await deleteIdentities(pending.identities)
      return response({ deleted: true })
    }
    const { data: memberships, error: membershipsError } = await admin
      .from('chat_members').select('room_id').eq('user_id', accountId)
    if (membershipsError) throw membershipsError
    const roomIds = (memberships ?? []).map(item => item.room_id as string)
    let chatImagePaths: string[] = []
    if (roomIds.length) {
      const { data: messages, error: messagesError } = await admin
        .from('messages').select('image_path').in('room_id', roomIds).not('image_path', 'is', null)
      if (messagesError) throw messagesError
      chatImagePaths = (messages ?? []).map(item => item.image_path as string).filter(Boolean)
    }
    const { data: openChatAttachments, error: openChatAttachmentsError } = await admin
      .from('open_chat_messages')
      .select('image_storage_path,audio_storage_path')
      .eq('sender_user_id', accountId)
    if (openChatAttachmentsError) throw openChatAttachmentsError
    const openChatImagePaths = (openChatAttachments ?? []).map(item => item.image_storage_path as string).filter(Boolean)
    const openChatAudioPaths = (openChatAttachments ?? []).map(item => item.audio_storage_path as string).filter(Boolean)
    const { data: ownedCoverRows, error: ownedCoverRowsError } = await admin
      .from('open_chat_rooms').select('cover_storage_path')
      .like('cover_storage_path', `%/${accountId}/%`)
    if (ownedCoverRowsError) throw ownedCoverRowsError
    const openChatCoverPaths = (ownedCoverRows ?? []).map(item => item.cover_storage_path as string).filter(Boolean)
    if (openChatCoverPaths.length) {
      const { error: clearCoverError } = await admin.from('open_chat_rooms')
        .update({ cover_storage_path: null, cover_width: null, cover_height: null })
        .in('cover_storage_path', openChatCoverPaths)
      if (clearCoverError) throw clearCoverError
    }

    const { data: deletion, error: dataError } = await admin.rpc('delete_device_account_data', { target_account: accountId, identity_user: user.id })
    if (dataError) throw dataError

    // Storage cleanup must not resurrect or block a successfully deleted account.
    // Log cleanup failures so orphaned objects can be retried operationally.
    const storageResults = await Promise.allSettled([
      removeUserFolder(admin, 'avatars', accountId),
      removeUserFolder(admin, 'board-images', accountId),
      removeObjects(admin, 'chat-images', chatImagePaths),
      removeObjects(admin, 'open-chat-images', openChatImagePaths),
      removeObjects(admin, 'open-chat-audio', openChatAudioPaths),
      removeObjects(admin, 'open-chat-covers', openChatCoverPaths),
    ])
    const storageObjects = storageResults.reduce((total, result) =>
      total + (result.status === 'fulfilled' ? result.value : 0), 0)
    for (const result of storageResults) {
      if (result.status === 'rejected') console.error('delete-account storage cleanup failed', { accountId, error: result.reason })
    }
    await deleteIdentities(deletion?.delete_auth_identities ?? (typeof deletion?.delete_auth_identity === 'boolean'
      ? (deletion.delete_auth_identity ? [user.id] : []) : undefined))
    // Transport UUIDs are private; do not expose the deletion job in the response.
    return response({ deleted: true, storage_objects: storageObjects })
  } catch (error) {
    console.error('delete-account failed', { userId: user.id, error })
    return response({ error: 'account_deletion_failed' }, 500)
  }
})

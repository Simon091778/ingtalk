import * as Crypto from 'expo-crypto'
import { captureAppError } from './observability'
import { supabase } from './supabase'

const OPEN_CHAT_COVER_BUCKET = 'open-chat-covers'
export const OPEN_CHAT_COVER_MAX_BYTES = 8 * 1024 * 1024

function imageExtension(mimeType?: string | null) {
  if (mimeType?.includes('png')) return 'png'
  if (mimeType?.includes('webp')) return 'webp'
  if (mimeType?.includes('heic')) return 'heic'
  if (mimeType?.includes('heif')) return 'heif'
  return 'jpg'
}

export async function uploadOpenChatCover(roomId: string, accountId: string, uri: string, mimeType?: string | null) {
  if (!supabase) throw new Error('Supabase가 연결되지 않았습니다.')
  const contentType = mimeType ?? 'image/jpeg'
  const path = `${roomId}/${accountId}/${Crypto.randomUUID()}.${imageExtension(contentType)}`
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > OPEN_CHAT_COVER_MAX_BYTES) throw new Error('대표사진은 8MB 이하만 등록할 수 있습니다.')
    const { error } = await supabase.storage.from(OPEN_CHAT_COVER_BUCKET).upload(path, bytes, { contentType, upsert: false })
    if (error) throw error
    return path
  } catch (reason) {
    captureAppError(reason, 'open_chat_cover', 'upload', { roomId, mimeType: contentType })
    throw reason
  }
}

export function getOpenChatCoverUrl(path?: string | null) {
  if (!supabase || !path) return null
  return supabase.storage.from(OPEN_CHAT_COVER_BUCKET).getPublicUrl(path).data.publicUrl
}

export async function removeOpenChatCover(path?: string | null) {
  if (!supabase || !path) return
  const { error } = await supabase.storage.from(OPEN_CHAT_COVER_BUCKET).remove([path])
  if (error) captureAppError(error, 'open_chat_cover', 'remove', { path })
}

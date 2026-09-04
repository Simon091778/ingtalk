import * as Crypto from 'expo-crypto'
import * as ImagePicker from 'expo-image-picker'
import { captureAppError } from './observability'
import { supabase } from './supabase'

const OPEN_CHAT_IMAGE_BUCKET = 'open-chat-images'
export const OPEN_CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

export async function pickOpenChatPhoto() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.78,
  })
  return result.canceled ? null : result.assets[0]
}

function imageExtension(mimeType?: string | null) {
  if (mimeType?.includes('png')) return 'png'
  if (mimeType?.includes('webp')) return 'webp'
  if (mimeType?.includes('heic')) return 'heic'
  if (mimeType?.includes('heif')) return 'heif'
  return 'jpg'
}

export async function uploadOpenChatPhoto(roomId: string, accountId: string, uri: string, mimeType?: string | null) {
  if (!supabase) throw new Error('Supabase가 연결되지 않았습니다.')
  const contentType = mimeType ?? 'image/jpeg'
  const path = `${roomId}/${accountId}/${Crypto.randomUUID()}.${imageExtension(contentType)}`
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > OPEN_CHAT_IMAGE_MAX_BYTES) throw new Error('사진은 8MB 이하만 전송할 수 있습니다.')
    const { error } = await supabase.storage.from(OPEN_CHAT_IMAGE_BUCKET).upload(path, bytes, {
      contentType,
      upsert: false,
    })
    if (error) throw error
    return path
  } catch (reason) {
    captureAppError(reason, 'open_chat_photo', 'upload', { roomId, mimeType: contentType })
    throw reason
  }
}

export async function createOpenChatPhotoUrl(path: string) {
  const cached = signedUrlCache.get(path)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  if (!supabase) return null
  const { data, error } = await supabase.storage.from(OPEN_CHAT_IMAGE_BUCKET).createSignedUrl(path, 15 * 60)
  if (error) {
    captureAppError(error, 'open_chat_photo', 'sign_url', { path })
    return null
  }
  signedUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + 14 * 60 * 1000 })
  return data.signedUrl
}

export async function removeUnsentOpenChatPhoto(path: string) {
  if (!supabase) return
  signedUrlCache.delete(path)
  const { error } = await supabase.storage.from(OPEN_CHAT_IMAGE_BUCKET).remove([path])
  if (error) captureAppError(error, 'open_chat_photo', 'remove_orphan', { path })
}

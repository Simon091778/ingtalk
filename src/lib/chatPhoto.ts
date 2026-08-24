import * as ImagePicker from 'expo-image-picker'
import { captureAppError } from './observability'
import { supabase } from './supabase'

const CHAT_IMAGE_BUCKET = 'chat-images'
export const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024

export async function pickChatPhoto() {
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

export async function uploadChatPhoto(roomId: string, userId: string, uri: string, mimeType?: string | null) {
  if (!supabase) throw new Error('Supabase가 연결되지 않았습니다.')
  const contentType = mimeType ?? 'image/jpeg'
  const path = `${roomId}/${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${imageExtension(contentType)}`
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > CHAT_IMAGE_MAX_BYTES) throw new Error('사진은 8MB 이하만 전송할 수 있습니다.')
    const { error } = await supabase.storage.from(CHAT_IMAGE_BUCKET).upload(path, bytes, { contentType })
    if (error) throw error
    return path
  } catch (reason) {
    captureAppError(reason, 'chat_photo', 'upload', { roomId, mimeType: contentType })
    throw reason
  }
}

export async function createChatPhotoUrl(path: string) {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from(CHAT_IMAGE_BUCKET).createSignedUrl(path, 60 * 60)
  if (error) {
    captureAppError(error, 'chat_photo', 'sign_url', { path })
    return null
  }
  return data.signedUrl
}

export async function removeChatPhoto(path: string) {
  if (!supabase) return
  const { error } = await supabase.storage.from(CHAT_IMAGE_BUCKET).remove([path])
  if (error) captureAppError(error, 'chat_photo', 'remove_orphan', { path })
}

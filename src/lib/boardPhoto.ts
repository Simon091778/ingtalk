import * as ImagePicker from 'expo-image-picker'
import { supabase } from './supabase'
import { captureAppError } from './observability'

export class BoardPhotoPermissionError extends Error {
  constructor(public canAskAgain: boolean) {
    super('사진 보관함 권한이 필요합니다.')
    this.name = 'BoardPhotoPermissionError'
  }
}

export async function pickBoardPhoto() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    quality: 0.75,
  })
  return result.canceled ? null : result.assets[0]
}

export async function uploadBoardPhoto(userId: string, uri: string, mimeType?: string | null) {
  if (!supabase) return uri
  const contentType = mimeType ?? 'image/jpeg'
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
    const { error } = await supabase.storage.from('board-images').upload(path, bytes, { contentType })
    if (error) throw error
    return supabase.storage.from('board-images').getPublicUrl(path).data.publicUrl
  } catch (reason) {
    captureAppError(reason, 'board_photo', 'upload', { mimeType: contentType })
    throw reason
  }
}

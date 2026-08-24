import * as ImagePicker from 'expo-image-picker'
import { Platform } from 'react-native'
import { supabase } from './supabase'
import { captureAppError } from './observability'

export class ProfilePhotoPermissionError extends Error {
  constructor(public canAskAgain: boolean) {
    super('사진 보관함 권한이 필요합니다.')
    this.name = 'ProfilePhotoPermissionError'
  }
}

export async function pickProfilePhoto() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    // Android's native editor uses an ambiguous crop icon as its confirm
    // action on many devices. Skip that extra screen and crop visually in
    // the circular profile image instead. Keep the familiar iOS editor.
    allowsEditing: Platform.OS === 'ios',
    ...(Platform.OS === 'ios' ? { aspect: [1, 1] as [number, number] } : {}),
    quality: 0.75,
  })
  return result.canceled ? null : result.assets[0]
}

export async function uploadProfilePhoto(userId: string, uri: string, mimeType?: string | null) {
  if (!supabase) return uri
  const contentType = mimeType ?? 'image/jpeg'
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    const path = `${userId}/profile.${extension}`
    const { error } = await supabase.storage.from('avatars').upload(path, bytes, { contentType, upsert: true })
    if (error) throw error
    const { data } = supabase.storage.from('avatars').getPublicUrl(path)
    return `${data.publicUrl}?v=${Date.now()}`
  } catch (reason) {
    captureAppError(reason, 'profile_photo', 'upload', { mimeType: contentType })
    throw reason
  }
}

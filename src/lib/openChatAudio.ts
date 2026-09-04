import * as Crypto from 'expo-crypto'
import { captureAppError } from './observability'
import { supabase } from './supabase'
import { logOpenChatDiagnostic } from './openChatDiagnostics'

const OPEN_CHAT_AUDIO_BUCKET = 'open-chat-audio'
export const OPEN_CHAT_AUDIO_MAX_BYTES = 1024 * 1024
export const OPEN_CHAT_AUDIO_MAX_DURATION_MS = 30_000

export async function uploadOpenChatAudio(roomId: string, accountId: string, uri: string) {
  if (!supabase) throw new Error('Supabase가 연결되지 않았습니다.')
  const path = `${roomId}/${accountId}/${Crypto.randomUUID()}.m4a`
  logOpenChatDiagnostic('OPEN_CHAT_UPLOAD_START')
  try {
    const response = await fetch(uri)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > OPEN_CHAT_AUDIO_MAX_BYTES) {
      throw new Error('음성 메시지 파일이 허용 크기를 초과했습니다.')
    }
    const { error } = await supabase.storage.from(OPEN_CHAT_AUDIO_BUCKET).upload(path, bytes, {
      contentType: 'audio/mp4',
      upsert: false,
    })
    if (error) throw error
    logOpenChatDiagnostic('OPEN_CHAT_UPLOAD_SUCCESS', { bytes: bytes.byteLength })
    return path
  } catch (reason) {
    logOpenChatDiagnostic('OPEN_CHAT_UPLOAD_FAILURE')
    captureAppError(reason, 'open_chat_audio', 'upload', { roomId })
    throw reason
  }
}

export async function createOpenChatAudioUrl(path: string) {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from(OPEN_CHAT_AUDIO_BUCKET).createSignedUrl(path, 15 * 60)
  if (error) {
    captureAppError(error, 'open_chat_audio', 'sign_url', { path })
    return null
  }
  return data.signedUrl
}

export async function removeUnsentOpenChatAudio(path: string) {
  if (!supabase) return
  const { error } = await supabase.storage.from(OPEN_CHAT_AUDIO_BUCKET).remove([path])
  if (error) captureAppError(error, 'open_chat_audio', 'remove_orphan', { path })
}

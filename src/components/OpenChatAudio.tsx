import { useEffect, useRef, useState } from 'react'
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native'
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio'
import { Text } from '../i18n/localizedUi'
import { createOpenChatAudioUrl, OPEN_CHAT_AUDIO_MAX_DURATION_MS } from '../lib/openChatAudio'
import { logOpenChatDiagnostic } from '../lib/openChatDiagnostics'

function secondsLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.min(30, Math.ceil(milliseconds / 1000)))
  return `0:${String(seconds).padStart(2, '0')}`
}

export function OpenChatAudioMessage({
  messageId,
  path,
  durationMs,
  mine,
  blocked,
  activeMessageId,
  onActiveMessageChange,
}: {
  messageId: number
  path: string
  durationMs: number
  mine: boolean
  blocked: boolean
  activeMessageId: number | null
  onActiveMessageChange: (messageId: number | null) => void
}) {
  const player = useAudioPlayer(null, { updateInterval: 250 })
  const status = useAudioPlayerStatus(player)
  const [loading, setLoading] = useState(false)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [playRequested, setPlayRequested] = useState(false)
  const reusedSignedUrlRef = useRef(false)
  const signedAt = useRef(0)
  const active = activeMessageId === messageId

  useEffect(() => {
    if (!active) {
      if (status.playing) player.pause()
      return
    }
    if (playRequested) {
      player.play()
      setPlayRequested(false)
      logOpenChatDiagnostic('OPEN_CHAT_AUDIO_PLAY_START', { durationMs, reusedSignedUrl: reusedSignedUrlRef.current })
    }
  }, [active, durationMs, playRequested, player, status.playing])

  useEffect(() => {
    if (status.didJustFinish && active) {
      logOpenChatDiagnostic('OPEN_CHAT_AUDIO_PLAY_END', { durationMs })
      void player.seekTo(0)
      onActiveMessageChange(null)
    }
  }, [active, onActiveMessageChange, player, status.didJustFinish])

  const toggle = async () => {
    if (blocked || loading) return
    if (active && status.playing) {
      player.pause()
      onActiveMessageChange(null)
      return
    }
    setLoading(true)
    try {
      let url = signedUrl
      reusedSignedUrlRef.current = Boolean(url && Date.now() - signedAt.current <= 14 * 60 * 1000)
      if (!url || Date.now() - signedAt.current > 14 * 60 * 1000) {
        url = await createOpenChatAudioUrl(path)
        if (!url) throw new Error('audio_url_failed')
        setSignedUrl(url)
        signedAt.current = Date.now()
        player.replace(url)
      }
      onActiveMessageChange(messageId)
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) await player.seekTo(0)
      setPlayRequested(true)
    } catch {
      logOpenChatDiagnostic('OPEN_CHAT_AUDIO_PLAY_FAILURE')
      Alert.alert('음성을 재생하지 못했습니다', '방 참여 상태와 네트워크를 확인해 주세요.')
      onActiveMessageChange(null)
    } finally {
      setLoading(false)
    }
  }

  const elapsed = status.isLoaded && active ? status.currentTime * 1000 : 0
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={status.playing && active ? '음성 메시지 일시정지' : '음성 메시지 재생'}
    disabled={blocked}
    onPress={() => void toggle()}
    style={styles.audioRow}
  >
    <Text style={[styles.play, mine && styles.mineText]}>{loading ? '…' : status.playing && active ? 'Ⅱ' : '▶'}</Text>
    <View style={[styles.progressTrack, mine && styles.mineTrack]}>
      <View style={[styles.progress, mine && styles.mineProgress, { width: `${Math.min(100, (elapsed / Math.max(1, durationMs)) * 100)}%` }]} />
    </View>
    <Text style={[styles.duration, mine && styles.mineText]}>{secondsLabel(active ? Math.max(0, durationMs - elapsed) : durationMs)}</Text>
  </Pressable>
}

export function OpenChatVoiceRecorder({
  disabled,
  onSend,
  registerStop,
  onExpandedChange,
}: {
  disabled: boolean
  onSend: (uri: string, durationMs: number) => Promise<void>
  registerStop: (handler: () => Promise<void>) => void
  onExpandedChange: (expanded: boolean) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'ready' | 'uploading'>('idle')
  const [readyUri, setReadyUri] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState(0)
  const phaseRef = useRef(phase)
  const mountedRef = useRef(true)
  const discardPromiseRef = useRef<Promise<void> | null>(null)
  const stopReasonRef = useRef<'automatic' | 'manual' | 'cancel' | 'background' | 'access_lost' | 'unmount'>('automatic')
  phaseRef.current = phase
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, status => {
    if (mountedRef.current && status.isFinished && status.url && phaseRef.current === 'recording') {
      if (stopReasonRef.current === 'automatic') {
        logOpenChatDiagnostic('OPEN_CHAT_RECORD_STOP', { reason: 'duration_limit' })
      }
      setReadyUri(status.url)
      setPhase('ready')
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
    }
  })
  const recorderState = useAudioRecorderState(recorder, 100)

  useEffect(() => {
    if (phase === 'recording') setDurationMs(Math.min(OPEN_CHAT_AUDIO_MAX_DURATION_MS, recorderState.durationMillis))
  }, [phase, recorderState.durationMillis])

  useEffect(() => { onExpandedChange(phase !== 'idle') }, [onExpandedChange, phase])

  const stopAndDiscard = (reason: 'cancel' | 'background' | 'access_lost' | 'unmount' = 'cancel') => {
    if (discardPromiseRef.current) return discardPromiseRef.current
    const discard = (async () => {
      const recording = recorder.isRecording
      const hadRecording = recording || phaseRef.current !== 'idle'
      stopReasonRef.current = reason
      if (recording) {
        try { await recorder.stop() } catch { /* already stopped by the native duration cap */ }
      }
      if (mountedRef.current) {
        phaseRef.current = 'idle'
        setReadyUri(null)
        setDurationMs(0)
        setPhase('idle')
      }
      if (hadRecording) logOpenChatDiagnostic('OPEN_CHAT_RECORD_CANCEL', { reason })
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined)
    })()
    discardPromiseRef.current = discard
    void discard.finally(() => {
      if (discardPromiseRef.current === discard) discardPromiseRef.current = null
    })
    return discard
  }
  const stopAndDiscardRef = useRef(stopAndDiscard)
  stopAndDiscardRef.current = stopAndDiscard

  useEffect(() => {
    registerStop(() => stopAndDiscardRef.current('access_lost'))
    return () => { registerStop(async () => undefined) }
  }, [registerStop])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && phaseRef.current === 'recording') void stopAndDiscardRef.current('background')
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // useAudioRecorder owns and releases its native recorder during unmount.
      // Accessing recorder.isRecording/stop here races that release on Android.
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined)
    }
  }, [])

  const start = async () => {
    if (disabled || phase !== 'idle') return
    const permission = await AudioModule.requestRecordingPermissionsAsync()
    if (!permission.granted) {
      Alert.alert('마이크 권한이 필요합니다', '설정에서 Ingtalk의 마이크 권한을 허용해 주세요.')
      return
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record({ forDuration: 30 })
      stopReasonRef.current = 'automatic'
      setDurationMs(0)
      setReadyUri(null)
      setPhase('recording')
      logOpenChatDiagnostic('OPEN_CHAT_RECORD_START')
    } catch {
      await stopAndDiscard()
      Alert.alert('녹음을 시작하지 못했습니다', '다른 앱이 마이크를 사용 중인지 확인해 주세요.')
    }
  }

  const stop = async () => {
    if (phase !== 'recording') return
    try {
      stopReasonRef.current = 'manual'
      await recorder.stop()
      const uri = recorder.uri
      if (!uri) throw new Error('recording_uri_missing')
      setReadyUri(uri)
      setDurationMs(Math.max(1, Math.min(OPEN_CHAT_AUDIO_MAX_DURATION_MS, recorderState.durationMillis)))
      setPhase('ready')
      logOpenChatDiagnostic('OPEN_CHAT_RECORD_STOP', { reason: 'manual', durationMs: Math.max(1, Math.min(OPEN_CHAT_AUDIO_MAX_DURATION_MS, recorderState.durationMillis)) })
    } catch {
      await stopAndDiscard()
      Alert.alert('녹음을 저장하지 못했습니다', '다시 녹음해 주세요.')
    } finally {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined)
    }
  }

  const send = async () => {
    if (!readyUri || phase !== 'ready') return
    setPhase('uploading')
    try {
      await onSend(readyUri, Math.max(1, Math.min(OPEN_CHAT_AUDIO_MAX_DURATION_MS, durationMs)))
      setReadyUri(null)
      setDurationMs(0)
      setPhase('idle')
    } catch {
      setPhase('ready')
    }
  }

  if (phase === 'idle') return <Pressable
    accessibilityRole="button"
    accessibilityLabel="음성 메시지 녹음"
    disabled={disabled}
    onPress={() => void start()}
    style={[styles.micButton, disabled && styles.disabled]}
  ><Text style={styles.mic}>●</Text></Pressable>

  if (phase === 'recording') return <View style={styles.recordingControls}>
    <Text style={styles.recordingTime}>● {secondsLabel(recorderState.durationMillis)} / 0:30</Text>
    <Pressable onPress={() => void stop()} style={styles.stopButton}><Text style={styles.stopText}>■</Text></Pressable>
  </View>

  return <View style={styles.recordingControls}>
    <Pressable disabled={phase === 'uploading'} onPress={() => void stopAndDiscard('cancel')}><Text style={styles.cancel}>취소</Text></Pressable>
    <Text style={styles.readyTime}>{secondsLabel(durationMs)}</Text>
    <Pressable disabled={phase === 'uploading'} onPress={() => void send()} style={styles.voiceSend}>
      <Text style={styles.voiceSendText}>{phase === 'uploading' ? '전송 중' : '음성 전송'}</Text>
    </Pressable>
  </View>
}

const styles = StyleSheet.create({
  audioRow: { minWidth: 190, flexDirection: 'row', alignItems: 'center', gap: 9 },
  play: { color: '#F26B4B', fontWeight: '900', width: 18, textAlign: 'center' },
  progressTrack: { flex: 1, height: 3, borderRadius: 2, backgroundColor: '#E7DCD7', overflow: 'hidden' },
  progress: { height: 3, backgroundColor: '#F26B4B' },
  mineTrack: { backgroundColor: 'rgba(255,255,255,0.38)' },
  mineProgress: { backgroundColor: 'white' },
  duration: { minWidth: 32, color: '#756B67', fontSize: 11 },
  mineText: { color: 'white' },
  micButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#F0EAE6', alignItems: 'center', justifyContent: 'center' },
  mic: { color: '#F26B4B', fontSize: 15 },
  disabled: { opacity: 0.45 },
  recordingControls: { flex: 1, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  recordingTime: { color: '#D64D45', fontWeight: '800' },
  stopButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' },
  stopText: { color: 'white' },
  cancel: { color: '#756B67', fontWeight: '800' },
  readyTime: { color: '#645853', fontWeight: '800' },
  voiceSend: { minHeight: 38, paddingHorizontal: 13, borderRadius: 19, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' },
  voiceSendText: { color: 'white', fontWeight: '900', fontSize: 12 },
})

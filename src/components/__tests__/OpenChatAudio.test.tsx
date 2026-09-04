import { render } from '@testing-library/react-native'
import { OpenChatVoiceRecorder } from '../OpenChatAudio'

let mockIsRecordingReads = 0
const mockStop = jest.fn().mockResolvedValue(undefined)
const mockRecorder = {
  get isRecording() {
    mockIsRecordingReads += 1
    return false
  },
  stop: mockStop,
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  record: jest.fn(),
  uri: null,
}

jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  useAudioPlayer: jest.fn(() => ({ pause: jest.fn(), play: jest.fn(), replace: jest.fn(), seekTo: jest.fn() })),
  useAudioPlayerStatus: jest.fn(() => ({ playing: false, didJustFinish: false, isLoaded: false, duration: 0, currentTime: 0 })),
  useAudioRecorder: jest.fn(() => mockRecorder),
  useAudioRecorderState: jest.fn(() => ({ durationMillis: 0 })),
}))
jest.mock('../../lib/openChatAudio', () => ({
  createOpenChatAudioUrl: jest.fn(),
  OPEN_CHAT_AUDIO_MAX_DURATION_MS: 30_000,
}))
jest.mock('../../lib/openChatDiagnostics', () => ({ logOpenChatDiagnostic: jest.fn() }))

test('unmount does not access a recorder owned and released by the Expo hook', () => {
  let registeredStop: (() => Promise<void>) | null = null
  const screen = render(<OpenChatVoiceRecorder
    disabled={false}
    onSend={jest.fn().mockResolvedValue(undefined)}
    registerStop={handler => { registeredStop = handler }}
    onExpandedChange={jest.fn()}
  />)
  expect(registeredStop).not.toBeNull()
  mockIsRecordingReads = 0
  screen.unmount()
  expect(mockIsRecordingReads).toBe(0)
  expect(mockStop).not.toHaveBeenCalled()
})

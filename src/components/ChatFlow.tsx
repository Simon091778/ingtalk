import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, AppState, Dimensions, FlatList, Image, InteractionManager, Keyboard, KeyboardAvoidingView, Modal, Platform,
  Pressable, SafeAreaView, ScrollView, StyleSheet, useWindowDimensions, View,
} from 'react-native'
import { Text, TextInput } from '../i18n/localizedUi'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ImagePickerAsset } from 'expo-image-picker'
import { supabase } from '../lib/supabase'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { CHAT_IMAGE_MAX_BYTES, createChatPhotoUrl, pickChatPhoto, removeChatPhoto, uploadChatPhoto } from '../lib/chatPhoto'
import { elapsedFromIso, formatDistanceMeters } from '../lib/displayFormat'
import { SwipeDismissView } from './SwipeDismissView'
import type { TalkCard } from '../types'
import { formatDate, formatTime, useI18n } from '../i18n'
import { boardAliasDisplayName } from '../lib/boardAlias'

type RequestItem = {
  request_id: string
  direction: 'sent' | 'received'
  request_status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  opening_message: string
  card_topic: string
  other_user_id: string
  other_nickname: string | null
  other_gender: string | null
  other_birth_year: number | null
  other_avatar_url: string | null
  distance_meters: number | null
  board_alias: string | null
  room_id: string | null
  created_at: string
}

type RoomItem = {
  room_id: string
  other_user_id: string
  other_nickname: string
  other_board_alias: string | null
  other_avatar_url: string | null
  other_gender: string | null
  other_birth_year: number
  last_message: string | null
  last_message_at: string
  unread_count: number
  distance_meters: number | null
}

type MessageItem = {
  id: number
  room_id: string
  sender_id: string
  body: string
  image_path: string | null
  image_width: number | null
  image_height: number | null
  image_url?: string | null
  created_at: string
}

async function withChatPhotoUrl(message: MessageItem) {
  if (!message.image_path) return message
  return { ...message, image_url: await createChatPhotoUrl(message.image_path) }
}

const chatReportReasons = [
  { code: 'sexual', label: '음란물·성적 콘텐츠' },
  { code: 'illegal_meeting', label: '불법 만남·성매매 유도' },
  { code: 'harassment', label: '욕설·괴롭힘' },
  { code: 'fraud', label: '사기·금전 요구' },
  { code: 'spam', label: '광고·도배' },
  { code: 'privacy', label: '개인정보 노출' },
  { code: 'suspected_minor', label: '미성년자 의심' },
  { code: 'illegal_image', label: '불법 촬영물 의심' },
  { code: 'other', label: '기타' },
] as const

function ChatProfilePhotoViewer({ visible, uri, nickname, onClose, embedded = false }: { visible: boolean; uri: string | null; nickname: string; onClose: () => void; embedded?: boolean }) {
  const { height: screenHeight } = useWindowDimensions()
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const translateX = useSharedValue(0)
  const translateY = useSharedValue(0)
  const savedTranslateX = useSharedValue(0)
  const savedTranslateY = useSharedValue(0)
  const dismissTranslateY = useSharedValue(0)
  const dismissing = useSharedValue(false)

  useEffect(() => {
    if (!visible) return
    scale.value = 1
    savedScale.value = 1
    translateX.value = 0
    translateY.value = 0
    savedTranslateX.value = 0
    savedTranslateY.value = 0
    dismissTranslateY.value = 0
    dismissing.value = false
  }, [visible, uri])

  const pinch = Gesture.Pinch()
    .onUpdate(event => { scale.value = Math.min(4, Math.max(1, savedScale.value * event.scale)) })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= 1.01) {
        scale.value = withTiming(1)
        savedScale.value = 1
        translateX.value = withTiming(0)
        translateY.value = withTiming(0)
        savedTranslateX.value = 0
        savedTranslateY.value = 0
      }
    })
  const pan = Gesture.Pan().maxPointers(1)
    .onUpdate(event => {
      if (scale.value <= 1) return
      const limit = (scale.value - 1) * 180
      translateX.value = Math.min(limit, Math.max(-limit, savedTranslateX.value + event.translationX))
      translateY.value = Math.min(limit, Math.max(-limit, savedTranslateY.value + event.translationY))
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value
      savedTranslateY.value = translateY.value
    })
  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDuration(250).onEnd(() => {
    const zoomed = scale.value > 1.05
    scale.value = withTiming(zoomed ? 1 : 2.5)
    savedScale.value = zoomed ? 1 : 2.5
    if (zoomed) {
      translateX.value = withTiming(0)
      translateY.value = withTiming(0)
      savedTranslateX.value = 0
      savedTranslateY.value = 0
    }
  })
  const dismiss = Gesture.Pan().minDistance(12)
    .onUpdate(event => {
      if (scale.value > 1.01 || event.translationX < 0 || event.translationY < 0) return
      const movingRight = Math.abs(event.translationX) > Math.abs(event.translationY)
      dismissTranslateY.value = movingRight ? event.translationX * 0.28 : event.translationY
    })
    .onEnd(event => {
      if (scale.value > 1.01) return
      const swipedRight = event.translationX > 95 && Math.abs(event.translationX) > Math.abs(event.translationY)
      const swipedDown = event.translationY > 95 && Math.abs(event.translationY) >= Math.abs(event.translationX)
      if (swipedRight || swipedDown || event.velocityX > 800 || event.velocityY > 800) {
        dismissing.value = true
        dismissTranslateY.value = withTiming(screenHeight + 40, { duration: 230 }, finished => {
          if (finished) runOnJS(onClose)()
        })
      } else dismissTranslateY.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!dismissing.value) dismissTranslateY.value = withTiming(0, { duration: 180 })
    })
  const gestures = Gesture.Simultaneous(pinch, pan, doubleTap, dismiss)
  const imageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }] }))
  const viewerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dismissTranslateY.value }] }))

  if (!uri || !visible) return null
  const viewer = <Animated.View style={[styles.photoViewerOverlay, embedded && styles.photoViewerEmbedded, viewerStyle]}>
    <SafeAreaView style={styles.flex}>
      <View style={styles.photoViewerHeader}><View style={styles.photoViewerHeading}><Text numberOfLines={1} style={styles.photoViewerName}>{nickname}</Text><Text style={styles.photoViewerHint}>두 손가락으로 확대 · 한 손가락으로 이동 · 두 번 탭으로 초기화</Text></View><Pressable accessibilityRole="button" accessibilityLabel="프로필 사진 닫기" hitSlop={8} onPress={onClose} style={styles.photoViewerClose}><Text style={styles.photoViewerCloseText}>닫기</Text></Pressable></View>
      <GestureDetector gesture={gestures}><Animated.View style={styles.photoViewerArea}><Animated.Image source={{ uri }} resizeMode="contain" style={[styles.photoViewerImage, imageStyle]} /></Animated.View></GestureDetector>
    </SafeAreaView>
  </Animated.View>
  if (embedded) return viewer
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.flex}>
      {viewer}
    </GestureHandlerRootView>
  </Modal>
}

function roomElapsed(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
  if (minutes < 60) return `${minutes}분전`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간전`
  return `${Math.floor(minutes / 1440)}일전`
}

function roomGenderAge(gender: string | null, birthYear: number) {
  const age = new Date().getFullYear() - Number(birthYear)
  const prefix = gender === 'male' ? '남' : gender === 'female' ? '여' : gender === 'other' ? '기타' : ''
  return `(${prefix}${age}세)`
}

function requestGenderAge(gender: string | null, birthYear: number | null) {
  if (!birthYear) return ''
  const age = new Date().getFullYear() - Number(birthYear)
  if (!Number.isFinite(age) || age < 18) return ''
  const prefix = gender === 'male' ? '남' : gender === 'female' ? '여' : gender === 'other' ? '기타' : ''
  return prefix ? ` (${prefix}${age}세)` : ` (${age}세)`
}

function RequestSummary({ item, statusText }: { item: RequestItem; statusText: string }) {
  const i18n = useI18n()
  const displayName = item.board_alias ? boardAliasDisplayName(item.board_alias, i18n.language) : item.other_nickname ?? '익명 이용자'
  const isAnonymousBoardRequest = Boolean(item.board_alias)
  return <View style={styles.requestSummary}>
    <Text numberOfLines={1} style={styles.requestSummaryLine}>
      <Text style={[styles.requestName, item.other_gender === 'male' && styles.roomMale, item.other_gender === 'female' && styles.roomFemale]}>{displayName}{isAnonymousBoardRequest ? '' : requestGenderAge(item.other_gender, item.other_birth_year)}</Text>
      <Text style={styles.requestMeta}> · {isAnonymousBoardRequest ? elapsedFromIso(item.created_at) : `${formatDistanceMeters(item.distance_meters)} · ${elapsedFromIso(item.created_at)}`}</Text>
    </Text>
    {item.board_alias && <Text style={styles.requestAliasLabel}>익명게시판 닉네임</Text>}
    <Text style={[styles.status, styles.requestStatusBelow, item.request_status === 'accepted' && styles.statusAccepted]}>{statusText}</Text>
  </View>
}

function errorMessage(reason: unknown) {
  return typeof reason === 'object' && reason !== null && 'message' in reason
    ? String(reason.message)
    : '요청을 처리하지 못했습니다.'
}

function requestErrorMessage(message: string) {
  if (message.includes('request_already_exists')) return '이미 이 카드에 대화를 신청했어요.'
  if (message.includes('insufficient_points')) return '포인트가 부족해요. 대화를 신청하려면 100P가 필요합니다.'
  if (message.includes('card_not_available')) return '만료되었거나 사용할 수 없는 대화 카드예요.'
  if (message.includes('users_blocked')) return '차단 관계에서는 대화를 신청할 수 없어요.'
  if (message.includes('function') || message.includes('schema cache')) return '채팅 기능 SQL 마이그레이션을 Supabase에 적용해 주세요.'
  return message
}

export function RequestComposer({ card, onClose, onSent }: { card: TalkCard | null; onClose: () => void; onSent: () => void }) {
  const insets = useSafeAreaInsets()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const [closingRight, setClosingRight] = useState(false)
  const [profilePhotoVisible, setProfilePhotoVisible] = useState(false)
  const inputRef = useRef<TextInput>(null)
  const focusTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const requestDismissingDown = useSharedValue(false)
  const requestDismissingRight = useSharedValue(false)
  const requestTranslateX = useSharedValue(0)
  const requestTranslateY = useSharedValue(0)

  const clearFocusTimers = () => {
    focusTimersRef.current.forEach(clearTimeout)
    focusTimersRef.current = []
  }

  useEffect(() => {
    setMessage('')
    if (card) {
      setClosingRight(false)
      setProfilePhotoVisible(false)
      requestDismissingDown.value = false
      requestDismissingRight.value = false
      requestTranslateX.value = 0
      requestTranslateY.value = 0
    }
    if (card && Platform.OS === 'android') focusMessageInput()
  }, [card?.id])
  useEffect(() => () => {
    clearFocusTimers()
  }, [])
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const shown = Keyboard.addListener(showEvent, event => {
      setKeyboardHeight(event.endCoordinates.height)
      if (Platform.OS === 'android') clearFocusTimers()
    })
    const hidden = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0))
    return () => { shown.remove(); hidden.remove() }
  }, [])

  const focusMessageInput = () => {
    clearFocusTimers()
    if (Platform.OS !== 'android') {
      inputRef.current?.focus()
      return
    }

    // Some Android devices ignore a focus request until the slide transition and
    // native window attachment have both completed. Reset focus once, then retry.
    InteractionManager.runAfterInteractions(() => {
      ;[120, 520, 900].forEach(delay => {
        focusTimersRef.current.push(setTimeout(() => {
          inputRef.current?.blur()
          focusTimersRef.current.push(setTimeout(() => inputRef.current?.focus(), 60))
        }, delay))
      })
    })
  }

  const requestButton = () => <Pressable disabled={!message.trim() || submitting} onPress={submit} style={[styles.primaryButton, styles.requestFooterButton, (!message.trim() || submitting) && styles.disabled]}><Text style={styles.primaryButtonText}>{submitting ? '요청 중…' : '대화 요청하기 · 100P'}</Text></Pressable>

  const closeRequestComposer = () => {
    Keyboard.dismiss()
    requestDismissingDown.value = false
    requestDismissingRight.value = false
    requestTranslateX.value = 0
    requestTranslateY.value = 0
    onClose()
  }

  const finishRightDismiss = () => {
    Keyboard.dismiss()
    onClose()
  }

  const beginRightDismiss = () => setClosingRight(true)

  const dismissDownGesture = Gesture.Pan()
    .activeOffsetY(18)
    .failOffsetX([-24, 24])
    .onUpdate(event => {
      if (event.translationY > 0) requestTranslateY.value = event.translationY
    })
    .onEnd(event => {
      if (event.translationY > 110 || event.velocityY > 850) {
        requestDismissingDown.value = true
        runOnJS(beginRightDismiss)()
        requestTranslateY.value = withTiming(screenHeight + 40, { duration: 220 }, finished => {
          if (finished) runOnJS(finishRightDismiss)()
        })
      } else requestTranslateY.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!requestDismissingDown.value && requestTranslateY.value > 0 && requestTranslateY.value <= 110) requestTranslateY.value = withTiming(0, { duration: 180 })
    })

  const dismissRightGesture = Gesture.Pan()
    .activeOffsetX(18)
    .failOffsetY([-24, 24])
    .onUpdate(event => {
      if (event.translationX > 0) requestTranslateX.value = event.translationX
    })
    .onEnd(event => {
      if (event.translationX > 90 || event.velocityX > 700) {
        requestDismissingRight.value = true
        runOnJS(beginRightDismiss)()
        requestTranslateX.value = withTiming(screenWidth + 40, { duration: 210 }, finished => {
          if (finished) runOnJS(finishRightDismiss)()
        })
      } else requestTranslateX.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!requestDismissingRight.value && requestTranslateX.value > 0 && requestTranslateX.value <= 90) requestTranslateX.value = withTiming(0, { duration: 180 })
    })

  const dismissGesture = Gesture.Race(dismissDownGesture, dismissRightGesture)
  const requestScreenGesture = Platform.OS === 'android' ? dismissRightGesture : dismissGesture

  const dismissAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: requestTranslateX.value }, { translateY: requestTranslateY.value }],
  }))

  const submit = async () => {
    if (!card || !message.trim() || !supabase || submitting) return
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidPattern.test(card.id)) {
      Alert.alert('신청할 수 없는 글', '데모 글에는 대화를 신청할 수 없어요. 발견 목록을 새로고침해 실제 사용자의 글을 선택해 주세요.')
      return
    }
    setSubmitting(true)
    try {
      const { error } = await supabase.rpc('create_chat_request', {
        card_uuid: card.id,
        opening_text: message.trim(),
      })
      if (error) throw error
      addAppBreadcrumb('chat_request_sent', { source: 'discovery' })
      Alert.alert('대화 요청 완료', '상대방의 수락을 기다리고 있습니다.')
      onSent()
      onClose()
    } catch (reason) {
      captureAppError(reason, 'chat_request', 'send', { source: 'discovery' })
      Alert.alert('신청하지 못했어요', requestErrorMessage(errorMessage(reason)))
    } finally {
      setSubmitting(false)
    }
  }

  return <><Modal visible={card !== null} animationType={Platform.OS === 'android' ? 'fade' : closingRight ? 'none' : 'slide'} presentationStyle="fullScreen" onShow={focusMessageInput} onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.flex}>
      <GestureDetector gesture={requestScreenGesture}>
        <Animated.View style={[styles.modalSafe, { paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 20 : 0) }, dismissAnimatedStyle]}>
          {Platform.OS === 'android' ? <GestureDetector gesture={dismissDownGesture}><View style={styles.modalHeader}><Pressable accessibilityRole="button" accessibilityLabel="대화 신청 취소" hitSlop={14} style={styles.requestCancelButton} onPress={closeRequestComposer}><Text style={styles.headerAction}>취소</Text></Pressable><Text style={styles.modalTitle}>대화 신청</Text><View style={styles.requestHeaderSpacer} /></View></GestureDetector> : <View style={styles.modalHeader}><Pressable accessibilityRole="button" accessibilityLabel="대화 신청 취소" hitSlop={14} style={styles.requestCancelButton} onPress={closeRequestComposer}><Text style={styles.headerAction}>취소</Text></Pressable><Text style={styles.modalTitle}>대화 신청</Text><View style={styles.requestHeaderSpacer} /></View>}
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'android' ? 'height' : undefined} keyboardVerticalOffset={0}>
            <ScrollView style={styles.requestScroll} contentContainerStyle={[styles.composer, Platform.OS === 'ios' && { paddingBottom: keyboardHeight + 92 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'} showsVerticalScrollIndicator={false}>
              {card?.avatarUrl
                ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={`${card.nickname}님의 프로필 사진 크게 보기`} hitSlop={7} onPress={() => { Keyboard.dismiss(); setProfilePhotoVisible(true) }} style={styles.personPhotoButton}><Image source={{ uri: card.avatarUrl }} style={styles.personPhoto} /></Pressable>
                : <View style={styles.personCircle}><Text style={styles.personInitial}>{card?.nickname[0]}</Text></View>}
              <Text style={styles.composerName}>{card?.nickname}님에게</Text>
              <Text style={styles.composerTopic}>{card?.topic}</Text>
              <Text style={styles.inputLabel}>첫 인사를 함께 보내주세요</Text>
              <TextInput ref={inputRef} value={message} onChangeText={setMessage} maxLength={200} multiline scrollEnabled autoFocus showSoftInputOnFocus placeholder="예: 저도 전시를 좋아해요. 편하게 이야기해 볼까요?" placeholderTextColor="#A8A29E" style={styles.requestInput} />
              <Text style={styles.counter}>{message.length}/200</Text>
            </ScrollView>
            {Platform.OS === 'android' && <View style={styles.requestFooter}>{requestButton()}</View>}
          </KeyboardAvoidingView>
          {Platform.OS === 'ios' && <View style={[styles.requestFooter, styles.iosRequestFooter, { bottom: keyboardHeight > 0 ? keyboardHeight : insets.bottom }]}>{requestButton()}</View>}
          {Platform.OS === 'ios' && <ChatProfilePhotoViewer visible={profilePhotoVisible} uri={card?.avatarUrl ?? null} nickname={card?.nickname ?? ''} embedded onClose={() => setProfilePhotoVisible(false)} />}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  </Modal>{Platform.OS === 'android' && <ChatProfilePhotoViewer visible={profilePhotoVisible} uri={card?.avatarUrl ?? null} nickname={card?.nickname ?? ''} onClose={() => setProfilePhotoVisible(false)} />}</>
}

function ChatRoomModal({ room, onClose, onChanged }: { room: RoomItem | null; onClose: () => void; onChanged: () => void }) {
  const insets = useSafeAreaInsets()
  const i18n = useI18n()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [body, setBody] = useState('')
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [managing, setManaging] = useState(false)
  const [photoVisible, setPhotoVisible] = useState(false)
  const [messagePhoto, setMessagePhoto] = useState<{ uri: string; title: string } | null>(null)
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false)
  const [pendingPhoto, setPendingPhoto] = useState<ImagePickerAsset | null>(null)
  const [manageMenuVisible, setManageMenuVisible] = useState(false)
  const [reportVisible, setReportVisible] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportDetails, setReportDetails] = useState('')
  const [reporting, setReporting] = useState(false)
  const [closingRight, setClosingRight] = useState(false)
  const [chatKeyboardInset, setChatKeyboardInset] = useState(0)
  const listRef = useRef<FlatList<MessageItem>>(null)
  const initialScrollPendingRef = useRef(false)
  const initialScrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const keyboardScrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const roomDismissingDown = useSharedValue(false)
  const roomDismissingRight = useSharedValue(false)
  const roomTranslateX = useSharedValue(0)
  const roomTranslateY = useSharedValue(0)

  useEffect(() => {
    initialScrollTimersRef.current.forEach(clearTimeout)
    initialScrollTimersRef.current = []
    keyboardScrollTimersRef.current.forEach(clearTimeout)
    keyboardScrollTimersRef.current = []
    if (room) {
      roomDismissingDown.value = false
      roomDismissingRight.value = false
      roomTranslateX.value = 0
      roomTranslateY.value = 0
      setClosingRight(false)
    }
    setManageMenuVisible(false)
    setReportVisible(false)
    setMessagePhoto(null)
    setAttachmentMenuVisible(false)
    setPendingPhoto(null)
    setReportReason('')
    setReportDetails('')
  }, [room?.room_id])

  useEffect(() => {
    if (!room || !supabase) return
    const client = supabase
    let mounted = true
    let activeUserId = ''
    initialScrollPendingRef.current = true
    setLoading(true)
    setMessages([])

    const addMessage = (next: MessageItem) => {
      if (!mounted) return
      setMessages(current => current.some(item => item.id === next.id) ? current : [...current, next])
    }

    const load = async () => {
      const { data: sessionData } = await client.auth.getSession()
      const currentUserId = sessionData.session?.user.id ?? ''
      activeUserId = currentUserId
      if (mounted) setUserId(currentUserId)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await client.from('messages').select('id, room_id, sender_id, body, image_path, image_width, image_height, created_at').eq('room_id', room.room_id).eq('moderation_state', 'visible').gte('created_at', thirtyDaysAgo).order('created_at', { ascending: true }).limit(300)
      if (error) Alert.alert('메시지를 불러오지 못했어요', error.message)
      else {
        const hydrated = await Promise.all(((data ?? []) as MessageItem[]).map(withChatPhotoUrl))
        if (mounted) setMessages(hydrated)
      }
      await client.rpc('mark_room_read', { room_uuid: room.room_id })
      if (mounted) setLoading(false)
      onChanged()
    }

    void load()
    const channel = client.channel(`room:${room.room_id}:messages`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.room_id}` }, payload => {
        const next = payload.new as MessageItem
        void withChatPhotoUrl(next).then(addMessage)
        if (next.sender_id !== activeUserId) {
          void client.rpc('mark_room_read', { room_uuid: room.room_id }).then(() => onChanged())
        } else {
          onChanged()
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_rooms', filter: `id=eq.${room.room_id}` }, payload => {
        const changedRoom = payload.new as { closed_at?: string | null }
        if (!mounted || !changedRoom.closed_at) return
        setMessages([])
        onClose()
        onChanged()
      })
      .subscribe()

    return () => {
      mounted = false
      void client.removeChannel(channel)
    }
  }, [room?.room_id])

  useEffect(() => {
    if (!messages.length || initialScrollPendingRef.current) return
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80)
    return () => clearTimeout(timer)
  }, [messages.length])

  useEffect(() => () => {
    initialScrollTimersRef.current.forEach(clearTimeout)
    keyboardScrollTimersRef.current.forEach(clearTimeout)
  }, [])

  const showLatestMessagesOnOpen = () => {
    if (!initialScrollPendingRef.current || !messages.length) return
    initialScrollTimersRef.current.forEach(clearTimeout)
    initialScrollTimersRef.current = [0, 80, 220, 500, 900].map((delay, index, delays) => setTimeout(() => {
      if (Platform.OS === 'android') listRef.current?.scrollToEnd({ animated: false })
      else listRef.current?.scrollToOffset({ offset: 1_000_000_000, animated: false })
      if (index === delays.length - 1) initialScrollPendingRef.current = false
    }, delay))
  }

  const keepLatestMessageAboveKeyboard = () => {
    if (!messages.length) return
    keyboardScrollTimersRef.current.forEach(clearTimeout)
    keyboardScrollTimersRef.current = [0, 80, 220, 420].map(delay => setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: delay === 0 })
    }, delay))
  }

  useEffect(() => {
    if (!room) { setChatKeyboardInset(0); return }
    const updateKeyboardInset = (event: Parameters<typeof Keyboard.scheduleLayoutAnimation>[0]) => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      // iOS already resizes this full-screen modal. Track visibility only so the
      // home-indicator inset is removed while the keyboard occupies that edge.
      setChatKeyboardInset(Platform.OS === 'ios' ? 1 : 0)
      keepLatestMessageAboveKeyboard()
    }
    const frameChanged = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', updateKeyboardInset)
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', event => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setChatKeyboardInset(0)
    })
    return () => { frameChanged.remove(); hidden.remove() }
  }, [room?.room_id, messages.length, screenHeight])

  const chooseChatPhoto = async () => {
    setAttachmentMenuVisible(false)
    try {
      const selected = await pickChatPhoto()
      if (!selected) return
      if (selected.fileSize && selected.fileSize > CHAT_IMAGE_MAX_BYTES) {
        Alert.alert('사진이 너무 커요', '8MB 이하의 사진을 선택해 주세요.')
        return
      }
      setPendingPhoto(selected)
      keepLatestMessageAboveKeyboard()
    } catch (reason) {
      captureAppError(reason, 'chat_photo', 'pick')
      Alert.alert('사진을 선택하지 못했어요', errorMessage(reason))
    }
  }

  const send = async () => {
    if (!supabase || !room || !userId || (!body.trim() && !pendingPhoto) || sending) return
    const messageBody = body.trim()
    const selectedPhoto = pendingPhoto
    setBody('')
    setPendingPhoto(null)
    setAttachmentMenuVisible(false)
    setSending(true)
    let uploadedPath: string | null = null
    try {
      if (selectedPhoto) uploadedPath = await uploadChatPhoto(room.room_id, userId, selectedPhoto.uri, selectedPhoto.mimeType)
      const { data, error } = await supabase.from('messages').insert({
        room_id: room.room_id,
        sender_id: userId,
        body: messageBody || '사진',
        image_path: uploadedPath,
        image_width: selectedPhoto?.width ?? null,
        image_height: selectedPhoto?.height ?? null,
      }).select('id, room_id, sender_id, body, image_path, image_width, image_height, created_at').single()
      if (error) throw error
      if (data) {
        const hydrated = await withChatPhotoUrl(data as MessageItem)
        setMessages(current => current.some(item => item.id === hydrated.id) ? current : [...current, hydrated])
      }
    } catch (reason) {
      if (uploadedPath) await removeChatPhoto(uploadedPath)
      setBody(messageBody)
      setPendingPhoto(selectedPhoto)
      captureAppError(reason, 'chat_message', 'send', { roomId: room.room_id, hasPhoto: Boolean(selectedPhoto) })
      Alert.alert('전송 실패', errorMessage(reason))
    }
    setSending(false)
    onChanged()
  }

  const manageRoom = async (action: 'delete' | 'block') => {
    if (!supabase || !room || managing) return
    setManaging(true)
    const { error } = await supabase.rpc('manage_chat_room', { room_uuid: room.room_id, action })
    setManaging(false)
    if (error) {
      const message = error.message.includes('function') || error.message.includes('schema cache')
        ? '채팅방 관리 SQL 마이그레이션을 Supabase에 적용해 주세요.'
        : error.message
      Alert.alert(action === 'block' ? '차단하지 못했어요' : '삭제하지 못했어요', message)
      return
    }
    Alert.alert(action === 'block' ? '차단 완료' : '대화방 삭제 완료', action === 'block' ? `${room.other_nickname}님을 차단하고 양쪽의 대화 내용과 대화방을 삭제했습니다.` : '양쪽의 대화 내용과 대화방을 삭제했습니다.')
    onClose()
    onChanged()
  }

  const openReport = () => {
    setManageMenuVisible(false)
    setReportReason('')
    setReportDetails('')
    setReportVisible(true)
  }

  const submitReport = async () => {
    if (!supabase || !room || !reportReason || reporting) return
    setReporting(true)
    const { error } = await supabase.rpc('report_chat_user', {
      room_uuid: room.room_id,
      reason_code: reportReason,
      report_details: reportDetails.trim(),
    })
    setReporting(false)
    if (error) {
      const message = error.message.includes('report_already_exists')
        ? '이미 이 대화 상대를 신고했습니다.'
        : error.message.includes('function') || error.message.includes('schema cache')
          ? '신고 기능 SQL 마이그레이션을 Supabase에 적용해 주세요.'
          : error.message
      Alert.alert('신고하지 못했어요', message)
      return
    }
    setReportVisible(false)
    Alert.alert('신고가 접수되었습니다', '운영자가 대화 내용과 신고 사유를 확인합니다. 상대방을 차단하시겠어요?', [
      { text: '나중에', style: 'cancel' },
      { text: '차단', style: 'destructive', onPress: () => void manageRoom('block') },
    ])
  }

  const openRoomMenu = () => {
    if (!room || managing) return
    Keyboard.dismiss()
    setManageMenuVisible(true)
  }

  const closeChatRoom = () => {
    Keyboard.dismiss()
    roomDismissingDown.value = false
    roomDismissingRight.value = false
    roomTranslateX.value = 0
    roomTranslateY.value = 0
    onClose()
  }

  const finishRightRoomDismiss = () => {
    Keyboard.dismiss()
    onClose()
  }

  const beginRightRoomDismiss = () => setClosingRight(true)

  const roomDismissDownGesture = Gesture.Pan()
    .enabled(!manageMenuVisible && !reportVisible && !photoVisible && !messagePhoto)
    .activeOffsetY(18)
    .failOffsetX([-24, 24])
    .onUpdate(event => {
      if (event.translationY > 0) roomTranslateY.value = event.translationY
    })
    .onEnd(event => {
      if (event.translationY > 110 || event.velocityY > 850) {
        roomDismissingDown.value = true
        runOnJS(beginRightRoomDismiss)()
        roomTranslateY.value = withTiming(screenHeight + 40, { duration: 220 }, finished => {
          if (finished) runOnJS(finishRightRoomDismiss)()
        })
      } else roomTranslateY.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!roomDismissingDown.value && roomTranslateY.value > 0 && roomTranslateY.value <= 110) roomTranslateY.value = withTiming(0, { duration: 180 })
    })

  const roomDismissRightGesture = Gesture.Pan()
    .enabled(!manageMenuVisible && !reportVisible && !photoVisible && !messagePhoto)
    .activeOffsetX(18)
    .failOffsetY([-24, 24])
    .onUpdate(event => {
      if (event.translationX > 0) roomTranslateX.value = event.translationX
    })
    .onEnd(event => {
      if (event.translationX > 90 || event.velocityX > 700) {
        roomDismissingRight.value = true
        runOnJS(beginRightRoomDismiss)()
        roomTranslateX.value = withTiming(screenWidth + 40, { duration: 210 }, finished => {
          if (finished) runOnJS(finishRightRoomDismiss)()
        })
      } else roomTranslateX.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!roomDismissingRight.value && roomTranslateX.value > 0 && roomTranslateX.value <= 90) roomTranslateX.value = withTiming(0, { duration: 180 })
    })

  const roomDismissAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: roomTranslateX.value }, { translateY: roomTranslateY.value }],
  }))

  return <><Modal visible={room !== null} animationType={Platform.OS === 'android' ? 'fade' : closingRight ? 'none' : 'slide'} onShow={() => setChatKeyboardInset(0)} onDismiss={() => setChatKeyboardInset(0)} onRequestClose={closeChatRoom}>
    <GestureHandlerRootView style={[styles.flex, styles.cleanChatPage]}>
      <GestureDetector gesture={roomDismissRightGesture}>
        <Animated.View style={[styles.flex, roomDismissAnimatedStyle]}>
          <View style={[styles.chatSafe, styles.cleanChatPage, { paddingTop: insets.top, paddingBottom: chatKeyboardInset > 0 ? 0 : insets.bottom }]}>
            <View style={styles.chatHeader}><Pressable accessibilityRole="button" accessibilityLabel="대화 목록으로 돌아가기" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={closeChatRoom} style={styles.chatBackButton}><Text style={styles.back}>‹</Text></Pressable><GestureDetector gesture={roomDismissDownGesture}><View style={styles.chatHeaderIdentity}>{room?.other_avatar_url ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={`${room.other_nickname}님의 프로필 사진 크게 보기`} hitSlop={7} onPress={() => setPhotoVisible(true)}><Image source={{ uri: room.other_avatar_url }} style={styles.smallAvatarImage} /></Pressable> : <View style={styles.smallAvatar}><Text style={styles.smallAvatarText}>{room?.other_nickname[0]}</Text></View>}<View><Text numberOfLines={1} style={styles.chatTitle}>{room ? <><Text style={[room.other_gender === 'male' && styles.roomMale, room.other_gender === 'female' && styles.roomFemale]}>{room.other_nickname} {roomGenderAge(room.other_gender, room.other_birth_year)}</Text><Text> · {formatDistanceMeters(room.distance_meters)}</Text></> : null}</Text>{room?.other_board_alias && <Text style={styles.chatAlias}>게시판 · {room.other_board_alias}</Text>}</View></View></GestureDetector><Pressable accessibilityRole="button" accessibilityLabel="대화 관리 메뉴" disabled={managing} onPress={openRoomMenu} style={styles.chatMenuButton}><Text style={styles.moreMenu}>•••</Text></Pressable></View>
            <KeyboardAvoidingView
              style={styles.flex}
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              keyboardVerticalOffset={0}
            >
              {loading ? <View style={styles.center}><ActivityIndicator color="#F26B4B" /></View> : <FlatList ref={listRef} data={messages} keyExtractor={item => String(item.id)} initialNumToRender={Platform.OS === 'android' ? Math.max(messages.length, 10) : 10} removeClippedSubviews={Platform.OS !== 'android'} keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.messageList, styles.wideMessageList]} onLayout={showLatestMessagesOnOpen} onContentSizeChange={showLatestMessagesOnOpen} renderItem={({ item }) => {
                const mine = item.sender_id === userId
                const imageRatio = item.image_width && item.image_height ? Math.max(0.7, Math.min(1.6, item.image_width / item.image_height)) : 1
                const image = item.image_path && (item.image_url
                  ? <Pressable accessibilityRole="imagebutton" accessibilityLabel="채팅 사진 크게 보기" onPress={() => setMessagePhoto({ uri: item.image_url!, title: mine ? '보낸 사진' : `${room?.other_nickname ?? '상대방'}님의 사진` })}><Image source={{ uri: item.image_url }} resizeMode="cover" style={[styles.chatMessageImage, { aspectRatio: imageRatio }]} /></Pressable>
                  : <View style={[styles.chatMessageImage, styles.chatMessageImageUnavailable]}><Text style={styles.chatMessageImageUnavailableText}>사진을 불러오지 못했어요</Text></View>)
                const caption = item.image_path && item.body === '사진' ? null : item.body
                const sentTime = formatTime(item.created_at, i18n.language, i18n.country)
                const content = <View style={[styles.messageContent, mine ? styles.messageContentMine : styles.messageContentOther]}>{image}{caption ? <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther, item.image_path && (mine ? styles.imageCaptionMine : styles.imageCaptionOther)]}><Text selectable selectionColor={mine ? '#FFFFFF66' : '#D94F7066'} style={[styles.messageText, mine && styles.messageTextMine]}>{caption}</Text></View> : null}</View>
                if (mine) return <View style={[styles.messageLine, styles.wideMessageLine, styles.messageLineMine]}><View style={[styles.messageMetaRow, styles.messageMetaRowMine]}><Text numberOfLines={1} style={[styles.messageTime, styles.messageTimeMine]}>{sentTime}</Text>{content}</View></View>
                return <View style={styles.incomingMessageRow}>{room?.other_avatar_url ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={`${room.other_nickname}님의 프로필 사진 크게 보기`} hitSlop={6} onPress={() => setPhotoVisible(true)}><Image source={{ uri: room.other_avatar_url }} style={styles.messageAvatarImage} /></Pressable> : <View style={styles.messageAvatar}><Text style={styles.messageAvatarText}>{room?.other_nickname[0]}</Text></View>}<View style={[styles.messageLine, styles.messageLineOther, styles.incomingMessageContent]}><Text numberOfLines={1} style={styles.messageSenderName}>{room?.other_nickname}</Text><View style={styles.messageMetaRow}>{content}<Text numberOfLines={1} style={[styles.messageTime, styles.messageTimeOther]}>{sentTime}</Text></View></View></View>
              }} ListEmptyComponent={<Text style={styles.emptyChat}>첫 메시지를 보내 대화를 시작해 보세요.</Text>} />}
              {attachmentMenuVisible && <View style={styles.attachmentPanel}><Pressable accessibilityRole="button" accessibilityLabel="사진 보관함에서 선택" onPress={() => void chooseChatPhoto()} style={styles.attachmentChoice}><View style={styles.attachmentIcon}><Text style={styles.attachmentIconText}>▧</Text></View><Text style={styles.attachmentLabel}>사진</Text></Pressable></View>}
              {pendingPhoto && <View style={styles.pendingPhotoRow}><Image source={{ uri: pendingPhoto.uri }} style={styles.pendingPhotoImage} /><View style={styles.pendingPhotoBody}><Text style={styles.pendingPhotoTitle}>사진 첨부됨</Text><Text style={styles.pendingPhotoGuide}>메시지를 함께 적거나 바로 전송할 수 있어요</Text></View><Pressable accessibilityRole="button" accessibilityLabel="첨부 사진 제거" hitSlop={8} onPress={() => setPendingPhoto(null)} style={styles.pendingPhotoRemove}><Text style={styles.pendingPhotoRemoveText}>×</Text></Pressable></View>}
              <View style={styles.sendBar}><Pressable accessibilityRole="button" accessibilityLabel={attachmentMenuVisible ? '첨부 메뉴 닫기' : '첨부 메뉴 열기'} disabled={sending} onPress={() => { Keyboard.dismiss(); setAttachmentMenuVisible(value => !value) }} style={styles.attachButton}><Text style={styles.attachButtonText}>{attachmentMenuVisible ? '×' : '+'}</Text></Pressable><TextInput value={body} onChangeText={setBody} onFocus={() => { setAttachmentMenuVisible(false); keepLatestMessageAboveKeyboard() }} maxLength={2000} multiline placeholder="메시지 보내기" placeholderTextColor="#A8A29E" style={styles.messageInput} /><Pressable disabled={(!body.trim() && !pendingPhoto) || sending} onPress={send} style={[styles.sendButton, ((!body.trim() && !pendingPhoto) || sending) && styles.sendButtonDisabled]}><Text style={styles.sendButtonText}>{sending ? '…' : '↑'}</Text></Pressable></View>
            </KeyboardAvoidingView>
          </View>
    {manageMenuVisible && (
      <View style={styles.actionOverlay}>
        <Pressable accessibilityLabel="대화 관리 닫기" style={styles.actionBackdrop} onPress={() => setManageMenuVisible(false)} />
        <SafeAreaView style={[styles.actionSheet, Platform.OS === 'ios' && styles.iosActionSheet]}>
          <View style={Platform.OS === 'ios' ? styles.iosActionSheetContent : undefined}>
          <Text style={styles.actionSheetTitle}>대화 관리</Text>
          <Text style={styles.actionSheetSubtitle}>{room?.other_nickname}님과의 대화를 관리합니다</Text>
          <Pressable style={styles.actionItem} onPress={() => { setManageMenuVisible(false); Alert.alert('대화방을 삭제할까요?', '상대방의 대화 목록에서도 함께 삭제됩니다.', [{ text: '취소', style: 'cancel' }, { text: '삭제', style: 'destructive', onPress: () => void manageRoom('delete') }]) }}><Text style={styles.actionItemDanger}>삭제</Text></Pressable>
          <Pressable style={styles.actionItem} onPress={() => { setManageMenuVisible(false); Alert.alert('상대방을 차단할까요?', '이 대화방이 삭제되고 상대방은 더 이상 대화를 신청하거나 메시지를 보낼 수 없습니다.', [{ text: '취소', style: 'cancel' }, { text: '차단', style: 'destructive', onPress: () => void manageRoom('block') }]) }}><Text style={styles.actionItemDanger}>차단</Text></Pressable>
          <Pressable style={styles.actionItem} onPress={openReport}><Text style={styles.actionItemReport}>신고</Text></Pressable>
          <Pressable style={[styles.actionItem, styles.actionCancel]} onPress={() => setManageMenuVisible(false)}><Text style={styles.actionCancelText}>취소</Text></Pressable>
          </View>
        </SafeAreaView>
      </View>
    )}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  </Modal>
    <Modal visible={reportVisible} animationType="slide" onRequestClose={() => !reporting && setReportVisible(false)}>
      <SafeAreaView style={styles.reportSafe}>
        <View style={styles.reportHeader}><Pressable disabled={reporting} hitSlop={8} onPress={() => setReportVisible(false)}><Text style={styles.reportHeaderAction}>취소</Text></Pressable><Text style={styles.reportTitle}>대화 상대 신고</Text><View style={styles.reportHeaderSpacer} /></View>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={styles.reportContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={styles.reportTarget}>{room?.other_nickname}님을 신고합니다</Text>
            <Text style={styles.reportGuide}>신고 사유를 선택해 주세요. 운영자가 최근 대화 내용과 함께 검토합니다.</Text>
            <View style={styles.reportReasons}>{chatReportReasons.map(item => <Pressable key={item.code} onPress={() => setReportReason(item.code)} style={[styles.reportReason, reportReason === item.code && styles.reportReasonSelected]}><Text style={[styles.reportReasonText, reportReason === item.code && styles.reportReasonTextSelected]}>{item.label}</Text></Pressable>)}</View>
            <Text style={styles.reportDetailsLabel}>상세 내용 <Text style={styles.reportOptional}>(선택)</Text></Text>
            <TextInput value={reportDetails} onChangeText={setReportDetails} maxLength={1000} multiline textAlignVertical="top" placeholder="운영자가 확인해야 할 내용을 적어주세요" placeholderTextColor="#A8A29E" style={styles.reportInput} />
            <Text style={styles.reportCounter}>{reportDetails.length}/1000</Text>
            <Text style={styles.reportPrivacy}>허위 신고는 서비스 이용이 제한될 수 있으며, 신고 사실은 상대방에게 공개되지 않습니다.</Text>
            <Pressable disabled={!reportReason || reporting} onPress={() => void submitReport()} style={[styles.reportSubmit, (!reportReason || reporting) && styles.disabled]}><Text style={styles.reportSubmitText}>{reporting ? '접수 중…' : '신고 접수'}</Text></Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
    <ChatProfilePhotoViewer visible={photoVisible} uri={room?.other_avatar_url ?? null} nickname={room?.other_nickname ?? ''} onClose={() => setPhotoVisible(false)} />
    <ChatProfilePhotoViewer visible={messagePhoto !== null} uri={messagePhoto?.uri ?? null} nickname={messagePhoto?.title ?? '사진'} onClose={() => setMessagePhoto(null)} />
  </>
}

type BlockedUser = { blocked_id: string; nickname: string; avatar_url: string | null; blocked_at: string }

function BlockedUsersModal({ visible, onClose, onChanged }: { visible: boolean; onClose: () => void; onChanged: () => void }) {
  const i18n = useI18n()
  const [users, setUsers] = useState<BlockedUser[]>([])
  const [loading, setLoading] = useState(false)
  const [unblockingId, setUnblockingId] = useState('')
  const [closingBySwipe, setClosingBySwipe] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) { setUsers([]); return }
    setLoading(true)
    const { data, error } = await supabase.rpc('my_blocked_users')
    setLoading(false)
    if (error) {
      Alert.alert('차단 목록을 불러오지 못했어요', error.message.includes('function') || error.message.includes('schema cache') ? '차단 관리 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
      return
    }
    setUsers((data ?? []) as BlockedUser[])
  }, [])

  useEffect(() => {
    if (!visible) return
    setClosingBySwipe(false)
    void load()
  }, [visible, load])

  const confirmUnblock = (user: BlockedUser) => Alert.alert(
    '차단을 해제할까요?',
    `${user.nickname}님이 다시 내 프로필과 공개 활동을 볼 수 있고 서로 대화를 신청할 수 있습니다.`,
    [
      { text: '취소', style: 'cancel' },
      {
        text: '차단 해제',
        onPress: async () => {
          if (!supabase || unblockingId) return
          setUnblockingId(user.blocked_id)
          const { data, error } = await supabase.rpc('unblock_user', { blocked_user_id: user.blocked_id })
          setUnblockingId('')
          if (error) {
            Alert.alert('차단을 해제하지 못했어요', error.message.includes('function') || error.message.includes('schema cache') ? '차단 관리 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
            return
          }
          if (!data) {
            await load()
            return
          }
          setUsers(current => current.filter(item => item.blocked_id !== user.blocked_id))
          onChanged()
        },
      },
    ],
  )

  return <Modal visible={visible} animationType={Platform.OS === 'android' ? 'fade' : closingBySwipe ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={onClose}>
    <SwipeDismissView onDismissStart={() => setClosingBySwipe(true)} onDismiss={onClose} enabled={!unblockingId}>
      <SafeAreaView style={styles.blockedSafe}>
        <View style={styles.blockedHeader}><Pressable accessibilityRole="button" accessibilityLabel="차단 관리 닫기" hitSlop={10} onPress={onClose} style={styles.blockedHeaderButton}><Text style={styles.blockedClose}>닫기</Text></Pressable><Text style={styles.blockedTitle}>차단 친구 관리</Text><View style={styles.blockedHeaderButton} /></View>
        <View style={styles.blockedGuide}><Text style={styles.blockedGuideText}>내가 차단한 친구만 표시됩니다. 차단을 해제하면 서로의 공개 활동과 대화 신청이 다시 허용됩니다.</Text></View>
        {loading ? <View style={styles.center}><ActivityIndicator color="#D94F70" /></View> : <FlatList data={users} keyExtractor={item => item.blocked_id} contentContainerStyle={styles.blockedList} refreshing={loading} onRefresh={() => void load()} ListEmptyComponent={<View style={styles.blockedEmpty}><Text style={styles.blockedEmptyTitle}>차단한 친구가 없어요</Text><Text style={styles.blockedEmptyText}>차단한 친구가 생기면 이곳에서 관리할 수 있습니다.</Text></View>} renderItem={({ item }) => <View style={styles.blockedRow}>{item.avatar_url ? <Image source={{ uri: item.avatar_url }} style={styles.blockedAvatarImage} /> : <View style={styles.blockedAvatar}><Text style={styles.blockedAvatarText}>{item.nickname[0]}</Text></View>}<View style={styles.blockedUserBody}><Text numberOfLines={1} style={styles.blockedNickname}>{item.nickname}</Text><Text style={styles.blockedDate}>{formatDate(item.blocked_at, i18n.language, i18n.country)} 차단</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`${item.nickname}님 차단 해제`} disabled={Boolean(unblockingId)} onPress={() => confirmUnblock(item)} style={[styles.unblockButton, Boolean(unblockingId) && styles.disabled]}>{unblockingId === item.blocked_id ? <ActivityIndicator size="small" color="#C43F63" /> : <Text style={styles.unblockText}>차단 해제</Text>}</Pressable></View>} />}
      </SafeAreaView>
    </SwipeDismissView>
  </Modal>
}

export function ChatHub({ onUnreadChanged }: { onUnreadChanged?: (count: number) => void }) {
  const i18n = useI18n()
  const [section, setSection] = useState<'chats' | 'received' | 'sent'>('chats')
  const [rooms, setRooms] = useState<RoomItem[]>([])
  const [requests, setRequests] = useState<RequestItem[]>([])
  const [selectedRoom, setSelectedRoom] = useState<RoomItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [respondingId, setRespondingId] = useState('')
  const [requestPhoto, setRequestPhoto] = useState<{ uri: string; nickname: string } | null>(null)
  const [blockedUsersVisible, setBlockedUsersVisible] = useState(false)

  const refresh = useCallback(async () => {
    if (!supabase) return
    const [{ data: roomData, error: roomError }, { data: requestData, error: requestError }] = await Promise.all([
      supabase.rpc('my_chat_rooms'),
      supabase.rpc('my_chat_requests'),
    ])
    if (roomError || requestError) {
      const message = roomError?.message ?? requestError?.message ?? ''
      if (message.includes('function') || message.includes('schema cache')) Alert.alert('채팅 설정 필요', '새 채팅 SQL 마이그레이션을 Supabase에 적용해 주세요.')
    } else {
      const nextRooms = ((roomData ?? []) as RoomItem[]).map(room => ({
        ...room,
        unread_count: Number(room.unread_count),
        distance_meters: room.distance_meters == null ? null : Number(room.distance_meters),
      }))
      setRooms(nextRooms)
      const rawRequests = (requestData ?? []) as Array<Omit<RequestItem, 'other_gender' | 'other_birth_year' | 'other_avatar_url'>>
      const otherUserIds = [...new Set(rawRequests.map(request => request.other_user_id).filter(Boolean))]
      let profileRows: Array<{ id: string; gender: string | null; birth_year: number | null; avatar_url: string | null }> = []
      if (otherUserIds.length > 0) {
        const { data: profileData, error: profileError } = await supabase.from('profiles').select('id, gender, birth_year, avatar_url').in('id', otherUserIds)
        if (!profileError) profileRows = (profileData ?? []) as typeof profileRows
      }
      const profileByUserId = new Map(profileRows.map(profile => [profile.id, profile]))
      const nextRequests: RequestItem[] = rawRequests.map(request => {
        const profile = profileByUserId.get(request.other_user_id)
        return { ...request, distance_meters: request.distance_meters == null ? null : Number(request.distance_meters), other_gender: profile?.gender ?? null, other_birth_year: profile?.birth_year ?? null, other_avatar_url: request.other_nickname ? profile?.avatar_url ?? null : null }
      })
      const unreadMessages = nextRooms.reduce((total, room) => total + room.unread_count, 0)
      const pendingReceived = nextRequests.filter(request => request.direction === 'received' && request.request_status === 'pending').length
      onUnreadChanged?.(unreadMessages + pendingReceived)
      setRequests(nextRequests)
    }
    setLoading(false)
  }, [onUnreadChanged])

  useEffect(() => {
    if (!supabase) return
    let channel: ReturnType<typeof supabase.channel> | null = null
    void refresh()
    void supabase.auth.getSession().then(({ data }) => {
      const id = data.session?.user.id
      if (!id || !supabase) return
      channel = supabase.channel(`chat-requests:${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_requests', filter: `receiver_id=eq.${id}` }, () => void refresh())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_requests', filter: `sender_id=eq.${id}` }, () => void refresh())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => void refresh())
        .subscribe()
    })
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh()
    })
    const refreshTimer = setInterval(() => void refresh(), 4000)
    return () => {
      clearInterval(refreshTimer)
      appStateSubscription.remove()
      if (channel && supabase) void supabase.removeChannel(channel)
    }
  }, [refresh])

  const respond = async (request: RequestItem, decision: 'accepted' | 'declined') => {
    if (!supabase || respondingId) return
    setRespondingId(request.request_id)
    const { data, error } = await supabase.rpc('respond_to_chat_request', { request_uuid: request.request_id, decision })
    if (error) Alert.alert('처리하지 못했어요', requestErrorMessage(error.message))
    await refresh()
    setRespondingId('')
    if (!error && decision === 'accepted' && data) {
      const room = (await supabase.rpc('my_chat_rooms')).data?.find((item: RoomItem) => item.room_id === data) as RoomItem | undefined
      if (room) {
        setSection('chats')
        setSelectedRoom({ ...room, unread_count: Number(room.unread_count) })
      }
    }
  }

  const removeRequest = (request: RequestItem) => {
    if (!supabase || respondingId) return
    const independentlyHidden = request.request_status === 'declined'
    Alert.alert(independentlyHidden ? '거절된 신청을 삭제할까요?' : '보낸 신청을 삭제할까요?', independentlyHidden ? '내 목록에서만 삭제되며 상대방의 목록에는 영향을 주지 않습니다.' : '본인과 상대방의 신청 목록에서 모두 삭제됩니다. 사용한 포인트는 반환되지 않습니다.', [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          if (!supabase) return
          setRespondingId(request.request_id)
          const { error } = await supabase.rpc(independentlyHidden ? 'hide_declined_chat_request' : 'withdraw_chat_request', { request_uuid: request.request_id })
          if (error) Alert.alert('삭제하지 못했어요', requestErrorMessage(error.message))
          await refresh()
          setRespondingId('')
        },
      },
    ])
  }

  const visibleRequests = requests.filter(item => item.request_status !== 'accepted' && item.direction === (section === 'received' ? 'received' : 'sent'))
  const pendingReceivedCount = requests.filter(item => item.direction === 'received' && item.request_status === 'pending').length
  const sentRequestCount = requests.filter(item => item.direction === 'sent' && item.request_status === 'pending').length
  const statusLabel = { pending: '대기 중', accepted: '수락됨', declined: '거절됨', cancelled: '취소됨' }
  const refreshList = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return <View style={[styles.hubPage, styles.cleanPage, styles.wideChatHub]}>
    <View style={[styles.hubHeader, styles.compensatedHubHeader]}><View><Text style={styles.hubTitle}>대화</Text><Text style={styles.hubSubtitle}>서로 수락한 뒤 안전하게 이야기해요</Text></View><View style={styles.hubHeaderActions}><Pressable accessibilityRole="button" accessibilityLabel="대화 목록 새로고침" onPress={() => { setLoading(true); void refresh() }} style={styles.hubRefreshButton}><Text style={styles.refresh}>↻</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="차단 친구 관리" onPress={() => setBlockedUsersVisible(true)} style={styles.blockedManageButton}><Text style={styles.blockedManageIcon}>⊘</Text><Text style={styles.blockedManageText}>차단</Text></Pressable></View></View>
    <View style={styles.segment}>{([['chats', '채팅'], ['received', '받은 신청'], ['sent', '보낸 신청']] as const).map(([key, label]) => <Pressable key={key} onPress={() => setSection(key)} style={[styles.segmentButton, section === key && styles.segmentActive]}><Text style={[styles.segmentText, section === key && styles.segmentTextActive]}>{label}{key === 'received' && pendingReceivedCount > 0 ? ` ${pendingReceivedCount}` : key === 'sent' && sentRequestCount > 0 ? ` ${sentRequestCount}` : ''}</Text></Pressable>)}</View>
    {loading ? <View style={styles.center}><ActivityIndicator color="#F26B4B" /></View> : section === 'chats' ? <FlatList data={rooms} keyExtractor={item => item.room_id} contentContainerStyle={styles.hubList} refreshing={refreshing} onRefresh={() => void refreshList()} alwaysBounceVertical overScrollMode="always" renderItem={({ item }) => <Pressable style={styles.roomRow} onPress={() => setSelectedRoom(item)}>{item.other_avatar_url ? <Image source={{ uri: item.other_avatar_url }} style={styles.roomAvatarImage} /> : <View style={styles.roomAvatar}><Text style={styles.roomAvatarText}>{item.other_nickname[0]}</Text></View>}<View style={styles.roomBody}><View style={styles.roomMetaLine}><Text numberOfLines={1} style={styles.roomMetaText}><Text style={[styles.roomName, item.other_gender === 'male' && styles.roomMale, item.other_gender === 'female' && styles.roomFemale]}>{item.other_nickname}</Text><Text style={[styles.roomAge, item.other_gender === 'male' && styles.roomMale, item.other_gender === 'female' && styles.roomFemale]}> {roomGenderAge(item.other_gender, item.other_birth_year)}</Text><Text style={styles.roomTime}> · {formatDistanceMeters(item.distance_meters)} · {roomElapsed(item.last_message_at)}</Text></Text>{item.other_board_alias && <Text numberOfLines={1} style={styles.roomAlias}>게시판 · {item.other_board_alias}</Text>}</View><View style={styles.rowBetween}><Text numberOfLines={1} ellipsizeMode="tail" style={styles.roomPreview}>{item.last_message ?? '대화를 시작해 보세요.'}</Text>{item.unread_count > 0 && <Text style={styles.unread}>{item.unread_count}</Text>}</View></View></Pressable>} ListEmptyComponent={<Text style={styles.emptyState}>아직 열린 채팅방이 없어요.{`\n`}대화 신청이 수락되면 여기에 표시됩니다.</Text>} /> : <FlatList data={visibleRequests} keyExtractor={item => item.request_id} contentContainerStyle={styles.hubList} refreshing={refreshing} onRefresh={() => void refreshList()} alwaysBounceVertical overScrollMode="always" renderItem={({ item }) => <View style={styles.requestCard}><Pressable accessibilityRole={item.other_avatar_url ? 'imagebutton' : undefined} accessibilityLabel={item.other_avatar_url ? `${item.other_nickname ?? '상대방'}님의 프로필 사진 크게 보기` : undefined} disabled={!item.other_avatar_url} onPress={() => item.other_avatar_url && setRequestPhoto({ uri: item.other_avatar_url, nickname: item.other_nickname ?? '상대방' })} style={styles.requestProfileButton}>{item.other_avatar_url ? <Image source={{ uri: item.other_avatar_url }} style={styles.requestProfileImage} /> : <View style={styles.requestProfilePlaceholder}><Text style={styles.requestProfileInitial}>{(item.board_alias ?? item.other_nickname ?? '익')[0]}</Text></View>}</Pressable><RequestSummary item={item} statusText={statusLabel[item.request_status]} /><Text style={styles.opening}>“{item.opening_message}”</Text>{section === 'received' && item.request_status === 'pending' && <View style={styles.actions}><Pressable disabled={respondingId === item.request_id} onPress={() => void respond(item, 'declined')} style={styles.declineButton}><Text style={styles.declineText}>거절</Text></Pressable><Pressable disabled={respondingId === item.request_id} onPress={() => void respond(item, 'accepted')} style={styles.acceptButton}><Text style={styles.acceptText}>{respondingId === item.request_id ? '처리 중…' : '수락'}</Text></Pressable></View>}{item.request_status === 'declined' && <Pressable disabled={respondingId === item.request_id} onPress={() => removeRequest(item)} style={styles.withdrawButton}><Text style={styles.withdrawText}>{respondingId === item.request_id ? '삭제 중…' : '삭제'}</Text></Pressable>}{section === 'sent' && item.request_status !== 'declined' && <Pressable disabled={respondingId === item.request_id} onPress={() => removeRequest(item)} style={styles.withdrawButton}><Text style={styles.withdrawText}>{respondingId === item.request_id ? '삭제 중…' : '삭제'}</Text></Pressable>}{item.request_status === 'accepted' && item.room_id && <Pressable onPress={() => { const room = rooms.find(value => item.room_id === value.room_id); if (room) setSelectedRoom(room) }} style={styles.openChatButton}><Text style={styles.openChatText}>채팅방 열기</Text></Pressable>}</View>} ListEmptyComponent={<Text style={styles.emptyState}>{section === 'received' ? '받은 대화 신청이 없어요.' : '보낸 대화 신청이 없어요.'}</Text>} />}
    <ChatRoomModal room={selectedRoom} onClose={() => { setSelectedRoom(null); void refresh() }} onChanged={refresh} />
    <ChatProfilePhotoViewer visible={requestPhoto !== null} uri={requestPhoto?.uri ?? null} nickname={requestPhoto?.nickname ?? '상대방'} onClose={() => setRequestPhoto(null)} />
    <BlockedUsersModal visible={blockedUsersVisible} onClose={() => setBlockedUsersVisible(false)} onChanged={() => void refresh()} />
  </View>
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, modalSafe: { flex: 1, backgroundColor: '#FFF9F5' }, modalHeader: { height: 60, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' }, modalTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' }, headerAction: { color: '#F26B4B', fontSize: 15, fontWeight: '800' }, headerSpacer: { width: 32 }, requestCancelButton: { width: 88, height: 60, paddingLeft: 12, justifyContent: 'center', alignItems: 'flex-start' }, requestHeaderSpacer: { width: 88 }, requestScroll: { flex: 1 }, composer: { flexGrow: 1, padding: 22, paddingBottom: 18, alignItems: 'center' }, personCircle: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#FFE0D5', alignItems: 'center', justifyContent: 'center', marginTop: 10 }, personPhotoButton: { width: 68, height: 68, borderRadius: 34, marginTop: 10, overflow: 'hidden', borderWidth: 2, borderColor: '#F2C9D4' }, personPhoto: { width: '100%', height: '100%' }, personInitial: { color: '#9A3412', fontSize: 22, fontWeight: '900' }, composerName: { color: '#1F2937', fontSize: 19, fontWeight: '900', marginTop: 12 }, composerTopic: { color: '#78716C', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 6 }, inputLabel: { color: '#374151', fontSize: 13, fontWeight: '800', alignSelf: 'flex-start', marginTop: 28, marginBottom: 9 }, requestInput: { width: '100%', height: 125, maxHeight: 125, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderRadius: 16, padding: 15, textAlignVertical: 'top', color: '#1F2937', fontSize: 15, lineHeight: 22 }, counter: { alignSelf: 'flex-end', color: '#A8A29E', fontSize: 11, marginTop: 5 }, requestFooter: { flexShrink: 0, paddingHorizontal: 22, paddingTop: 10, paddingBottom: Platform.OS === 'android' ? 12 : 8, backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2' }, iosRequestFooter: { position: 'absolute', left: 0, right: 0, zIndex: 20 }, primaryButton: { width: '100%', backgroundColor: '#F26B4B', borderRadius: 15, paddingVertical: 16, alignItems: 'center', marginTop: 20 }, requestFooterButton: { marginTop: 0 }, primaryButtonText: { color: '#FFFFFF', fontWeight: '900' }, disabled: { opacity: 0.35 },
  hubPage: { flex: 1, backgroundColor: '#FFF7F9' }, hubHeader: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 15, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, hubTitle: { color: '#3B1F2B', fontSize: 25, lineHeight: 32, fontWeight: '900', letterSpacing: -0.4 }, hubSubtitle: { color: '#B84A67', fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 3 }, hubHeaderActions: { marginTop: 3, marginLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, hubRefreshButton: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }, refresh: { color: '#D94F70', fontSize: 25, lineHeight: 30, fontWeight: '700' }, blockedManageButton: { width: 78, height: 40, paddingHorizontal: 9, borderRadius: 13, borderWidth: 1, borderColor: '#E5CDD5', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }, blockedManageIcon: { color: '#B82F55', fontSize: 16, fontWeight: '900', marginRight: 4 }, blockedManageText: { color: '#8C2946', fontSize: 11, fontWeight: '900' }, segment: { marginHorizontal: 20, backgroundColor: '#F1E4E8', padding: 4, borderRadius: 14, flexDirection: 'row' }, segmentButton: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11 }, segmentActive: { backgroundColor: '#FFFCFD', shadowColor: '#7B3048', shadowOpacity: 0.08, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 }, segmentText: { color: '#967E87', fontSize: 12, fontWeight: '700' }, segmentTextActive: { color: '#C43F63', fontWeight: '900' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, hubList: { paddingHorizontal: 20, paddingVertical: 15, flexGrow: 1 }, roomRow: { backgroundColor: '#FFFCFD', borderRadius: 19, padding: 14, flexDirection: 'row', marginBottom: 11, borderWidth: 1, borderColor: '#F0D9E1', shadowColor: '#7B3048', shadowOpacity: 0.07, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, roomAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FCE7F3', borderWidth: 2, borderColor: '#F6CEDB', alignItems: 'center', justifyContent: 'center' }, roomAvatarText: { color: '#BE185D', fontWeight: '900' }, roomBody: { flex: 1, marginLeft: 12, justifyContent: 'center' }, rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, roomName: { color: '#3B1F2B', fontSize: 15, fontWeight: '900' }, roomTime: { color: '#AD98A0', fontSize: 10 }, roomPreview: { color: '#806B73', fontSize: 12, marginTop: 6, flex: 1 }, unread: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: '#D92F5A', color: '#FFFFFF', fontSize: 10, lineHeight: 20, textAlign: 'center', fontWeight: '900', marginLeft: 8 }, emptyState: { textAlign: 'center', color: '#A58D96', fontSize: 13, lineHeight: 21, marginTop: 65 }, requestCard: { backgroundColor: '#FFFCFD', borderRadius: 19, padding: 15, paddingLeft: 72, marginBottom: 11, borderWidth: 1, borderColor: '#F0D9E1', shadowColor: '#7B3048', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 }, requestProfileButton: { position: 'absolute', left: 15, top: 15, width: 44, height: 44, borderRadius: 22, overflow: 'hidden' }, requestProfileImage: { width: '100%', height: '100%', backgroundColor: '#F3F4F6' }, requestProfilePlaceholder: { flex: 1, backgroundColor: '#FCE7F3', borderWidth: 1, borderColor: '#F6CEDB', alignItems: 'center', justifyContent: 'center' }, requestProfileInitial: { color: '#BE185D', fontSize: 14, fontWeight: '900' }, requestSummary: { alignItems: 'flex-start' }, requestSummaryLine: { maxWidth: '100%', color: '#3B1F2B' }, requestName: { color: '#3B1F2B', fontSize: 15, fontWeight: '900' }, requestMeta: { color: '#806B73', fontSize: 12, fontWeight: '600' }, requestStatusBlock: { alignItems: 'flex-end', marginLeft: 10 }, status: { color: '#A52E51', backgroundColor: '#FCE8EE', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: '800' }, requestStatusBelow: { marginTop: 8, alignSelf: 'flex-start' }, statusAccepted: { color: '#166534', backgroundColor: '#DCFCE7' }, requestElapsed: { color: '#A58D96', fontSize: 10, marginTop: 5 }, requestTopic: { color: '#806B73', fontSize: 12, marginTop: 9 }, opening: { color: '#3B2730', fontSize: 14, lineHeight: 21, marginTop: 10, fontWeight: '600' }, actions: { flexDirection: 'row', gap: 9, marginTop: 15 }, declineButton: { flex: 1, borderRadius: 12, paddingVertical: 11, backgroundColor: '#F3E9EC', alignItems: 'center' }, declineText: { color: '#806B73', fontWeight: '800' }, acceptButton: { flex: 2, borderRadius: 12, paddingVertical: 11, backgroundColor: '#D94F70', alignItems: 'center' }, acceptText: { color: '#FFFFFF', fontWeight: '900' }, withdrawButton: { minHeight: 42, borderRadius: 12, marginTop: 14, backgroundColor: '#F3E9EC', alignItems: 'center', justifyContent: 'center' }, withdrawText: { color: '#A52E51', fontSize: 13, fontWeight: '800' }, openChatButton: { backgroundColor: '#4A2634', borderRadius: 12, paddingVertical: 11, alignItems: 'center', marginTop: 14 }, openChatText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  blockedSafe: { flex: 1, backgroundColor: '#FFF9F8' }, blockedHeader: { height: 58, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#EEE4E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, blockedHeaderButton: { width: 78, minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' }, blockedClose: { color: '#D94F70', fontSize: 15, fontWeight: '900' }, blockedTitle: { color: '#292524', fontSize: 17, fontWeight: '900' }, blockedGuide: { marginHorizontal: 18, marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: '#FFF0F2', borderWidth: 1, borderColor: '#F4D5DB' }, blockedGuideText: { color: '#8C5260', fontSize: 11, lineHeight: 18 }, blockedList: { padding: 18, paddingBottom: 40, flexGrow: 1 }, blockedRow: { minHeight: 76, marginBottom: 10, paddingHorizontal: 13, borderRadius: 16, borderWidth: 1, borderColor: '#EDE2E4', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' }, blockedAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#FCE7F3', alignItems: 'center', justifyContent: 'center' }, blockedAvatarImage: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#F3F4F6' }, blockedAvatarText: { color: '#BE185D', fontSize: 15, fontWeight: '900' }, blockedUserBody: { flex: 1, minWidth: 0, marginHorizontal: 11 }, blockedNickname: { color: '#292524', fontSize: 14, fontWeight: '900' }, blockedDate: { color: '#A18A91', fontSize: 10, marginTop: 5 }, unblockButton: { minWidth: 76, minHeight: 38, paddingHorizontal: 10, borderRadius: 11, borderWidth: 1, borderColor: '#E8B8C4', backgroundColor: '#FFF7F9', alignItems: 'center', justifyContent: 'center' }, unblockText: { color: '#B82F55', fontSize: 11, fontWeight: '900' }, blockedEmpty: { flex: 1, minHeight: 300, alignItems: 'center', justifyContent: 'center' }, blockedEmptyTitle: { color: '#3B2730', fontSize: 16, fontWeight: '900' }, blockedEmptyText: { color: '#967E87', fontSize: 11, marginTop: 7 },
  chatSafe: { flex: 1, backgroundColor: '#FBF1F4' }, chatHeader: { height: 58, backgroundColor: '#FFFCFD', borderBottomWidth: 1, borderBottomColor: '#F0DDE3', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, justifyContent: 'space-between' }, chatBackButton: { width: 56, height: 58, marginLeft: -15, paddingLeft: 15, alignItems: 'flex-start', justifyContent: 'center' }, chatMenuButton: { width: 56, height: 58, marginRight: -15, paddingRight: 15, alignItems: 'flex-end', justifyContent: 'center' }, back: { color: '#D94F70', fontSize: 35, lineHeight: 38 }, chatHeaderIdentity: { flexDirection: 'row', alignItems: 'center' }, smallAvatar: { width: 33, height: 33, borderRadius: 17, backgroundColor: '#FCE7F3', alignItems: 'center', justifyContent: 'center' }, smallAvatarText: { color: '#BE185D', fontSize: 12, fontWeight: '900' }, chatTitle: { color: '#3B1F2B', fontWeight: '900', marginLeft: 9 }, chatAlias: { color: '#A58D96', fontSize: 9, marginLeft: 9, marginTop: 1 }, moreMenu: { color: '#806B73', letterSpacing: 2, fontWeight: '900' }, messageList: { padding: 16, flexGrow: 1 }, messageLine: { marginBottom: 13, maxWidth: '82%' }, messageLineMine: { alignSelf: 'flex-end', alignItems: 'flex-end' }, messageLineOther: { alignSelf: 'flex-start', alignItems: 'flex-start' }, messageMetaRow: { flexDirection: 'row', alignItems: 'flex-end' }, messageMetaRowMine: { justifyContent: 'flex-end' }, messageContent: { flexShrink: 1 }, messageContentMine: { alignItems: 'flex-end' }, messageContentOther: { alignItems: 'flex-start' }, bubble: { borderRadius: 18, paddingHorizontal: 13, paddingVertical: 10 }, bubbleMine: { backgroundColor: '#D94F70', borderBottomRightRadius: 5 }, bubbleOther: { backgroundColor: '#FFFCFD', borderBottomLeftRadius: 5, borderWidth: 1, borderColor: '#F0DDE3' }, messageText: { color: '#3B2730', fontSize: 14, lineHeight: 20 }, messageTextMine: { color: '#FFFFFF' }, messageTime: { color: '#AD98A0', fontSize: 9, marginBottom: 2 }, messageTimeMine: { marginRight: 6 }, messageTimeOther: { marginLeft: 6 }, emptyChat: { textAlign: 'center', color: '#A58D96', fontSize: 12, marginTop: 60 }, sendBar: { backgroundColor: '#FFFCFD', borderTopWidth: 1, borderTopColor: '#F0DDE3', paddingHorizontal: 10, paddingVertical: 9, flexDirection: 'row', alignItems: 'flex-end' }, attachButton: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: '#DFC9D1', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: 7 }, attachButtonText: { color: '#806B73', fontSize: 27, lineHeight: 29, fontWeight: '400' }, messageInput: { flex: 1, maxHeight: 110, minHeight: 40, backgroundColor: '#F8EFF2', borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 9, color: '#3B1F2B', fontSize: 14 }, sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#D94F70', alignItems: 'center', justifyContent: 'center', marginLeft: 7 }, sendButtonDisabled: { opacity: 0.35 }, sendButtonText: { color: '#FFFFFF', fontSize: 21, fontWeight: '900' },
  attachmentPanel: { minHeight: 96, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: '#FFFCFD', borderTopWidth: 1, borderTopColor: '#F0DDE3' }, attachmentChoice: { width: 64, alignItems: 'center' }, attachmentIcon: { width: 50, height: 50, borderRadius: 16, backgroundColor: '#FCE8EE', alignItems: 'center', justifyContent: 'center' }, attachmentIconText: { color: '#C43F63', fontSize: 25, fontWeight: '700' }, attachmentLabel: { color: '#6B5560', fontSize: 11, fontWeight: '800', marginTop: 6 }, pendingPhotoRow: { minHeight: 74, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: '#FFFCFD', borderTopWidth: 1, borderTopColor: '#F0DDE3', flexDirection: 'row', alignItems: 'center' }, pendingPhotoImage: { width: 56, height: 56, borderRadius: 12, backgroundColor: '#F3F4F6' }, pendingPhotoBody: { flex: 1, marginHorizontal: 11 }, pendingPhotoTitle: { color: '#3B1F2B', fontSize: 13, fontWeight: '900' }, pendingPhotoGuide: { color: '#967E87', fontSize: 10, marginTop: 3 }, pendingPhotoRemove: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }, pendingPhotoRemoveText: { color: '#806B73', fontSize: 25, lineHeight: 27 }, chatMessageImage: { width: 220, maxWidth: '100%', minHeight: 135, maxHeight: 280, borderRadius: 16, backgroundColor: '#EDE7E9' }, chatMessageImageUnavailable: { alignItems: 'center', justifyContent: 'center', padding: 14 }, chatMessageImageUnavailableText: { color: '#967E87', fontSize: 11, fontWeight: '700' }, imageCaptionMine: { marginTop: 5 }, imageCaptionOther: { marginTop: 5 },
  cleanPage: { backgroundColor: '#F7F9FA' }, cleanChatPage: { backgroundColor: '#F4F6F8' },
  roomAvatarImage: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#F3F4F6' }, smallAvatarImage: { width: 33, height: 33, borderRadius: 17, backgroundColor: '#F3F4F6' },
  roomMetaLine: { alignItems: 'flex-start' }, roomMetaText: { flexShrink: 1 }, roomAlias: { color: '#A58D96', fontSize: 9, marginTop: 2 }, requestAliasLabel: { color: '#A58D96', fontSize: 9, marginTop: 2 }, roomAge: { color: '#57534E', fontSize: 13, fontWeight: '800' }, roomMale: { color: '#2563EB' }, roomFemale: { color: '#E04468' },
  incomingMessageRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 13, maxWidth: '94%' }, incomingMessageContent: { marginBottom: 0, maxWidth: '88%' }, messageAvatarImage: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#F3F4F6', marginRight: 8 }, messageAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#FCE7F3', alignItems: 'center', justifyContent: 'center', marginRight: 8 }, messageAvatarText: { color: '#BE185D', fontSize: 12, fontWeight: '900' }, messageSenderName: { color: '#57534E', fontSize: 11, fontWeight: '800', marginBottom: 5 },
  photoViewerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }, photoViewerEmbedded: { ...StyleSheet.absoluteFillObject, zIndex: 100 }, photoViewerHeader: { minHeight: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, photoViewerHeading: { flex: 1, marginRight: 14 }, photoViewerName: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' }, photoViewerHint: { color: '#A8A29E', fontSize: 11, marginTop: 3 }, photoViewerClose: { minWidth: 52, minHeight: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }, photoViewerCloseText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, photoViewerArea: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, photoViewerImage: { width: '100%', height: '100%' },
  actionOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 50, justifyContent: 'flex-end', backgroundColor: 'rgba(20,15,18,0.42)' }, actionBackdrop: { ...StyleSheet.absoluteFillObject }, actionSheet: { backgroundColor: '#FFFCFD', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 21, paddingBottom: 10, overflow: 'hidden' }, iosActionSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28 }, iosActionSheetContent: { paddingTop: 20 }, actionSheetTitle: { color: '#3B1F2B', fontSize: 18, fontWeight: '900', textAlign: 'center' }, actionSheetSubtitle: { color: '#967E87', fontSize: 12, textAlign: 'center', marginTop: 5, marginBottom: 15 }, actionItem: { minHeight: 52, borderTopWidth: 1, borderTopColor: '#F1E4E8', alignItems: 'center', justifyContent: 'center' }, actionItemDanger: { color: '#DC2626', fontSize: 15, fontWeight: '800' }, actionItemReport: { color: '#C43F63', fontSize: 15, fontWeight: '900' }, actionCancel: { marginTop: 8, borderTopWidth: 0, borderRadius: 14, backgroundColor: '#F3E9EC' }, actionCancelText: { color: '#6B5560', fontSize: 15, fontWeight: '800' },
  reportSafe: { flex: 1, backgroundColor: '#FFF9F5' }, reportHeader: { height: 56, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: '#EEE7E2', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, reportHeaderAction: { color: '#F26B4B', fontSize: 14, fontWeight: '800' }, reportTitle: { color: '#1F2937', fontSize: 16, fontWeight: '900' }, reportHeaderSpacer: { width: 30 }, reportContent: { padding: 20, paddingBottom: 60 }, reportTarget: { color: '#1F2937', fontSize: 19, fontWeight: '900' }, reportGuide: { color: '#78716C', fontSize: 13, lineHeight: 20, marginTop: 7, marginBottom: 18 }, reportReasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, reportReason: { paddingHorizontal: 13, minHeight: 42, borderRadius: 12, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }, reportReasonSelected: { borderColor: '#D94F70', backgroundColor: '#FCE8EE' }, reportReasonText: { color: '#57534E', fontSize: 13, fontWeight: '700' }, reportReasonTextSelected: { color: '#B82F55', fontWeight: '900' }, reportDetailsLabel: { color: '#374151', fontSize: 13, fontWeight: '900', marginTop: 24, marginBottom: 9 }, reportOptional: { color: '#A8A29E', fontWeight: '600' }, reportInput: { minHeight: 120, borderRadius: 15, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', padding: 14, color: '#1F2937', fontSize: 14, lineHeight: 21 }, reportCounter: { color: '#A8A29E', fontSize: 10, textAlign: 'right', marginTop: 5 }, reportPrivacy: { color: '#8B817A', fontSize: 11, lineHeight: 17, marginTop: 16 }, reportSubmit: { minHeight: 50, borderRadius: 15, backgroundColor: '#D94F70', alignItems: 'center', justifyContent: 'center', marginTop: 18 }, reportSubmitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  wideMessageList: { paddingHorizontal: 16 }, wideMessageLine: { maxWidth: '82%' }, wideChatHub: { marginHorizontal: -20 }, compensatedHubHeader: { marginHorizontal: 20 },
})

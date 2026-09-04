import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImagePickerAsset } from 'expo-image-picker'
import {
  ActivityIndicator, Alert, FlatList, Image, Keyboard, KeyboardAvoidingView, Modal,
  Platform, Pressable, ScrollView, StyleSheet, type TextInput as NativeTextInput, View,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text, TextInput } from '../i18n/localizedUi'
import { getAccountId } from '../lib/phoneAuth'
import { supabase } from '../lib/supabase'
import { captureAppError } from '../lib/observability'
import { removeUnsentOpenChatAudio, uploadOpenChatAudio } from '../lib/openChatAudio'
import { OpenChatAudioMessage, OpenChatVoiceRecorder } from './OpenChatAudio'
import { ChatProfilePhotoViewer } from './ChatFlow'
import { ChatRoomSafeArea } from './ChatRoomSafeArea'
import { SwipeDismissView } from './SwipeDismissView'
import { logOpenChatDiagnostic } from '../lib/openChatDiagnostics'
import { mainTabHeaderActionStyle, mainTabHeaderActionTextStyle, mainTabHeaderSpacing, mainTabListHorizontalInset, mainTabListTopGap, mainTabSubtitleStyle, mainTabTitleStyle } from '../lib/mainTabLayout'
import { useIosKeyboardInset } from '../hooks/useIosKeyboardInset'
import { createOpenChatPhotoUrl, OPEN_CHAT_IMAGE_MAX_BYTES, pickOpenChatPhoto, removeUnsentOpenChatPhoto, uploadOpenChatPhoto } from '../lib/openChatPhoto'
import { getOpenChatCoverUrl, OPEN_CHAT_COVER_MAX_BYTES, removeOpenChatCover, uploadOpenChatCover } from '../lib/openChatCover'
import { loadNotificationPreferences, saveNotificationPreferences } from '../lib/notificationPreferences'
import { createRefreshQueue } from '../lib/refreshQueue'
import { markRefreshNavigation, startRefreshPerf } from '../lib/refreshPerf'
import { useRefreshPerfScreen } from '../hooks/useRefreshPerfScreen'

type Room = {
  room_id: string
  title: string
  description: string
  notice: string
  category: string
  region: string | null
  tags: string[]
  member_count: number
  max_members: number
  recent_message_at: string | null
  is_member: boolean
  owner_user_id: string
  owner_nickname: string
  created_at: string
  cover_storage_path: string | null
  cover_width: number | null
  cover_height: number | null
  cover_url?: string | null
}

type Participant = {
  user_id: string
  nickname: string
  avatar_url: string | null
  gender: string | null
  birth_year: number
  joined_at: string
  is_owner: boolean
}

type Message = {
  id: number
  room_id: string
  sender_user_id: string | null
  message_type: 'text' | 'system' | 'audio' | 'image'
  content: string | null
  audio_storage_path: string | null
  audio_duration_ms: number | null
  image_storage_path: string | null
  image_width: number | null
  image_height: number | null
  image_url?: string | null
  reply_to_message_id: number | null
  created_at: string
}

const categories = ['수다', '취미', '친구', '연애', '고민상담', '지역']

function messageOf(reason: unknown, fallback: string) {
  if (typeof reason === 'object' && reason && 'message' in reason) {
    const message = String(reason.message)
    const known: Record<string, string> = {
      room_full: '방 정원이 가득 찼습니다.',
      room_banned: '이 방에는 다시 입장할 수 없습니다.',
      room_not_active: '종료되었거나 존재하지 않는 방입니다.',
      owner_must_leave_room_first: '방장으로 참여 중인 수다방을 먼저 나가주세요.',
      owner_required: '방장만 실행할 수 있습니다.',
      target_not_active_participant: '현재 참여 중인 사용자에게만 방장을 넘길 수 있습니다.',
      cannot_request_self: '자신에게는 대화를 신청할 수 없습니다.',
      participants_required: '현재 같은 방에 참여 중인 사용자에게만 신청할 수 있습니다.',
      users_blocked: '차단 관계에서는 대화를 신청할 수 없습니다.',
      insufficient_points: '대화 신청에는 100포인트가 필요합니다.',
      report_already_exists: '이미 신고한 대상입니다.',
      room_access_required: '현재 참여 중인 방에서만 메시지를 보낼 수 있습니다.',
      invalid_reply_target: '답장할 원본 메시지를 찾을 수 없습니다.',
      invalid_audio_metadata: '음성 메시지는 30초 이하여야 합니다.',
      audio_not_uploaded: '음성 파일 업로드를 확인하지 못했습니다.',
      invalid_image_metadata: '사진 정보를 확인하지 못했습니다.',
      image_not_uploaded: '사진 업로드를 확인하지 못했습니다.',
    }
    return known[message] ?? message
  }
  return fallback
}

const reportReasons = [
  ['abuse', '욕설/괴롭힘'], ['sexual', '성적인 콘텐츠'], ['spam', '스팸/광고'],
  ['impersonation', '사칭/허위정보'], ['dangerous', '불법/위험 행위'], ['other', '기타'],
] as const

function elapsed(iso: string | null) {
  if (!iso) return '아직 대화 없음'
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`
  return `${Math.floor(minutes / 1440)}일 전`
}

function Avatar({ participant, size = 42 }: { participant: Participant; size?: number }) {
  if (participant.avatar_url) return <Image source={{ uri: participant.avatar_url }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}><Text style={styles.avatarText}>{participant.nickname[0]}</Text></View>
}

function RoomPreviewModal({ room, entering = false, informationOnly = false, onClose, onEnter }: { room: Room | null; entering?: boolean; informationOnly?: boolean; onClose: () => void; onEnter?: (room: Room) => void }) {
  if (!room) return null
  const full = !room.is_member && room.member_count >= room.max_members
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.roomPreviewPage}>
      <View style={styles.roomPreviewHeader}><Pressable accessibilityRole="button" accessibilityLabel={informationOnly ? '수다방 정보 닫기' : '방 미리보기 닫기'} onPress={onClose} style={styles.roomPreviewClose}><Text style={styles.roomPreviewCloseText}>닫기</Text></Pressable><Text style={styles.roomPreviewHeaderTitle}>{informationOnly ? '수다방 정보' : '수다방 미리보기'}</Text><View style={styles.roomPreviewHeaderSpace} /></View>
      <ScrollView contentContainerStyle={styles.roomPreviewContent}>
        {room.cover_url ? <Image source={{ uri: room.cover_url }} resizeMode="cover" style={styles.roomPreviewCover} /> : <View style={[styles.roomPreviewCover, styles.roomCoverPlaceholder]}><Text style={styles.roomCoverPlaceholderIcon}>☁</Text><Text style={styles.roomCoverPlaceholderText}>{room.category}</Text></View>}
        <View style={styles.roomPreviewBody}>
          <View style={styles.roomPreviewBadgeRow}><Text style={styles.roomPreviewCategory}>{room.category}</Text>{room.region && <Text style={styles.roomPreviewRegion}>{room.region}</Text>}{room.is_member && <Text style={styles.roomPreviewJoined}>참여 중</Text>}</View>
          <Text style={styles.roomPreviewTitle}>{room.title}</Text>
          <Text style={styles.roomPreviewDescription}>{room.description || '편하게 대화를 시작해 보세요.'}</Text>
          <View style={styles.roomPreviewStats}><View style={styles.roomPreviewStat}><Text style={styles.roomPreviewStatLabel}>현재 인원</Text><Text style={styles.roomPreviewStatValue}>{room.member_count}/{room.max_members}명</Text></View><View style={styles.roomPreviewStat}><Text style={styles.roomPreviewStatLabel}>방장</Text><Text numberOfLines={1} style={styles.roomPreviewStatValue}>{room.owner_nickname || '방장'}</Text></View><View style={styles.roomPreviewStat}><Text style={styles.roomPreviewStatLabel}>최근 대화</Text><Text style={styles.roomPreviewStatValue}>{elapsed(room.recent_message_at ?? room.created_at)}</Text></View></View>
          {room.tags.length > 0 && <View style={styles.roomPreviewTags}>{room.tags.map(tag => <Text key={tag} style={styles.roomPreviewTag}>#{tag}</Text>)}</View>}
          {room.notice ? <View style={styles.roomPreviewNotice}><Text style={styles.roomPreviewNoticeLabel}>공지</Text><Text style={styles.roomPreviewNoticeText}>{room.notice}</Text></View> : null}
        </View>
      </ScrollView>
      {!informationOnly && onEnter && <View style={styles.roomPreviewFooter}><Pressable accessibilityRole="button" disabled={entering || full} onPress={() => onEnter(room)} style={[styles.roomPreviewEnter, (entering || full) && styles.disabled]}><Text style={styles.roomPreviewEnterText}>{entering ? '입장 중…' : full ? '정원이 가득 찼어요' : room.is_member ? '수다방 들어가기' : '입장하기'}</Text></Pressable></View>}
    </SafeAreaView>
  </Modal>
}

function CreateRoom({ visible, activeRoom, onClose, onCreated }: { visible: boolean; activeRoom: { title: string; isOwner: boolean } | null; onClose: () => void; onCreated: (roomId: string) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState(categories[0])
  const [maxMembers, setMaxMembers] = useState(10)
  const [region, setRegion] = useState('')
  const [tags, setTags] = useState('')
  const [coverPhoto, setCoverPhoto] = useState<ImagePickerAsset | null>(null)
  const [saving, setSaving] = useState(false)
  const keyboardInset = useIosKeyboardInset(visible)
  const close = () => { Keyboard.dismiss(); onClose() }
  const canCreate = title.trim().length >= 2 && title.trim().length <= 40 && description.trim().length >= 1 && description.trim().length <= 120 && maxMembers >= 2 && maxMembers <= 20

  const chooseCover = async () => {
    try {
      const selected = await pickOpenChatPhoto()
      if (!selected) return
      if (selected.fileSize && selected.fileSize > OPEN_CHAT_COVER_MAX_BYTES) {
        Alert.alert('대표사진이 너무 커요', '8MB 이하의 사진을 선택해 주세요.')
        return
      }
      setCoverPhoto(selected)
    } catch (reason) {
      captureAppError(reason, 'open_chat_cover', 'pick')
      Alert.alert('대표사진을 선택하지 못했어요', messageOf(reason, '잠시 후 다시 시도해 주세요.'))
    }
  }

  const performCreate = async () => {
    if (!supabase || saving) return
    setSaving(true)
    let createdRoomId: string | null = null
    let uploadedCoverPath: string | null = null
    try {
      const { data, error } = await supabase.rpc('create_open_chat_room', {
        room_title: title.trim(), room_description: description.trim(), room_category: category,
        room_max_members: maxMembers, room_region: region.trim() || null,
        room_tags: tags.split(/[,#]/).map(tag => tag.trim()).filter(Boolean).slice(0, 10),
      })
      if (error) throw error
      createdRoomId = String(data)
      if (coverPhoto) {
        const accountId = await getAccountId(supabase)
        if (!accountId) throw new Error('authentication_required')
        uploadedCoverPath = await uploadOpenChatCover(createdRoomId, accountId, coverPhoto.uri, coverPhoto.mimeType)
        const { error: coverError } = await supabase.rpc('set_open_chat_room_cover', {
          room_uuid: createdRoomId, cover_path: uploadedCoverPath,
          image_width: coverPhoto.width, image_height: coverPhoto.height,
        })
        if (coverError) throw coverError
      }
      setTitle(''); setDescription(''); setRegion(''); setTags(''); setMaxMembers(10); setCoverPhoto(null)
      Keyboard.dismiss()
      onCreated(createdRoomId)
    } catch (reason) {
      if (uploadedCoverPath) await removeOpenChatCover(uploadedCoverPath)
      captureAppError(reason, 'open_chat', 'create_room')
      if (createdRoomId) {
        setTitle(''); setDescription(''); setRegion(''); setTags(''); setMaxMembers(10); setCoverPhoto(null)
        Alert.alert('수다방은 만들어졌습니다', '대표사진 등록에 실패했습니다. 방 정보 관리에서 다시 등록해 주세요.')
        onCreated(createdRoomId)
      } else {
        const errorCode = typeof reason === 'object' && reason && 'message' in reason
          ? String(reason.message)
          : ''
        const message = messageOf(reason, '잠시 후 다시 시도해 주세요.')
        if (errorCode.includes('owner_must_leave_room_first')) Alert.alert('새 수다방을 만들 수 없습니다', '방장으로 운영 중인 수다방에서 먼저 나간 후 새 수다방을 만들어 주세요.')
        else if (errorCode.includes('insufficient_points')) Alert.alert('포인트가 부족해요', '수다방을 만들려면 100P가 필요합니다.')
        else Alert.alert('방을 만들지 못했습니다', message)
      }
    } finally { setSaving(false) }
  }

  const create = async () => {
    if (!supabase || saving) return
    if (title.trim().length < 2 || title.trim().length > 40) return Alert.alert('방 제목 확인', '방 제목을 2~40자로 입력해 주세요.')
    if (description.trim().length < 1 || description.trim().length > 120) return Alert.alert('한 줄 설명 확인', '방 설명을 1~120자로 입력해 주세요.')
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 20) return Alert.alert('최대 인원 확인', '최대 인원은 2~20명입니다.')
    if (activeRoom?.isOwner) {
      Alert.alert('새 수다방을 만들 수 없습니다', `방장으로 운영 중인 “${activeRoom.title}”에서 먼저 나간 후 새 수다방을 만들어 주세요.`)
      return
    }
    if (activeRoom) {
      Alert.alert('기존 수다방에서 나가게 됩니다', `새 수다방을 만들면 현재 참여 중인 “${activeRoom.title}”에서 자동으로 퇴장하며 100P가 사용됩니다. 계속할까요?`, [
        { text: '취소', style: 'cancel' },
        { text: '퇴장 후 만들기', onPress: () => void performCreate() },
      ])
      return
    }
    await performCreate()
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView testID="open-chat-create-safe-area" edges={Platform.OS === 'ios' && keyboardInset > 0 ? ['top'] : ['top', 'bottom']} style={[styles.flex, Platform.OS === 'ios' && keyboardInset > 0 && { paddingBottom: keyboardInset }]}>
      <KeyboardAvoidingView testID="open-chat-create-viewport" style={styles.flex} enabled={Platform.OS === 'android'} behavior={Platform.OS === 'android' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        <ScrollView testID="open-chat-create-form" style={styles.flex} contentContainerStyle={styles.form} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
          <Text style={styles.createRoomTitle}>수다방 만들기</Text>
          <Text style={styles.createRoomSubtitle}>함께 이야기할 방의 정보를 입력해 주세요. 만들 때 100P가 사용돼요.</Text>
          <Text style={styles.label}>대표사진 (선택)</Text>
          {coverPhoto ? <View style={styles.coverPickerPreview}><Image source={{ uri: coverPhoto.uri }} resizeMode="cover" style={styles.coverPickerImage} /><View style={styles.coverPickerOverlay}><Pressable accessibilityRole="button" accessibilityLabel="대표사진 변경" onPress={() => void chooseCover()} style={styles.coverPickerOverlayButton}><Text style={styles.coverPickerOverlayText}>사진 변경</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="대표사진 제거" onPress={() => setCoverPhoto(null)} style={styles.coverPickerOverlayButton}><Text style={styles.coverPickerOverlayText}>제거</Text></Pressable></View></View> : <Pressable accessibilityRole="button" accessibilityLabel="대표사진 선택" onPress={() => void chooseCover()} style={styles.coverPickerEmpty}><Text style={styles.coverPickerIcon}>▧</Text><View><Text style={styles.coverPickerTitle}>대표사진 선택</Text><Text style={styles.coverPickerHint}>방의 분위기를 보여주는 사진을 등록해 보세요.</Text></View></Pressable>}
          <Text style={styles.label}>방 제목 *</Text><TextInput value={title} onChangeText={setTitle} maxLength={40} placeholder="어떤 대화를 나눌까요?" style={styles.input} />
          <Text style={styles.label}>한 줄 설명 *</Text><TextInput value={description} onChangeText={setDescription} maxLength={120} placeholder="방을 짧게 소개해 주세요" style={[styles.input, styles.multiline]} multiline />
          <Text style={styles.label}>카테고리 *</Text><View style={styles.chips}>{categories.map(item => <Pressable key={item} onPress={() => setCategory(item)} style={[styles.chip, category === item && styles.chipActive]}><Text style={[styles.chipText, category === item && styles.chipTextActive]}>{item}</Text></Pressable>)}</View>
          <Text style={styles.label}>최대 인원 *</Text>
          <View testID="open-chat-capacity-stepper" style={styles.capacityStepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="최대 인원 1명 줄이기"
              accessibilityState={{ disabled: maxMembers <= 2 }}
              disabled={maxMembers <= 2}
              onPress={() => setMaxMembers(current => Math.max(2, current - 1))}
              style={({ pressed }) => [styles.capacityStepButton, maxMembers <= 2 && styles.capacityStepButtonDisabled, pressed && maxMembers > 2 && styles.capacityStepButtonPressed]}
            ><Text style={[styles.capacityStepSymbol, maxMembers <= 2 && styles.capacityStepSymbolDisabled]}>−</Text></Pressable>
            <View accessibilityRole="text" accessibilityLabel={`최대 인원 ${maxMembers}명`} style={styles.capacityValue}>
              <Text style={styles.capacityValueNumber}>{maxMembers}명</Text>
              <Text style={styles.capacityValueHint}>현재 설정</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="최대 인원 1명 늘리기"
              accessibilityState={{ disabled: maxMembers >= 20 }}
              disabled={maxMembers >= 20}
              onPress={() => setMaxMembers(current => Math.min(20, current + 1))}
              style={({ pressed }) => [styles.capacityStepButton, maxMembers >= 20 && styles.capacityStepButtonDisabled, pressed && maxMembers < 20 && styles.capacityStepButtonPressed]}
            ><Text style={[styles.capacityStepSymbol, maxMembers >= 20 && styles.capacityStepSymbolDisabled]}>＋</Text></Pressable>
          </View>
          <Text style={styles.capacityHelp}>2명부터 20명까지 설정할 수 있어요.</Text>
          <Text style={styles.label}>지역 (선택)</Text><TextInput testID="open-chat-create-region-input" value={region} onChangeText={setRegion} maxLength={40} placeholder="예: 서울 마포구" style={styles.input} />
          <Text style={styles.label}>태그 (선택)</Text><TextInput testID="open-chat-create-tags-input" value={tags} onChangeText={setTags} placeholder="영화, 산책, 맛집" style={styles.input} />
        </ScrollView>
        <View testID="open-chat-create-footer" style={styles.createRoomFooter}>
          <Pressable accessibilityRole="button" disabled={saving} onPress={close} style={styles.createRoomCancelButton}><Text style={styles.createRoomCancelText}>취소</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={!canCreate || saving} onPress={() => void create()} style={[styles.createRoomSubmitButton, (!canCreate || saving) && styles.disabled]}><Text style={styles.createRoomSubmitText}>{saving ? '생성 중…' : '만들기 · 100P'}</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}

function DirectRequestDialog({ roomId, participant, onClose }: { roomId: string; participant: Participant | null; onClose: () => void }) {
  const [message, setMessage] = useState('안녕하세요! 수다방에서 대화 나눠보고 싶어요.')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<NativeTextInput>(null)
  const close = () => { Keyboard.dismiss(); onClose() }
  useEffect(() => { if (participant) setMessage('안녕하세요! 수다방에서 대화 나눠보고 싶어요.') }, [participant?.user_id])
  useEffect(() => { if (participant) logOpenChatDiagnostic('OPEN_CHAT_REQUEST_COMPOSER_RENDER') }, [participant?.user_id])
  useEffect(() => {
    if (!participant) return
    let cancelled = false
    const focusInput = () => {
      if (!cancelled) inputRef.current?.focus()
    }
    const frame = requestAnimationFrame(focusInput)
    // The participant action sheet is a native modal. iOS and some Android
    // devices finish returning window focus after the first React frame.
    const timers = [220, 520].map(delay => setTimeout(focusInput, delay))
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      timers.forEach(clearTimeout)
    }
  }, [participant?.user_id])
  const submit = async () => {
    if (submitting) return
    if (!participant?.user_id.trim()) {
      Alert.alert('대화 신청 대상 오류', '참여자 정보를 확인하지 못했습니다. 참여자 목록을 새로고침한 뒤 다시 시도해 주세요.')
      return
    }
    if (!supabase) {
      Alert.alert('서버 연결 필요', '서버 연결을 확인한 뒤 다시 시도해 주세요.')
      return
    }
    if (!message.trim()) {
      Alert.alert('첫 인사를 입력해 주세요', '상대방에게 보낼 첫 인사를 작성해 주세요.')
      return
    }
    setSubmitting(true)
    try {
      const { error } = await supabase.rpc('create_open_chat_request', {
        room_uuid: roomId, receiver_uuid: participant.user_id, opening_text: message.trim(),
      })
      if (error) throw error
      Alert.alert('대화 요청 완료', '기존 대화 탭에서 상대방의 수락을 기다려 주세요.')
      close()
    } catch (reason) { Alert.alert('신청하지 못했어요', messageOf(reason, '잠시 후 다시 시도해 주세요.')) }
    finally { setSubmitting(false) }
  }
  if (!participant) return null
  return <View accessibilityViewIsModal style={styles.inlineDialogLayer}>
    <View style={styles.overlay}><Pressable accessibilityRole="button" accessibilityLabel="대화 신청 창 닫기" style={styles.sheetBackdrop} onPress={close} /><KeyboardAvoidingView testID="open-chat-request-keyboard-viewport" style={styles.dialogKeyboardAvoider} enabled behavior="padding" keyboardVerticalOffset={0}><ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogScrollContent} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}><View style={styles.dialog}>
      <Text style={styles.dialogTitle}>{participant?.nickname}님에게 대화 신청</Text>
      <Text style={styles.dialogDescription}>상대방이 수락하면 기존 1:1 대화방이 열립니다. 신청에는 100P가 사용됩니다.</Text>
      <TextInput ref={inputRef} value={message} onChangeText={setMessage} maxLength={200} multiline autoFocus showSoftInputOnFocus style={[styles.input, styles.requestInput]} placeholder="첫 인사를 입력해 주세요" />
      <Text style={styles.counter}>{message.length}/200</Text>
      <View style={styles.dialogActions}><Pressable onPress={close} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>취소</Text></Pressable><Pressable disabled={submitting || !message.trim()} onPress={() => void submit()} style={[styles.primaryAction, (submitting || !message.trim()) && styles.disabled]}><Text style={styles.primaryActionText}>{submitting ? '신청 중…' : '대화 신청 · 100P'}</Text></Pressable></View>
    </View></ScrollView></KeyboardAvoidingView></View>
  </View>
}

type ReportTarget = { kind: 'open_chat_user' | 'open_chat_message' | 'open_chat_room'; userId?: string; messageId?: number; label: string }

function ReportModal({ roomId, target, onClose }: { roomId: string; target: ReportTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState<(typeof reportReasons)[number][0]>('abuse')
  const [details, setDetails] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const close = () => { Keyboard.dismiss(); onClose() }
  useEffect(() => { if (target) { setReason('abuse'); setDetails('') } }, [target])
  const submit = async () => {
    if (!supabase || !target || submitting) return
    setSubmitting(true)
    try {
      const { error } = await supabase.rpc('report_open_chat', {
        target_kind: target.kind, room_uuid: roomId, target_user_uuid: target.userId ?? null,
        message_id: target.messageId ?? null, reason_code: reason, report_details: details.trim(),
      })
      if (error) throw error
      Alert.alert('신고 접수 완료', '운영팀에서 내용을 확인하겠습니다.')
      close()
    } catch (reportError) { Alert.alert('신고하지 못했습니다', messageOf(reportError, '잠시 후 다시 시도해 주세요.')) }
    finally { setSubmitting(false) }
  }
  return <Modal visible={Boolean(target)} transparent statusBarTranslucent animationType="fade" onRequestClose={close}>
    <View style={styles.overlay}><Pressable accessibilityRole="button" accessibilityLabel="신고 창 닫기" style={styles.sheetBackdrop} onPress={close} /><KeyboardAvoidingView testID="open-chat-report-keyboard-viewport" style={styles.dialogKeyboardAvoider} enabled behavior="padding" keyboardVerticalOffset={0}><ScrollView style={styles.dialogScroll} contentContainerStyle={styles.dialogScrollContent} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}><View style={styles.dialog}>
      <Text style={styles.dialogTitle}>{target?.label} 신고</Text><Text style={styles.dialogDescription}>신고 사유를 선택해 주세요.</Text>
      <View style={styles.reportReasons}>{reportReasons.map(([value, label]) => <Pressable key={value} onPress={() => setReason(value)} style={[styles.reportReason, reason === value && styles.reportReasonActive]}><Text style={[styles.reportReasonText, reason === value && styles.reportReasonTextActive]}>{label}</Text></Pressable>)}</View>
      <TextInput value={details} onChangeText={setDetails} maxLength={1000} multiline placeholder="추가 설명 (선택)" style={[styles.input, styles.reportDetails]} />
      <View style={styles.dialogActions}><Pressable onPress={close} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>취소</Text></Pressable><Pressable disabled={submitting} onPress={() => void submit()} style={[styles.primaryAction, submitting && styles.disabled]}><Text style={styles.primaryActionText}>{submitting ? '접수 중…' : '신고하기'}</Text></Pressable></View>
    </View></ScrollView></KeyboardAvoidingView></View>
  </Modal>
}

function EditRoomModal({ room, visible, onClose, onSaved }: { room: Room; visible: boolean; onClose: () => void; onSaved: (room: Room) => void }) {
  const [title, setTitle] = useState(room.title); const [description, setDescription] = useState(room.description)
  const [category, setCategory] = useState(room.category); const [region, setRegion] = useState(room.region ?? '')
  const [notice, setNotice] = useState(room.notice ?? ''); const [saving, setSaving] = useState(false)
  const [coverPhoto, setCoverPhoto] = useState<ImagePickerAsset | null>(null); const [removeCover, setRemoveCover] = useState(false)
  const close = () => { Keyboard.dismiss(); onClose() }
  useEffect(() => { if (visible) { setTitle(room.title); setDescription(room.description); setCategory(room.category); setRegion(room.region ?? ''); setNotice(room.notice ?? ''); setCoverPhoto(null); setRemoveCover(false) } }, [visible, room])
  const chooseCover = async () => {
    try {
      const selected = await pickOpenChatPhoto()
      if (!selected) return
      if (selected.fileSize && selected.fileSize > OPEN_CHAT_COVER_MAX_BYTES) return Alert.alert('대표사진이 너무 커요', '8MB 이하의 사진을 선택해 주세요.')
      setCoverPhoto(selected); setRemoveCover(false)
    } catch (reason) { Alert.alert('대표사진을 선택하지 못했어요', messageOf(reason, '잠시 후 다시 시도해 주세요.')) }
  }
  const save = async () => {
    if (!supabase || saving) return
    setSaving(true)
    let uploadedPath: string | null = null
    try {
      const { error } = await supabase.rpc('update_open_chat_room', { room_uuid: room.room_id, next_title: title.trim(), next_description: description.trim(), next_category: category, next_region: region.trim(), next_notice: notice.trim() })
      if (error) throw error
      let nextCoverPath = room.cover_storage_path
      let nextCoverWidth = room.cover_width
      let nextCoverHeight = room.cover_height
      if (coverPhoto || removeCover) {
        if (coverPhoto) {
          const accountId = await getAccountId(supabase)
          if (!accountId) throw new Error('authentication_required')
          uploadedPath = await uploadOpenChatCover(room.room_id, accountId, coverPhoto.uri, coverPhoto.mimeType)
        }
        const { data: previousPath, error: coverError } = await supabase.rpc('set_open_chat_room_cover', {
          room_uuid: room.room_id, cover_path: uploadedPath,
          image_width: coverPhoto?.width ?? null, image_height: coverPhoto?.height ?? null,
        })
        if (coverError) throw coverError
        nextCoverPath = uploadedPath
        nextCoverWidth = coverPhoto?.width ?? null
        nextCoverHeight = coverPhoto?.height ?? null
        if (previousPath && previousPath !== uploadedPath) await removeOpenChatCover(String(previousPath))
      }
      onSaved({ ...room, title: title.trim(), description: description.trim(), category, region: region.trim() || null, notice: notice.trim(), cover_storage_path: nextCoverPath, cover_width: nextCoverWidth, cover_height: nextCoverHeight, cover_url: getOpenChatCoverUrl(nextCoverPath) })
      close()
    } catch (editError) { if (uploadedPath) await removeOpenChatCover(uploadedPath); Alert.alert('방 정보를 수정하지 못했습니다', messageOf(editError, '잠시 후 다시 시도해 주세요.')) }
    finally { setSaving(false) }
  }
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}><SafeAreaView style={styles.flex}><KeyboardAvoidingView testID="open-chat-edit-keyboard-viewport" style={styles.flex} enabled behavior="padding" keyboardVerticalOffset={0}><ScrollView style={styles.flex} contentContainerStyle={styles.form} automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}><View style={styles.modalHeader}><Pressable onPress={close}><Text style={styles.cancel}>취소</Text></Pressable><Text style={styles.modalTitle}>방 정보 관리</Text><Pressable onPress={() => void save()} disabled={saving}><Text style={styles.save}>{saving ? '저장 중' : '저장'}</Text></Pressable></View>
    <Text style={styles.label}>대표사진</Text>{coverPhoto || (!removeCover && room.cover_url) ? <View style={styles.coverPickerPreview}><Image source={{ uri: coverPhoto?.uri ?? room.cover_url! }} resizeMode="cover" style={styles.coverPickerImage} /><View style={styles.coverPickerOverlay}><Pressable onPress={() => void chooseCover()} style={styles.coverPickerOverlayButton}><Text style={styles.coverPickerOverlayText}>사진 변경</Text></Pressable><Pressable onPress={() => { setCoverPhoto(null); setRemoveCover(true) }} style={styles.coverPickerOverlayButton}><Text style={styles.coverPickerOverlayText}>제거</Text></Pressable></View></View> : <Pressable onPress={() => void chooseCover()} style={styles.coverPickerEmpty}><Text style={styles.coverPickerIcon}>▧</Text><Text style={styles.coverPickerTitle}>대표사진 선택</Text></Pressable>}
    <Text style={styles.label}>방 제목</Text><TextInput value={title} onChangeText={setTitle} maxLength={40} style={styles.input} />
    <Text style={styles.label}>설명</Text><TextInput value={description} onChangeText={setDescription} maxLength={120} multiline style={[styles.input, styles.multiline]} />
    <Text style={styles.label}>카테고리</Text><View style={styles.chips}>{categories.map(item => <Pressable key={item} onPress={() => setCategory(item)} style={[styles.chip, category === item && styles.chipActive]}><Text style={[styles.chipText, category === item && styles.chipTextActive]}>{item}</Text></Pressable>)}</View>
    <Text style={styles.label}>지역</Text><TextInput value={region} onChangeText={setRegion} maxLength={40} style={styles.input} />
    <Text style={styles.label}>공지</Text><TextInput value={notice} onChangeText={setNotice} maxLength={500} multiline placeholder="비워두면 공지가 표시되지 않습니다." style={[styles.input, styles.noticeInput]} />
  </ScrollView></KeyboardAvoidingView></SafeAreaView></Modal>
}

function ParticipantSheet({ participant, visible, currentUserId, isOwner, roomId, onClose, onDismiss, onChanged, onRequest, onReport, onBlocked }: {
  participant: Participant | null; visible: boolean; currentUserId: string | null; isOwner: boolean; roomId: string; onClose: () => void; onChanged: () => void;
  onDismiss: () => void;
  onRequest: (participant: Participant) => void; onReport: (participant: Participant) => void; onBlocked: (userId: string) => void
}) {
  const [profilePhotoVisible, setProfilePhotoVisible] = useState(false)
  useEffect(() => { if (participant) logOpenChatDiagnostic('OPEN_CHAT_REQUEST_DETAIL_OPEN') }, [participant?.user_id])
  useEffect(() => { setProfilePhotoVisible(false) }, [participant?.user_id])
  if (!participant) return null
  const age = new Date().getFullYear() - participant.birth_year
  const kick = () => Alert.alert(`${participant.nickname}님을 내보낼까요?`, '강퇴 후에는 이 방에 다시 입장할 수 없습니다.', [
    { text: '취소', style: 'cancel' },
    { text: '강퇴', style: 'destructive', onPress: async () => {
      if (!supabase) return
      const { error } = await supabase.rpc('kick_open_chat_member', { room_uuid: roomId, member_uuid: participant.user_id })
      if (error) Alert.alert('강퇴 실패', messageOf(error, '다시 시도해 주세요.'))
      else { onClose(); onChanged() }
    } },
  ])
  const transfer = () => Alert.alert('방장 권한 넘기기', `${participant.nickname}님에게 방장 권한을 넘기시겠습니까?`, [
    { text: '취소', style: 'cancel' },
    { text: '넘기기', onPress: async () => {
      if (!supabase) return
      const { error } = await supabase.rpc('transfer_open_chat_ownership', { room_uuid: roomId, new_owner_uuid: participant.user_id })
      if (error) Alert.alert('권한 이전 실패', messageOf(error, '다시 시도해 주세요.'))
      else { onClose(); onChanged() }
    } },
  ])
  const block = () => Alert.alert(`${participant.nickname}님을 차단할까요?`, '기존 사용자 차단 정책이 적용됩니다.', [
    { text: '취소', style: 'cancel' },
    { text: '차단', style: 'destructive', onPress: async () => {
      if (!supabase || !currentUserId) return
      const { error } = await supabase.from('blocks').insert({ blocker_id: currentUserId, blocked_id: participant.user_id })
      if (error && error.code !== '23505') Alert.alert('차단 실패', error.message)
      else { onBlocked(participant.user_id); onClose() }
    } },
  ])
  const canManage = isOwner && participant.user_id !== currentUserId
  const request = () => {
    logOpenChatDiagnostic('OPEN_CHAT_REQUEST_BUTTON_PRESS')
    if (!participant.user_id.trim()) {
      logOpenChatDiagnostic('OPEN_CHAT_REQUEST_TARGET_INVALID')
      Alert.alert('대화 신청 대상 오류', '참여자 정보를 확인하지 못했습니다. 참여자 목록을 새로고침한 뒤 다시 시도해 주세요.')
      return
    }
    onRequest(participant)
  }
  const content = <View style={styles.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel="참여자 상세 닫기" testID="open-chat-participant-detail-backdrop" style={styles.sheetBackdrop} onPress={onClose} />
      <View testID="open-chat-participant-detail-sheet" style={styles.sheet}>
      <View style={styles.profileRow}>{participant.avatar_url ? <Pressable accessibilityRole="imagebutton" accessibilityLabel={`${participant.nickname}님의 프로필 사진 크게 보기`} hitSlop={7} onPress={() => setProfilePhotoVisible(true)}><Avatar participant={participant} size={58} /></Pressable> : <Avatar participant={participant} size={58} />}<View><Text style={styles.profileName}>{participant.is_owner ? '👑 ' : ''}{participant.nickname}</Text><Text style={styles.profileMeta}>{participant.gender ?? '비공개'} · {age}세</Text></View></View>
      {participant.user_id !== currentUserId && <Pressable accessibilityRole="button" accessibilityLabel={`${participant.nickname}님에게 대화 신청`} testID="open-chat-participant-request-button" style={styles.sheetAction} onPressIn={() => logOpenChatDiagnostic('OPEN_CHAT_REQUEST_BUTTON_PRESS_IN')} onPress={request}><Text style={styles.actionText}>대화 신청</Text></Pressable>}
      {participant.user_id !== currentUserId && <Pressable style={styles.sheetAction} onPress={() => { onClose(); onReport(participant) }}><Text style={styles.actionText}>사용자 신고</Text></Pressable>}
      {participant.user_id !== currentUserId && <Pressable style={styles.sheetAction} onPress={block}><Text style={styles.danger}>사용자 차단</Text></Pressable>}
      {canManage && <Pressable style={styles.sheetAction} onPress={transfer}><Text style={styles.actionText}>방장 넘기기</Text></Pressable>}
      {canManage && <Pressable style={styles.sheetAction} onPress={kick}><Text style={styles.danger}>강퇴 및 재입장 제한</Text></Pressable>}
      <Pressable style={styles.sheetClose} onPress={onClose}><Text style={styles.sheetCloseText}>닫기</Text></Pressable>
      </View>
      <ChatProfilePhotoViewer visible={profilePhotoVisible} uri={participant.avatar_url} nickname={participant.nickname} embedded onClose={() => setProfilePhotoVisible(false)} />
    </View>
  // Android does not dispatch Modal.onDismiss. Keeping this sheet in the room's
  // existing native window also avoids racing a closing participants Modal with
  // a newly opened native Modal. iOS keeps its proven page-sheet transition.
  if (Platform.OS === 'android') return visible ? <View testID="open-chat-participant-detail-inline" accessibilityViewIsModal style={styles.inlineDialogLayer}>{content}</View> : null
  return <Modal testID="open-chat-participant-detail-modal" visible={visible} transparent animationType="fade" onDismiss={onDismiss} onRequestClose={onClose}>{content}</Modal>
}

function OpenChatRoom({ room, currentUserId, onClose }: { room: Room; currentUserId: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const [roomDetails, setRoomDetails] = useState(room)
  const [messages, setMessages] = useState<Message[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set())
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  useRefreshPerfScreen('OpenChatRoom', messages, !loading, messages.length, room.room_id)
  const [participantsVisible, setParticipantsVisible] = useState(false)
  const [roomInfoVisible, setRoomInfoVisible] = useState(false)
  const [roomMenuVisible, setRoomMenuVisible] = useState(false)
  const [openChatNotificationsEnabled, setOpenChatNotificationsEnabled] = useState<boolean | null>(null)
  const [savingOpenChatNotifications, setSavingOpenChatNotifications] = useState(false)
  const [editVisible, setEditVisible] = useState(false)
  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null)
  const [participantDetailVisible, setParticipantDetailVisible] = useState(false)
  const [requestParticipant, setRequestParticipant] = useState<Participant | null>(null)
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  const [messageActionTarget, setMessageActionTarget] = useState<Message | null>(null)
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)
  const [activeAudioMessageId, setActiveAudioMessageId] = useState<number | null>(null)
  const [pendingPhoto, setPendingPhoto] = useState<ImagePickerAsset | null>(null)
  const [messagePhoto, setMessagePhoto] = useState<{ uri: string; title: string } | null>(null)
  const [voiceComposerExpanded, setVoiceComposerExpanded] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const exitAlertShown = useRef(false)
  const membershipSeen = useRef(false)
  const lastOwnerId = useRef(room.owner_user_id)
  const stopRecordingRef = useRef<() => Promise<void>>(async () => undefined)
  const closingRef = useRef(false)
  const messageListRef = useRef<FlatList<Message>>(null)
  const participantActionAfterDismissRef = useRef<Participant | null>(null)
  const directRequestAfterDismissRef = useRef<Participant | null>(null)
  const owner = participants.find(item => item.is_owner)
  const isOwner = owner?.user_id === currentUserId
  const messageMap = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const displayMessages = useMemo(() => [...messages].reverse(), [messages])
  const closeRoom = useCallback(async () => {
    if (closingRef.current) return
    closingRef.current = true
    Keyboard.dismiss()
    await stopRecordingRef.current()
    setKeyboardVisible(false)
    setActiveAudioMessageId(null)
    onClose()
  }, [onClose])

  const openUserActions = useCallback((participant: Participant) => {
    setSelectedParticipant(participant)
    setParticipantDetailVisible(true)
  }, [])

  const openUserActionsFromParticipantList = useCallback((participant: Participant) => {
    logOpenChatDiagnostic('OPEN_CHAT_REQUEST_PARTICIPANT_PRESS', { canRequest: participant.user_id !== currentUserId })
    if (Platform.OS === 'android') {
      setParticipantsVisible(false)
      openUserActions(participant)
      return
    }
    participantActionAfterDismissRef.current = participant
    setParticipantsVisible(false)
  }, [currentUserId, openUserActions])

  const finishParticipantListDismiss = useCallback(() => {
    const participant = participantActionAfterDismissRef.current
    participantActionAfterDismissRef.current = null
    if (participant) openUserActions(participant)
  }, [openUserActions])

  const closeParticipantDetail = useCallback(() => {
    setParticipantDetailVisible(false)
    // React Native only dispatches Modal.onDismiss on iOS.
    if (Platform.OS !== 'ios') setSelectedParticipant(null)
  }, [])

  const openDirectRequest = useCallback((participant: Participant) => {
    if (!participant.user_id.trim()) {
      logOpenChatDiagnostic('OPEN_CHAT_REQUEST_TARGET_INVALID')
      Alert.alert('대화 신청 대상 오류', '참여자 정보를 확인하지 못했습니다. 참여자 목록을 새로고침한 뒤 다시 시도해 주세요.')
      return
    }
    Keyboard.dismiss()
    directRequestAfterDismissRef.current = participant
    setParticipantDetailVisible(false)
    logOpenChatDiagnostic('OPEN_CHAT_REQUEST_DETAIL_CLOSE')
    if (Platform.OS !== 'ios') {
      // Android does not emit Modal.onDismiss. Render the composer now; its
      // bounded focus retries wait out the native fade/window handoff.
      directRequestAfterDismissRef.current = null
      setSelectedParticipant(null)
      setRequestParticipant(participant)
      logOpenChatDiagnostic('OPEN_CHAT_REQUEST_TARGET_SET')
    }
  }, [])

  const finishParticipantDetailDismiss = useCallback(() => {
    const participant = directRequestAfterDismissRef.current
    directRequestAfterDismissRef.current = null
    setSelectedParticipant(null)
    if (!participant) return
    setRequestParticipant(participant)
    logOpenChatDiagnostic('OPEN_CHAT_REQUEST_TARGET_SET')
  }, [])

  const handleRoomRequestClose = useCallback(() => {
    if (requestParticipant) { setRequestParticipant(null); return }
    if (participantDetailVisible) { closeParticipantDetail(); return }
    void closeRoom()
  }, [closeParticipantDetail, closeRoom, participantDetailVisible, requestParticipant])

  useEffect(() => {
    if (requestParticipant) logOpenChatDiagnostic('OPEN_CHAT_REQUEST_COMPOSER_OPEN')
  }, [requestParticipant?.user_id])

  const keepLatestMessageAboveKeyboard = useCallback(() => {
    messageListRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])

  const loadOpenChatNotificationSetting = useCallback(async (showError = false) => {
    try {
      const preferences = await loadNotificationPreferences()
      setOpenChatNotificationsEnabled(preferences.open_chat_enabled)
    } catch (reason) {
      captureAppError(reason, 'open_chat', 'load_notification_setting', { roomId: room.room_id })
      if (showError) Alert.alert('알림 설정 오류', messageOf(reason, '다시 시도해 주세요.'))
    }
  }, [room.room_id])

  const openRoomMenu = () => {
    Keyboard.dismiss()
    setRoomMenuVisible(true)
    void loadOpenChatNotificationSetting(true)
  }

  const toggleOpenChatNotifications = async () => {
    if (savingOpenChatNotifications || openChatNotificationsEnabled === null) return
    const previous = openChatNotificationsEnabled
    setSavingOpenChatNotifications(true)
    setOpenChatNotificationsEnabled(!previous)
    try {
      // Reload the shared preference object so changing this room-menu switch
      // never overwrites newer message, preview, sound, or vibration choices.
      const current = await loadNotificationPreferences()
      const next = { ...current, open_chat_enabled: !previous }
      await saveNotificationPreferences(next)
      setOpenChatNotificationsEnabled(next.open_chat_enabled)
    } catch (reason) {
      setOpenChatNotificationsEnabled(previous)
      captureAppError(reason, 'open_chat', 'save_notification_setting', { roomId: room.room_id })
      Alert.alert('알림 설정 저장 실패', messageOf(reason, '다시 시도해 주세요.'))
    } finally {
      setSavingOpenChatNotifications(false)
    }
  }

  useEffect(() => {
    if (!messages.length || loading) return
    keepLatestMessageAboveKeyboard()
  }, [keepLatestMessageAboveKeyboard, loading, messages.length])

  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', event => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardVisible(true)
      keepLatestMessageAboveKeyboard()
    })
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', event => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardVisible(false)
    })
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [keepLatestMessageAboveKeyboard])

  const roomRefresh = useMemo(() => createRefreshQueue(async isCurrent => {
    if (!supabase) return
    const perf = startRefreshPerf('OpenChatRoom')
    try {
      const [messageResult, participantResult, blockedResult] = await Promise.all([
        // Read the newest window; reverse below for chronological history. ID breaks timestamp ties.
        perf.step('messages', () => supabase!.from('open_chat_messages').select('*').eq('room_id', room.room_id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(300)),
        perf.step('participants', () => supabase!.rpc('open_chat_participant_profiles', { room_uuid: room.room_id })),
        perf.step('blocks', () => supabase!.rpc('my_blocked_users')),
      ])
      if (messageResult.error) throw messageResult.error
      if (participantResult.error) throw participantResult.error
      const nextParticipants = (participantResult.data ?? []) as Participant[]
      const nextMessages = await Promise.all(((messageResult.data ?? []) as Message[]).slice().reverse().map(async message => message.image_storage_path
        ? { ...message, image_url: await createOpenChatPhotoUrl(message.image_storage_path) }
        : message))
      if (!isCurrent()) return
      perf.mark('images ready')
      setMessages(nextMessages)
      setParticipants(nextParticipants)
      if (!blockedResult.error) setBlockedUserIds(new Set((blockedResult.data ?? []).map((item: { blocked_id: string }) => item.blocked_id)))
      if (currentUserId && nextParticipants.some(item => item.user_id === currentUserId)) membershipSeen.current = true
      else if (currentUserId && membershipSeen.current && !exitAlertShown.current) {
        exitAlertShown.current = true
        void stopRecordingRef.current()
        Alert.alert('수다방에서 나왔습니다', '더 이상 이 방의 참여자가 아닙니다.', [{ text: '확인', onPress: () => { void closeRoom() } }])
      }
      setLoading(false)
      perf.mark('state ready')
    } finally { perf.end() }
  }), [closeRoom, currentUserId, room.room_id])
  const refresh = roomRefresh.run

  useEffect(() => {
    void refresh().catch(reason => { setLoading(false); Alert.alert('방을 불러오지 못했습니다', messageOf(reason, '다시 시도해 주세요.')) })
    if (!supabase) return
    const client = supabase
    let realtimeConnected = false
    const channel = client.channel(`open-chat:${room.room_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'open_chat_messages', filter: `room_id=eq.${room.room_id}` }, () => void refresh().catch(reason => captureAppError(reason, 'open_chat', 'refresh_messages')))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'open_chat_participants', filter: `room_id=eq.${room.room_id}` }, () => void refresh().catch(() => { void closeRoom() }))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'open_chat_rooms', filter: `id=eq.${room.room_id}` }, payload => {
        const nextRoom = payload.new as Partial<Room> & { id?: string; status?: string }
        if (nextRoom.status === 'closed') {
          logOpenChatDiagnostic('OPEN_CHAT_ROOM_CLOSED')
          void stopRecordingRef.current()
          if (!exitAlertShown.current) { exitAlertShown.current = true; Alert.alert('종료된 수다방입니다', '', [{ text: '확인', onPress: () => { void closeRoom() } }]) }
          return
        }
        if (nextRoom.owner_user_id && nextRoom.owner_user_id !== lastOwnerId.current) {
          logOpenChatDiagnostic('OPEN_CHAT_OWNER_CHANGED', { becameCurrentUser: nextRoom.owner_user_id === currentUserId })
          if (nextRoom.owner_user_id === currentUserId) Alert.alert('새로운 방장이 되었습니다', '기존 방장이 나가 회원님이 새로운 방장이 되었습니다.')
          lastOwnerId.current = nextRoom.owner_user_id
        }
        setRoomDetails(current => ({ ...current, ...nextRoom, room_id: current.room_id }))
        void refresh().catch(reason => captureAppError(reason, 'open_chat', 'refresh_room'))
      })
    if (currentUserId) channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'open_chat_room_bans', filter: `user_id=eq.${currentUserId}` }, payload => {
      if ((payload.new as { room_id?: string }).room_id !== room.room_id || exitAlertShown.current) return
      exitAlertShown.current = true
      logOpenChatDiagnostic('OPEN_CHAT_USER_KICKED')
      void stopRecordingRef.current()
      Alert.alert('방에서 내보내졌습니다', '방장에 의해 수다방에서 내보내졌습니다.', [{ text: '확인', onPress: () => { void closeRoom() } }])
    })
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        realtimeConnected = true
        logOpenChatDiagnostic('OPEN_CHAT_REALTIME_CONNECTED')
        // Recover events missed before subscription or while disconnected. This
        // only reads history; opening/reconnecting never changes membership.
        void refresh().catch(reason => captureAppError(reason, 'open_chat', 'refresh_reconnected'))
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (realtimeConnected || status !== 'CLOSED') logOpenChatDiagnostic('OPEN_CHAT_REALTIME_DISCONNECTED', { status })
        realtimeConnected = false
      }
    })
    return () => {
      roomRefresh.cancel()
      if (realtimeConnected) logOpenChatDiagnostic('OPEN_CHAT_REALTIME_DISCONNECTED', { status: 'ROOM_UNMOUNT' })
      realtimeConnected = false
      void client.removeChannel(channel)
    }
  }, [closeRoom, currentUserId, refresh, room.room_id, roomRefresh])

  const choosePhoto = async () => {
    if (sending) return
    Keyboard.dismiss()
    try {
      const selected = await pickOpenChatPhoto()
      if (!selected) return
      if (selected.fileSize && selected.fileSize > OPEN_CHAT_IMAGE_MAX_BYTES) {
        Alert.alert('사진이 너무 커요', '8MB 이하의 사진을 선택해 주세요.')
        return
      }
      setPendingPhoto(selected)
      keepLatestMessageAboveKeyboard()
    } catch (reason) {
      captureAppError(reason, 'open_chat_photo', 'pick')
      Alert.alert('사진을 선택하지 못했어요', messageOf(reason, '잠시 후 다시 시도해 주세요.'))
    }
  }

  const send = async () => {
    if (!supabase || !currentUserId || sending || (!body.trim() && !pendingPhoto)) return
    setSending(true)
    const content = body.trim()
    const selectedPhoto = pendingPhoto
    const target = replyTarget
    let uploadedPath: string | null = null
    setBody('')
    setPendingPhoto(null)
    try {
      if (selectedPhoto) {
        uploadedPath = await uploadOpenChatPhoto(room.room_id, currentUserId, selectedPhoto.uri, selectedPhoto.mimeType)
        const { error } = await supabase.rpc('create_open_chat_image_message', {
          room_uuid: room.room_id,
          image_path: uploadedPath,
          image_width: selectedPhoto.width,
          image_height: selectedPhoto.height,
          text_content: content || null,
          reply_message_id: target?.id ?? null,
        })
        if (error) throw error
        logOpenChatDiagnostic('OPEN_CHAT_MESSAGE_INSERT_SUCCESS', { messageType: 'image', hasReply: Boolean(target) })
      } else {
        const { error } = await supabase.rpc('create_open_chat_message', {
          room_uuid: room.room_id,
          message_kind: 'text',
          text_content: content,
          audio_path: null,
          duration_ms: null,
          reply_message_id: target?.id ?? null,
        })
        if (error) throw error
        logOpenChatDiagnostic('OPEN_CHAT_MESSAGE_INSERT_SUCCESS', { messageType: 'text', hasReply: Boolean(target) })
      }
      setReplyTarget(null)
    } catch (reason) {
      logOpenChatDiagnostic('OPEN_CHAT_MESSAGE_INSERT_FAILURE', { messageType: selectedPhoto ? 'image' : 'text' })
      if (uploadedPath) await removeUnsentOpenChatPhoto(uploadedPath)
      setBody(content)
      setPendingPhoto(selectedPhoto)
      captureAppError(reason, selectedPhoto ? 'open_chat_photo' : 'open_chat', 'send', { roomId: room.room_id })
      Alert.alert(selectedPhoto ? '사진 전송 실패' : '메시지 전송 실패', messageOf(reason, '다시 시도해 주세요.'))
    } finally {
      setSending(false)
    }
  }

  const sendVoice = async (uri: string, durationMs: number) => {
    if (!supabase || !currentUserId || sending) throw new Error('voice_send_unavailable')
    setSending(true)
    let path: string | null = null
    try {
      path = await uploadOpenChatAudio(room.room_id, currentUserId, uri)
      const { error } = await supabase.rpc('create_open_chat_message', {
        room_uuid: room.room_id,
        message_kind: 'audio',
        text_content: null,
        audio_path: path,
        duration_ms: durationMs,
        reply_message_id: replyTarget?.id ?? null,
      })
      if (error) throw error
      logOpenChatDiagnostic('OPEN_CHAT_MESSAGE_INSERT_SUCCESS', { messageType: 'audio', hasReply: Boolean(replyTarget), durationMs })
      setReplyTarget(null)
    } catch (reason) {
      logOpenChatDiagnostic('OPEN_CHAT_MESSAGE_INSERT_FAILURE', { messageType: 'audio' })
      if (path) await removeUnsentOpenChatAudio(path)
      captureAppError(reason, 'open_chat_audio', 'send', { roomId: room.room_id })
      Alert.alert('음성 메시지 전송 실패', messageOf(reason, '녹음은 유지됩니다. 다시 시도해 주세요.'))
      throw reason
    } finally {
      setSending(false)
    }
  }

  const leave = () => {
    const onlyOwner = isOwner && participants.length === 1
    const warning = isOwner
      ? onlyOwner ? '현재 방에 다른 참여자가 없습니다. 방을 나가면 이 수다방이 종료됩니다.' : '방을 나가면 다른 참여자에게 방장 권한이 자동으로 이전됩니다. 나가시겠습니까?'
      : '이 수다방에서 나가시겠습니까?'
    Alert.alert('방 나가기', warning, [{ text: '취소', style: 'cancel' }, { text: onlyOwner ? '방 나가기' : '나가기', style: 'destructive', onPress: async () => {
      if (!supabase) return
      const { error } = await supabase.rpc('leave_open_chat_room', { room_uuid: room.room_id })
      if (error) Alert.alert('나가기 실패', messageOf(error, '다시 시도해 주세요.'))
      else closeRoom()
    } }])
  }

  const swipeBackEnabled = !participantsVisible && !roomInfoVisible && !roomMenuVisible && !editVisible && !selectedParticipant && !requestParticipant && !reportTarget && !messageActionTarget && !messagePhoto
  if (loading) return <Modal visible animationType="none" presentationStyle="fullScreen" onRequestClose={() => { void closeRoom() }}><SwipeDismissView enterFromRight={false} onDismiss={() => { void closeRoom() }}><ChatRoomSafeArea insets={insets} keyboardVisible={false} style={styles.flex}><View style={styles.center}><ActivityIndicator color="#F26B4B" /></View></ChatRoomSafeArea></SwipeDismissView></Modal>
  return <Modal visible animationType="none" presentationStyle="fullScreen" onShow={() => setKeyboardVisible(false)} onDismiss={() => setKeyboardVisible(false)} onRequestClose={handleRoomRequestClose}><SwipeDismissView enterFromRight={false} enabled={swipeBackEnabled} onDismiss={() => { void closeRoom() }}><View style={styles.flex}>
    <ChatRoomSafeArea insets={insets} keyboardVisible={keyboardVisible} style={styles.flex}>
    <View style={styles.roomHeader}><Pressable onPress={() => { void closeRoom() }} style={styles.headerButton}><Text style={styles.back}>‹</Text></Pressable><View style={styles.roomHeading}><Text numberOfLines={1} style={styles.roomTitle}>{roomDetails.title}</Text><Text style={styles.roomSubtitle}>{participants.length}명 · {owner ? `방장 ${owner.nickname}` : '방 정보 갱신 중'}</Text></View><Pressable onPress={openRoomMenu} style={styles.headerButton}><Text style={styles.people}>☰</Text></Pressable></View>
    {Boolean(roomDetails.notice) && <View style={styles.noticeBanner}><Text style={styles.noticeLabel}>공지</Text><Text numberOfLines={3} style={styles.noticeText}>{roomDetails.notice}</Text></View>}
    <KeyboardAvoidingView testID="open-chat-room-keyboard-viewport" style={styles.flex} enabled behavior="padding" keyboardVerticalOffset={0}>
    <FlatList ref={messageListRef} data={displayMessages} inverted keyExtractor={item => String(item.id)} initialNumToRender={18} maxToRenderPerBatch={16} windowSize={9} removeClippedSubviews={Platform.OS !== 'android'} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'} contentContainerStyle={styles.messages} renderItem={({ item }) => {
      if (item.message_type === 'system') return <Text style={styles.systemMessage}>{item.content}</Text>
      const sender = participants.find(person => person.user_id === item.sender_user_id)
      const mine = item.sender_user_id === currentUserId
      const blocked = Boolean(item.sender_user_id && blockedUserIds.has(item.sender_user_id))
      const replied = item.reply_to_message_id ? messageMap.get(item.reply_to_message_id) : null
      const replyBlocked = Boolean(replied?.sender_user_id && blockedUserIds.has(replied.sender_user_id))
      return <Pressable disabled={blocked} onLongPress={() => { Keyboard.dismiss(); setMessageActionTarget(item) }} style={[styles.messageRow, mine && styles.messageMine]}>{!mine && sender && <Pressable accessibilityRole="button" accessibilityLabel={`${sender.nickname}님 사용자 메뉴`} onPress={() => { Keyboard.dismiss(); openUserActions(sender) }}><Avatar participant={sender} size={34} /></Pressable>}<View style={styles.messageBody}><Text testID={`open-chat-message-sender-${item.id}`} style={[styles.sender, mine && styles.senderMine, !mine && sender?.gender === 'male' && styles.nicknameMale, !mine && sender?.gender === 'female' && styles.nicknameFemale]}>{mine ? '나' : sender?.nickname ?? '알 수 없음'}</Text><View style={[styles.bubble, mine && styles.bubbleMine, blocked && styles.blockedBubble]}>
        {item.reply_to_message_id && <View style={[styles.replyQuote, mine && styles.replyQuoteMine]}><Text numberOfLines={2} style={[styles.replyQuoteText, mine && styles.replyQuoteTextMine]}>{!replied ? '원본 메시지를 찾을 수 없습니다.' : replyBlocked ? '차단한 사용자의 메시지' : replied.message_type === 'audio' ? '▶ 음성 메시지' : replied.message_type === 'image' ? '▧ 사진' : replied.content}</Text></View>}
        {blocked ? <Text style={[styles.bubbleText, styles.blockedText]}>차단한 사용자의 메시지입니다.</Text> : item.message_type === 'audio' && item.audio_storage_path && item.audio_duration_ms ? <OpenChatAudioMessage messageId={item.id} path={item.audio_storage_path} durationMs={item.audio_duration_ms} mine={mine} blocked={blocked} activeMessageId={activeAudioMessageId} onActiveMessageChange={setActiveAudioMessageId} /> : item.message_type === 'image' ? <View>{item.image_url ? <Pressable accessibilityRole="imagebutton" accessibilityLabel="수다방 사진 크게 보기" onPress={() => setMessagePhoto({ uri: item.image_url!, title: mine ? '보낸 사진' : `${sender?.nickname ?? '참여자'}님의 사진` })}><Image source={{ uri: item.image_url }} resizeMode="cover" style={[styles.openChatMessageImage, { aspectRatio: Math.min(1.6, Math.max(0.65, (item.image_width ?? 1) / Math.max(1, item.image_height ?? 1))) }]} /></Pressable> : <View style={[styles.openChatMessageImage, styles.openChatMessageImageUnavailable]}><Text style={styles.openChatMessageImageUnavailableText}>사진을 불러오지 못했어요</Text></View>}{item.content && <Text style={[styles.imageCaption, mine && styles.bubbleTextMine]}>{item.content}</Text>}</View> : <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.content}</Text>}
      </View></View></Pressable>
    }} ListEmptyComponent={<Text style={styles.empty}>첫 메시지를 남겨보세요.</Text>} />
    {replyTarget && <View style={styles.replyComposer}><View style={styles.replyComposerText}><Text style={styles.replyComposerLabel}>답장</Text><Text numberOfLines={1} style={styles.replyComposerPreview}>{replyTarget.message_type === 'audio' ? '▶ 음성 메시지' : replyTarget.message_type === 'image' ? '▧ 사진' : replyTarget.content}</Text></View><Pressable onPress={() => setReplyTarget(null)}><Text style={styles.replyClose}>×</Text></Pressable></View>}
    {pendingPhoto && <View style={styles.openChatPendingPhoto}><Image source={{ uri: pendingPhoto.uri }} style={styles.openChatPendingPhotoImage} /><View style={styles.openChatPendingPhotoBody}><Text style={styles.openChatPendingPhotoTitle}>사진 첨부됨</Text><Text style={styles.openChatPendingPhotoHint}>메시지를 적거나 바로 전송할 수 있어요.</Text></View><Pressable accessibilityRole="button" accessibilityLabel="첨부 사진 제거" hitSlop={8} onPress={() => setPendingPhoto(null)} style={styles.openChatPendingPhotoRemove}><Text style={styles.openChatPendingPhotoRemoveText}>×</Text></Pressable></View>}
    <View testID="open-chat-composer" style={styles.composer}>
      {!voiceComposerExpanded && <Pressable accessibilityRole="button" accessibilityLabel="사진 보내기" disabled={sending} onPress={() => void choosePhoto()} style={[styles.composerIconButton, sending && styles.disabled]}><Text style={styles.composerPhotoIcon}>▧</Text></Pressable>}
      {!voiceComposerExpanded && <TextInput value={body} onChangeText={setBody} onFocus={keepLatestMessageAboveKeyboard} maxLength={2000} multiline placeholder="메시지 입력" style={styles.composerInput} />}
      <OpenChatVoiceRecorder disabled={sending || Boolean(pendingPhoto)} onSend={sendVoice} registerStop={handler => { stopRecordingRef.current = handler }} onExpandedChange={setVoiceComposerExpanded} />
      {!voiceComposerExpanded && <Pressable accessibilityRole="button" accessibilityLabel="메시지 전송" disabled={sending || (!body.trim() && !pendingPhoto)} onPress={() => void send()} style={[styles.send, (!body.trim() && !pendingPhoto || sending) && styles.disabled]}><Text style={styles.sendText}>전송</Text></Pressable>}
    </View>
    </KeyboardAvoidingView>
    </ChatRoomSafeArea>
    <Modal visible={Boolean(messageActionTarget)} transparent animationType="fade" onRequestClose={() => setMessageActionTarget(null)}><Pressable style={styles.overlay} onPress={() => setMessageActionTarget(null)}><Pressable style={styles.sheet} onPress={event => event.stopPropagation()}><Text style={styles.profileName}>메시지</Text><Pressable style={styles.sheetAction} onPress={() => { setReplyTarget(messageActionTarget); setMessageActionTarget(null) }}><Text style={styles.actionText}>답장</Text></Pressable>{messageActionTarget?.sender_user_id !== currentUserId && <Pressable style={styles.sheetAction} onPress={() => { const target = messageActionTarget; setMessageActionTarget(null); if (target) setReportTarget({ kind: 'open_chat_message', messageId: target.id, label: '메시지' }) }}><Text style={styles.danger}>메시지 신고</Text></Pressable>}<Pressable style={styles.sheetClose} onPress={() => setMessageActionTarget(null)}><Text style={styles.sheetCloseText}>닫기</Text></Pressable></Pressable></Pressable></Modal>
    <Modal testID="open-chat-participants-modal" visible={participantsVisible} animationType="slide" presentationStyle="pageSheet" onDismiss={finishParticipantListDismiss} onRequestClose={() => setParticipantsVisible(false)}><SafeAreaView edges={['top', 'bottom']} style={styles.participantPage}><View style={[styles.modalHeader, styles.participantHeader]}><Pressable accessibilityRole="button" accessibilityLabel="참여자 보기 닫기" hitSlop={6} onPress={() => setParticipantsVisible(false)} style={styles.participantHeaderSide}><Text style={styles.cancel}>닫기</Text></Pressable><Text style={styles.modalTitle}>참여자 {participants.length}</Text><View style={styles.participantHeaderSide} /></View><FlatList data={participants} keyExtractor={item => item.user_id} contentContainerStyle={styles.participantList} renderItem={({ item }) => { const canRequest = item.user_id !== currentUserId; return <Pressable accessibilityRole="button" accessibilityLabel={canRequest ? `${item.nickname}님 프로필 및 대화 신청` : `${item.nickname}님 내 프로필`} onPress={() => openUserActionsFromParticipantList(item)} style={styles.participantRow}><Avatar participant={item} /><View style={styles.participantNameWrap}><Text testID={`open-chat-participant-name-${item.user_id}`} style={[styles.participantName, item.gender === 'male' && styles.nicknameMale, item.gender === 'female' && styles.nicknameFemale]}>{item.is_owner ? '👑 ' : ''}{item.nickname}</Text><Text style={styles.participantMeta}>{item.gender ?? '비공개'} · {new Date().getFullYear() - item.birth_year}세{item.is_owner ? ' · 방장' : ''}</Text></View>{canRequest ? <View style={styles.participantRequestAction}><Text style={styles.participantRequestText}>대화 신청</Text><Text style={styles.chevron}>›</Text></View> : <Text style={styles.participantSelf}>나</Text>}</Pressable> }} /></SafeAreaView></Modal>
    <Modal visible={roomMenuVisible} transparent animationType="fade" onRequestClose={() => setRoomMenuVisible(false)}><Pressable style={styles.overlay} onPress={() => setRoomMenuVisible(false)}><Pressable testID="open-chat-room-menu" style={styles.sheet} onPress={event => event.stopPropagation()}><Text style={styles.profileName}>{roomDetails.title}</Text><Text style={styles.profileMeta}>{roomDetails.category}{roomDetails.region ? ` · ${roomDetails.region}` : ''}</Text><Pressable testID="open-chat-room-info-action" style={styles.sheetAction} onPress={() => { setRoomMenuVisible(false); setRoomInfoVisible(true) }}><Text style={styles.actionText}>수다방 정보 보기</Text></Pressable><Pressable testID="open-chat-participants-action" style={styles.sheetAction} onPress={() => { setRoomMenuVisible(false); setParticipantsVisible(true) }}><Text style={styles.actionText}>참여자 보기</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={openChatNotificationsEnabled === null ? '알림 설정 확인 중' : openChatNotificationsEnabled ? '수다방 알림 끄기' : '수다방 알림 켜기'} testID="open-chat-notification-toggle" disabled={savingOpenChatNotifications || openChatNotificationsEnabled === null} style={[styles.sheetAction, (savingOpenChatNotifications || openChatNotificationsEnabled === null) && styles.disabled]} onPress={() => { void toggleOpenChatNotifications() }}><Text style={styles.actionText}>{openChatNotificationsEnabled === null ? '알림 설정 확인 중…' : openChatNotificationsEnabled ? '수다방 알림 끄기' : '수다방 알림 켜기'}</Text></Pressable>{isOwner && <Pressable style={styles.sheetAction} onPress={() => { setRoomMenuVisible(false); setEditVisible(true) }}><Text style={styles.actionText}>방 정보 및 공지 관리</Text></Pressable>}{!isOwner && <Pressable style={styles.sheetAction} onPress={() => { setRoomMenuVisible(false); setReportTarget({ kind: 'open_chat_room', label: '수다방' }) }}><Text style={styles.actionText}>방 신고</Text></Pressable>}<Pressable style={styles.sheetAction} onPress={() => { setRoomMenuVisible(false); leave() }}><Text style={styles.danger}>방 나가기</Text></Pressable><Pressable style={styles.sheetClose} onPress={() => setRoomMenuVisible(false)}><Text style={styles.sheetCloseText}>닫기</Text></Pressable></Pressable></Pressable></Modal>
    <RoomPreviewModal room={roomInfoVisible ? { ...roomDetails, member_count: participants.length, owner_nickname: owner?.nickname ?? roomDetails.owner_nickname, is_member: true } : null} informationOnly onClose={() => setRoomInfoVisible(false)} />
    <ParticipantSheet participant={selectedParticipant} visible={participantDetailVisible} currentUserId={currentUserId} isOwner={isOwner} roomId={room.room_id} onClose={closeParticipantDetail} onDismiss={finishParticipantDetailDismiss} onChanged={() => void refresh()} onRequest={openDirectRequest} onReport={participant => setReportTarget({ kind: 'open_chat_user', userId: participant.user_id, label: participant.nickname })} onBlocked={userId => setBlockedUserIds(current => new Set([...current, userId]))} />
    <DirectRequestDialog roomId={room.room_id} participant={requestParticipant} onClose={() => setRequestParticipant(null)} />
    <ReportModal roomId={room.room_id} target={reportTarget} onClose={() => setReportTarget(null)} />
    <EditRoomModal room={roomDetails} visible={editVisible} onClose={() => setEditVisible(false)} onSaved={setRoomDetails} />
    {messagePhoto && <View style={styles.openChatPhotoViewer}><SafeAreaView style={styles.flex}><View style={styles.openChatPhotoViewerHeader}><Text numberOfLines={1} style={styles.openChatPhotoViewerTitle}>{messagePhoto.title}</Text><Pressable accessibilityRole="button" accessibilityLabel="수다방 사진 닫기" onPress={() => setMessagePhoto(null)} style={styles.openChatPhotoViewerClose}><Text style={styles.openChatPhotoViewerCloseText}>닫기</Text></Pressable></View><Image source={{ uri: messagePhoto.uri }} resizeMode="contain" style={styles.openChatPhotoViewerImage} /></SafeAreaView></View>}
  </View></SwipeDismissView></Modal>
}

export function OpenChat() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [sort, setSort] = useState<'popular' | 'latest'>('popular')
  const [loading, setLoading] = useState(true)
  useRefreshPerfScreen('OpenChatList', rooms, !loading, rooms.length)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)
  const [previewRoom, setPreviewRoom] = useState<Room | null>(null)
  const [enteringRoom, setEnteringRoom] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<NativeTextInput>(null)

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    const perf = startRefreshPerf('OpenChatList')
    try {
      const [accountId, result] = await Promise.all([perf.step('account', () => getAccountId(supabase!)), perf.step('rooms', () => supabase!.rpc('list_open_chat_rooms', { sort_by: sort }))])
      if (result.error) throw result.error
      setCurrentUserId(accountId)
      const normalizedRooms: Room[] = (result.data ?? []).map((item: Room) => ({ ...item, member_count: Number(item.member_count), cover_url: getOpenChatCoverUrl(item.cover_storage_path) }))
      setRooms(normalizedRooms)
      setLoading(false); setRefreshing(false)
      return normalizedRooms
    } finally { perf.end() }
  }, [sort])

  useEffect(() => { void load().catch(reason => { setLoading(false); setRefreshing(false); captureAppError(reason, 'open_chat', 'list_rooms') }) }, [load])
  const refreshRooms = async () => {
    if (refreshing) return
    markRefreshNavigation('OpenChatList', 'manual refresh')
    setRefreshing(true)
    try {
      await load()
    } catch (reason) {
      captureAppError(reason, 'open_chat', 'refresh_rooms')
      Alert.alert('수다방을 새로고침하지 못했습니다', messageOf(reason, '잠시 후 다시 시도해 주세요.'))
    } finally {
      setRefreshing(false)
    }
  }
  const performEnter = async (room: Room) => {
    if (!supabase) return
    setEnteringRoom(true)
    try {
      if (!room.is_member) {
        const { error } = await supabase.rpc('join_open_chat_room', { room_uuid: room.room_id })
        if (error) {
          const message = messageOf(error, '잠시 후 다시 시도해 주세요.')
          return Alert.alert('입장할 수 없습니다', message.includes('owner_must_leave_room_first') ? '방장으로 운영 중인 수다방에서 먼저 나간 후 다른 수다방에 입장해 주세요.' : message)
        }
      }
      setRooms(current => current.map(item => item.room_id === room.room_id
        ? { ...item, is_member: true, member_count: item.member_count + (item.is_member ? 0 : 1) }
        : item.is_member ? { ...item, is_member: false, member_count: Math.max(0, item.member_count - 1) } : item))
      setPreviewRoom(null)
      setSelectedRoom({ ...room, is_member: true, member_count: room.member_count + (room.is_member ? 0 : 1) })
    } finally {
      setEnteringRoom(false)
    }
  }
  const enter = (room: Room) => {
    const activeRoom = rooms.find(item => item.is_member && item.room_id !== room.room_id)
    if (!activeRoom) {
      void performEnter(room)
      return
    }
    if (activeRoom.owner_user_id === currentUserId) {
      Alert.alert('다른 수다방에 입장할 수 없습니다', `방장으로 운영 중인 “${activeRoom.title}”에서 먼저 나간 후 다른 수다방에 입장해 주세요.`)
      return
    }
    Alert.alert('기존 수다방에서 나가게 됩니다', `“${room.title}”에 입장하면 현재 참여 중인 “${activeRoom.title}”에서 자동으로 퇴장합니다. 계속할까요?`, [
      { text: '취소', style: 'cancel' },
      { text: '퇴장 후 입장', onPress: () => void performEnter(room) },
    ])
  }
  const created = async (roomId: string) => { setCreating(false); const nextRooms = await load(); const room = nextRooms?.find(item => item.room_id === roomId); if (room) setSelectedRoom(room) }
  const openCreateRoom = () => setCreating(true)
  const toggleSearch = () => {
    if (searchVisible) {
      Keyboard.dismiss()
      setSearchVisible(false)
      setSearchQuery('')
      return
    }
    setSearchVisible(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }
  const roomMap = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('ko-KR')
    if (!query) return rooms
    return rooms.filter(room => [
      room.title,
      room.description,
      room.category,
      room.region ?? '',
      room.owner_nickname,
      ...room.tags,
    ].join(' ').toLocaleLowerCase('ko-KR').includes(query))
  }, [rooms, searchQuery])
  const activeRoom = rooms.find(room => room.is_member) ?? null

  if (selectedRoom) return <OpenChatRoom room={selectedRoom} currentUserId={currentUserId} onClose={() => { setSelectedRoom(null); void load() }} />
  return <View style={styles.flex}>
    <View style={styles.pageHeader}><View><Text style={styles.pageTitle}>수다방</Text><Text style={styles.pageSubtitle}>함께 이야기할 방을 찾아보세요</Text></View><View testID="open-chat-header-actions" style={styles.headerActions}><Pressable accessibilityRole="button" accessibilityLabel="수다방 새로고침" accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing} onPress={() => void refreshRooms()} style={({ pressed }) => [styles.refreshButton, pressed && !refreshing && styles.headerButtonPressed]}>{refreshing ? <ActivityIndicator size="small" color="#F26B4B" /> : <Text style={styles.refreshIcon}>↻</Text>}</Pressable><Pressable accessibilityRole="button" accessibilityLabel="수다방 만들기" onPress={openCreateRoom} style={({ pressed }) => [styles.createButton, pressed && styles.headerButtonPressed]}><Text style={styles.createButtonText}>방 만들기</Text></Pressable></View></View>
    <View testID="open-chat-sort-bar" style={[styles.sortBar, searchVisible && styles.sortBarSearchOpen]}>{([['popular', '인기'], ['latest', '최신']] as const).map(([value, label]) => <Pressable key={value} onPress={() => setSort(value)} style={[styles.sort, sort === value && styles.sortActive]}><Text style={[styles.sortText, sort === value && styles.sortTextActive]}>{label}</Text></Pressable>)}<Pressable accessibilityRole="button" accessibilityLabel={searchVisible ? '수다방 검색 닫기' : '수다방 검색'} accessibilityState={{ expanded: searchVisible }} onPress={toggleSearch} style={[styles.sort, styles.searchButton, searchVisible && styles.searchButtonActive]}><Text style={[styles.sortText, styles.searchButtonText, searchVisible && styles.sortTextActive]}>⌕ 검색</Text></Pressable></View>
    {searchVisible && <View testID="open-chat-search-row" style={styles.searchRow}><TextInput ref={searchInputRef} value={searchQuery} onChangeText={setSearchQuery} maxLength={60} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} autoCorrect={false} autoCapitalize="none" placeholder="방 이름, 소개, 카테고리 검색" placeholderTextColor="#A19691" style={styles.searchInput} /><Pressable accessibilityRole="button" accessibilityLabel={searchQuery ? '수다방 검색어 지우기' : '수다방 검색 닫기'} hitSlop={8} onPress={() => searchQuery ? setSearchQuery('') : toggleSearch()} style={styles.searchClear}><Text style={styles.searchClearText}>{searchQuery ? '×' : '닫기'}</Text></Pressable></View>}
    {loading ? <View style={styles.center}><ActivityIndicator color="#F26B4B" /></View> : <FlatList testID="open-chat-room-list" data={roomMap} keyExtractor={item => item.room_id} refreshing={refreshing} onRefresh={() => void refreshRooms()} contentContainerStyle={styles.roomList} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={item.is_member ? `${item.title} 수다방 바로 열기` : `${item.title} 방 정보 보기`} onPress={() => { Keyboard.dismiss(); item.is_member ? setSelectedRoom(item) : setPreviewRoom(item) }} style={styles.roomCard}>{item.cover_url ? <Image source={{ uri: item.cover_url }} resizeMode="cover" style={styles.roomCardCover} /> : <View style={[styles.roomCardCover, styles.roomCardCoverPlaceholder]}><Text style={styles.roomCardCoverIcon}>☁</Text><Text style={styles.roomCardCoverCategory}>{item.category}</Text></View>}<View style={styles.roomCardContent}><View style={styles.roomCardTop}><Text style={styles.category}>{item.category}</Text>{item.region && <Text numberOfLines={1} style={styles.region}>· {item.region}</Text>}<Text style={styles.memberCount}>{item.member_count}/{item.max_members}명</Text></View><Text numberOfLines={1} style={styles.cardTitle}>{item.title}</Text><Text numberOfLines={2} style={styles.cardDescription}>{item.description || '편하게 대화를 시작해 보세요.'}</Text><View style={styles.roomCardBottom}><Text style={styles.recent}>{elapsed(item.recent_message_at ?? item.created_at)}</Text>{item.is_member && <Text style={styles.joined}>참여 중</Text>}</View></View></Pressable>} ListEmptyComponent={<Text style={styles.empty}>{searchQuery.trim() ? `“${searchQuery.trim()}” 검색 결과가 없어요.` : '아직 열린 방이 없어요. 첫 방을 만들어 보세요.'}</Text>} />}
    <CreateRoom visible={creating} activeRoom={activeRoom ? { title: activeRoom.title, isOwner: activeRoom.owner_user_id === currentUserId } : null} onClose={() => setCreating(false)} onCreated={roomId => void created(roomId)} />
    <RoomPreviewModal room={previewRoom} entering={enteringRoom} onClose={() => setPreviewRoom(null)} onEnter={room => void enter(room)} />
  </View>
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#FFF9F5' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pageHeader: { ...mainTabHeaderSpacing, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, pageTitle: { ...mainTabTitleStyle }, pageSubtitle: { ...mainTabSubtitleStyle, color: '#8A7D78' }, headerActions: { marginTop: 3, marginLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, refreshButton: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }, refreshIcon: { color: '#F26B4B', fontSize: 25, lineHeight: 30, fontWeight: '800' }, headerButtonPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] }, createButton: { ...mainTabHeaderActionStyle, width: 78, backgroundColor: '#F26B4B' }, createButtonText: { ...mainTabHeaderActionTextStyle, color: '#FFFFFF' },
  sortBar: { flexDirection: 'row', paddingHorizontal: mainTabListHorizontalInset, gap: 8, paddingBottom: mainTabListTopGap }, sortBarSearchOpen: { paddingBottom: 10 }, sort: { minHeight: 36, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 20, backgroundColor: '#F0EAE6', alignItems: 'center', justifyContent: 'center' }, sortActive: { backgroundColor: '#F26B4B' }, sortText: { color: '#756762', fontWeight: '800' }, sortTextActive: { color: 'white' }, searchButton: { marginLeft: 'auto', minWidth: 74, borderWidth: 1, borderColor: '#E3D8D3', backgroundColor: '#FFFDFC' }, searchButtonActive: { borderColor: '#F26B4B', backgroundColor: '#F26B4B' }, searchButtonText: { fontSize: 12 }, searchRow: { minHeight: 46, marginHorizontal: mainTabListHorizontalInset, marginBottom: mainTabListTopGap, paddingLeft: 14, paddingRight: 5, borderRadius: 14, borderWidth: 1, borderColor: '#E8DDD8', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center' }, searchInput: { flex: 1, height: 44, paddingVertical: 0, paddingHorizontal: 0, color: '#302A28', fontSize: 14 }, searchClear: { minWidth: 44, minHeight: 38, alignItems: 'center', justifyContent: 'center' }, searchClearText: { color: '#E85D3B', fontSize: 13, fontWeight: '900' },
  roomList: { paddingHorizontal: mainTabListHorizontalInset, paddingTop: 0, paddingBottom: 110, gap: 12 }, roomCard: { minHeight: 126, flexDirection: 'row', backgroundColor: 'white', borderRadius: 19, padding: 10, gap: 12, borderWidth: 1, borderColor: '#F0E3DD', shadowColor: '#7A5143', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, roomCardCover: { width: 106, minHeight: 106, borderRadius: 14, backgroundColor: '#F4E9E3' }, roomCardCoverPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE9DF' }, roomCardCoverIcon: { color: '#F26B4B', fontSize: 27 }, roomCardCoverCategory: { color: '#B75C45', fontSize: 11, fontWeight: '900', marginTop: 5 }, roomCardContent: { flex: 1, paddingVertical: 3 }, roomCardTop: { flexDirection: 'row', alignItems: 'center' }, category: { color: '#F26B4B', fontWeight: '900', fontSize: 12 }, region: { flexShrink: 1, color: '#9A8D87', fontSize: 12, marginLeft: 5 }, memberCount: { marginLeft: 'auto', color: '#6D625E', fontSize: 12, fontWeight: '800' }, cardTitle: { marginTop: 8, fontSize: 17, fontWeight: '900', color: '#302A28' }, cardDescription: { color: '#756B67', marginTop: 4, lineHeight: 18, fontSize: 12 }, roomCardBottom: { flexDirection: 'row', marginTop: 'auto', paddingTop: 7 }, recent: { color: '#AAA09B', fontSize: 11 }, joined: { marginLeft: 'auto', color: '#F26B4B', fontSize: 11, fontWeight: '900' }, empty: { textAlign: 'center', color: '#968A85', padding: 48, lineHeight: 22 },
  form: { padding: 18, paddingBottom: 50 }, createRoomTitle: { color: '#302A28', fontSize: 25, fontWeight: '900', marginTop: 5 }, createRoomSubtitle: { color: '#81746F', fontSize: 13, lineHeight: 19, marginTop: 7, marginBottom: 5 }, createRoomFooter: { backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2', paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, flexDirection: 'row', gap: 9 }, createRoomCancelButton: { flex: 1, minHeight: 50, borderRadius: 15, backgroundColor: '#E7E5E4', alignItems: 'center', justifyContent: 'center' }, createRoomCancelText: { color: '#57534E', fontSize: 14, fontWeight: '900' }, createRoomSubmitButton: { flex: 2, minHeight: 50, borderRadius: 15, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, createRoomSubmitText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, modalHeader: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#F0E6E1', marginBottom: 18 }, modalTitle: { fontSize: 17, fontWeight: '900', color: '#302A28' }, cancel: { color: '#756B67', fontWeight: '700' }, save: { color: '#F26B4B', fontWeight: '900' }, label: { marginTop: 16, marginBottom: 7, fontWeight: '900', color: '#4B403C' }, input: { minHeight: 48, borderWidth: 1, borderColor: '#E8DDD8', borderRadius: 13, backgroundColor: 'white', paddingHorizontal: 13, color: '#302A28' }, multiline: { minHeight: 78, paddingTop: 12, textAlignVertical: 'top' }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: '#F0EAE6' }, chipActive: { backgroundColor: '#F26B4B' }, chipText: { color: '#756B67', fontWeight: '800' }, chipTextActive: { color: 'white' }, capacityStepper: { minHeight: 64, flexDirection: 'row', alignItems: 'stretch', borderWidth: 1, borderColor: '#E8DDD8', borderRadius: 16, backgroundColor: '#FFFFFF', overflow: 'hidden' }, capacityStepButton: { width: 64, minHeight: 62, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF4EF' }, capacityStepButtonPressed: { backgroundColor: '#FFE2D7' }, capacityStepButtonDisabled: { backgroundColor: '#F5F2F0' }, capacityStepSymbol: { color: '#E85D3B', fontSize: 28, lineHeight: 32, fontWeight: '700' }, capacityStepSymbolDisabled: { color: '#C9C1BD' }, capacityValue: { flex: 1, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#EFE5E0' }, capacityValueNumber: { color: '#302A28', fontSize: 20, lineHeight: 24, fontWeight: '900' }, capacityValueHint: { color: '#9A8D87', fontSize: 10, lineHeight: 14, marginTop: 2 }, capacityHelp: { color: '#948782', fontSize: 11, lineHeight: 16, marginTop: 6 },
  coverPickerEmpty: { minHeight: 88, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: '#E4CFC5', borderRadius: 16, backgroundColor: '#FFFDFB' }, coverPickerIcon: { color: '#F26B4B', fontSize: 26 }, coverPickerTitle: { color: '#493D39', fontWeight: '900' }, coverPickerHint: { color: '#948782', fontSize: 11, marginTop: 4 }, coverPickerPreview: { height: 172, borderRadius: 17, overflow: 'hidden', backgroundColor: '#EEE7E2' }, coverPickerImage: { width: '100%', height: '100%' }, coverPickerOverlay: { position: 'absolute', right: 10, bottom: 10, flexDirection: 'row', gap: 7 }, coverPickerOverlayButton: { minHeight: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: 'rgba(32,24,21,0.76)', alignItems: 'center', justifyContent: 'center' }, coverPickerOverlayText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  roomPreviewPage: { flex: 1, backgroundColor: '#FFF9F5' }, roomPreviewHeader: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F0E6E1', paddingHorizontal: 12 }, roomPreviewClose: { width: 64, minHeight: 44, justifyContent: 'center' }, roomPreviewCloseText: { color: '#756B67', fontWeight: '800' }, roomPreviewHeaderTitle: { flex: 1, textAlign: 'center', color: '#302A28', fontSize: 16, fontWeight: '900' }, roomPreviewHeaderSpace: { width: 64 }, roomPreviewContent: { paddingBottom: 24 }, roomPreviewCover: { width: '100%', aspectRatio: 1.55, backgroundColor: '#F3E8E2' }, roomCoverPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE9DF' }, roomCoverPlaceholderIcon: { color: '#F26B4B', fontSize: 48 }, roomCoverPlaceholderText: { color: '#A5523E', fontWeight: '900', marginTop: 8 }, roomPreviewBody: { padding: 20 }, roomPreviewBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 7 }, roomPreviewCategory: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', backgroundColor: '#F26B4B', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 }, roomPreviewRegion: { color: '#756B67', fontSize: 12, fontWeight: '800' }, roomPreviewJoined: { marginLeft: 'auto', color: '#F26B4B', fontSize: 12, fontWeight: '900' }, roomPreviewTitle: { color: '#302A28', fontSize: 25, lineHeight: 31, fontWeight: '900', marginTop: 14 }, roomPreviewDescription: { color: '#6F625D', fontSize: 14, lineHeight: 21, marginTop: 8 }, roomPreviewStats: { flexDirection: 'row', gap: 8, marginTop: 20 }, roomPreviewStat: { flex: 1, minHeight: 70, padding: 10, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F0E3DD' }, roomPreviewStatLabel: { color: '#9A8D87', fontSize: 10 }, roomPreviewStatValue: { color: '#433A37', fontSize: 12, fontWeight: '900', marginTop: 7 }, roomPreviewTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 16 }, roomPreviewTag: { color: '#C4553B', fontSize: 12, fontWeight: '800', backgroundColor: '#FFF0E9', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 13 }, roomPreviewNotice: { marginTop: 18, padding: 14, borderRadius: 14, backgroundColor: '#FFF0E9' }, roomPreviewNoticeLabel: { color: '#E85D3B', fontSize: 12, fontWeight: '900' }, roomPreviewNoticeText: { color: '#5C4D47', fontSize: 12, lineHeight: 18, marginTop: 5 }, roomPreviewFooter: { padding: 14, backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2' }, roomPreviewEnter: { minHeight: 52, borderRadius: 16, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, roomPreviewEnterText: { color: '#FFFFFF', fontWeight: '900' },
  inlineDialogLayer: { ...StyleSheet.absoluteFillObject, zIndex: 90, elevation: 24 }, dialogKeyboardAvoider: { flex: 1, justifyContent: 'flex-end' }, dialogScroll: { flex: 1 }, dialogScrollContent: { flexGrow: 1, justifyContent: 'flex-end' }, dialog: { margin: 18, padding: 20, borderRadius: 20, backgroundColor: 'white' }, dialogTitle: { fontSize: 19, fontWeight: '900', color: '#302A28' }, dialogDescription: { color: '#81746F', fontSize: 13, lineHeight: 19, marginTop: 7, marginBottom: 14 }, requestInput: { minHeight: 100, paddingTop: 12, textAlignVertical: 'top' }, counter: { alignSelf: 'flex-end', color: '#A19691', fontSize: 11, marginTop: 5 }, dialogActions: { flexDirection: 'row', gap: 8, marginTop: 16 }, secondaryButton: { flex: 1, minHeight: 46, borderRadius: 13, backgroundColor: '#F0EAE6', alignItems: 'center', justifyContent: 'center' }, secondaryButtonText: { color: '#645853', fontWeight: '900' }, primaryAction: { flex: 1.5, minHeight: 46, borderRadius: 13, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, primaryActionText: { color: 'white', fontWeight: '900' }, reportReasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, reportReason: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 16, backgroundColor: '#F0EAE6' }, reportReasonActive: { backgroundColor: '#F26B4B' }, reportReasonText: { color: '#645853', fontSize: 12, fontWeight: '800' }, reportReasonTextActive: { color: 'white' }, reportDetails: { minHeight: 76, marginTop: 14, paddingTop: 11, textAlignVertical: 'top' }, noticeInput: { minHeight: 110, paddingTop: 12, textAlignVertical: 'top' },
  roomHeader: { minHeight: 62, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#F0E6E1', flexDirection: 'row', alignItems: 'center' }, headerButton: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }, back: { fontSize: 38, color: '#F26B4B', lineHeight: 42 }, people: { fontSize: 21, color: '#594D49' }, roomHeading: { flex: 1, alignItems: 'center' }, roomTitle: { fontSize: 17, fontWeight: '900', color: '#302A28' }, roomSubtitle: { fontSize: 11, color: '#948782', marginTop: 2 },
  noticeBanner: { marginHorizontal: 12, marginTop: 10, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 13, backgroundColor: '#FFF0E9', flexDirection: 'row', gap: 9 }, noticeLabel: { color: '#E85D3B', fontWeight: '900', fontSize: 12 }, noticeText: { flex: 1, color: '#5C4D47', fontSize: 12, lineHeight: 17 }, messages: { padding: 14, gap: 14 }, messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, maxWidth: '86%' }, messageMine: { marginLeft: 'auto', flexDirection: 'row-reverse' }, messageBody: { flexShrink: 1 }, sender: { fontSize: 11, color: '#827670', marginBottom: 4 }, senderMine: { textAlign: 'right' }, nicknameMale: { color: '#2563EB' }, nicknameFemale: { color: '#E04468' }, bubble: { backgroundColor: 'white', borderRadius: 16, borderTopLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 9 }, bubbleMine: { backgroundColor: '#F26B4B', borderTopLeftRadius: 16, borderTopRightRadius: 4 }, blockedBubble: { backgroundColor: '#E9E5E3' }, bubbleText: { color: '#382F2C', lineHeight: 19 }, bubbleTextMine: { color: 'white' }, blockedText: { color: '#8D817C', fontStyle: 'italic' }, systemMessage: { alignSelf: 'center', color: '#9A8D87', fontSize: 12, backgroundColor: '#F0EAE6', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  replyQuote: { borderLeftWidth: 3, borderLeftColor: '#F26B4B', backgroundColor: '#FFF4EF', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginBottom: 7 }, replyQuoteMine: { borderLeftColor: 'white', backgroundColor: 'rgba(255,255,255,0.18)' }, replyQuoteText: { color: '#74645E', fontSize: 11, lineHeight: 15 }, replyQuoteTextMine: { color: 'white' },
  replyComposer: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#FFF7F3', borderTopWidth: 1, borderTopColor: '#F0E6E1' }, replyComposerText: { flex: 1 }, replyComposerLabel: { color: '#F26B4B', fontSize: 11, fontWeight: '900' }, replyComposerPreview: { color: '#756B67', fontSize: 12, marginTop: 2 }, replyClose: { color: '#8C7E78', fontSize: 26, paddingHorizontal: 8 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 8, paddingVertical: 8, gap: 6, backgroundColor: 'white', borderTopWidth: 1, borderTopColor: '#F0E6E1' }, composerInput: { flex: 1, maxHeight: 96, minHeight: 38, borderRadius: 19, backgroundColor: '#F5F1EF', paddingHorizontal: 12, paddingVertical: 8 }, composerIconButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#F0EAE6', alignItems: 'center', justifyContent: 'center' }, composerPhotoIcon: { color: '#F26B4B', fontSize: 19, lineHeight: 22, fontWeight: '900' }, send: { minHeight: 36, paddingHorizontal: 11, borderRadius: 18, backgroundColor: '#F26B4B', alignItems: 'center', justifyContent: 'center' }, sendText: { color: 'white', fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.45 },
  openChatPendingPhoto: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#FFF7F3', borderTopWidth: 1, borderTopColor: '#F0E6E1' }, openChatPendingPhotoImage: { width: 48, height: 48, borderRadius: 10, backgroundColor: '#EEE7E2' }, openChatPendingPhotoBody: { flex: 1 }, openChatPendingPhotoTitle: { color: '#433A37', fontSize: 13, fontWeight: '900' }, openChatPendingPhotoHint: { color: '#8D817C', fontSize: 11, marginTop: 3 }, openChatPendingPhotoRemove: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }, openChatPendingPhotoRemoveText: { color: '#8C7E78', fontSize: 25, lineHeight: 28 },
  openChatMessageImage: { width: 210, minHeight: 132, maxHeight: 280, borderRadius: 11, backgroundColor: '#EEE7E2' }, openChatMessageImageUnavailable: { alignItems: 'center', justifyContent: 'center' }, openChatMessageImageUnavailableText: { color: '#8D817C', fontSize: 12 }, imageCaption: { color: '#382F2C', lineHeight: 19, marginTop: 8 }, openChatPhotoViewer: { ...StyleSheet.absoluteFillObject, zIndex: 100, elevation: 20, backgroundColor: '#171311' }, openChatPhotoViewerHeader: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#332B28' }, openChatPhotoViewerTitle: { flex: 1, color: '#FFFFFF', fontWeight: '900' }, openChatPhotoViewerClose: { minWidth: 52, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }, openChatPhotoViewerCloseText: { color: '#FFFFFF', fontWeight: '900' }, openChatPhotoViewerImage: { flex: 1, width: '100%' },
  participantPage: { flex: 1, backgroundColor: '#FFF9F5' }, participantHeader: { marginBottom: 0, paddingHorizontal: 12 }, participantHeaderSide: { width: 68, minHeight: 48, justifyContent: 'center' }, participantList: { paddingHorizontal: 16, paddingBottom: 30 }, participantRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F0E6E1' }, participantNameWrap: { marginLeft: 12, flex: 1 }, participantName: { fontWeight: '900', color: '#352E2B' }, participantMeta: { color: '#948782', fontSize: 12, marginTop: 3 }, participantRequestAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 10 }, participantRequestText: { color: '#F26B4B', fontSize: 12, fontWeight: '900' }, participantSelf: { color: '#A69B96', fontSize: 12, fontWeight: '800', paddingHorizontal: 8 }, chevron: { fontSize: 25, color: '#B4AAA5', marginLeft: 4 }, avatar: { backgroundColor: '#FFE0D5', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: '#C74E34', fontWeight: '900', fontSize: 16 },
  overlay: { flex: 1, backgroundColor: 'rgba(24,18,16,0.36)', justifyContent: 'flex-end' }, sheetBackdrop: { ...StyleSheet.absoluteFillObject, zIndex: 0 }, sheet: { zIndex: 1, backgroundColor: 'white', padding: 20, paddingBottom: 30, borderTopLeftRadius: 22, borderTopRightRadius: 22 }, profileRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingBottom: 16 }, profileName: { fontSize: 19, fontWeight: '900', color: '#302A28' }, profileMeta: { color: '#8D817C', marginTop: 4 }, sheetAction: { minHeight: 50, justifyContent: 'center', borderTopWidth: 1, borderTopColor: '#F0E6E1' }, actionText: { color: '#433A37', fontWeight: '800' }, danger: { color: '#C33F3F', fontWeight: '900' }, sheetClose: { marginTop: 12, minHeight: 48, borderRadius: 13, backgroundColor: '#F0EAE6', alignItems: 'center', justifyContent: 'center' }, sheetCloseText: { color: '#5F544F', fontWeight: '900' },
})

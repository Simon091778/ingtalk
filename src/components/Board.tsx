import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, AppState, Dimensions, FlatList, Image, InputAccessoryView, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Text, TextInput } from '../i18n/localizedUi'
import { DropdownChevron } from './DropdownChevron'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SafeAreaView as InsetSafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { BoardPhotoPermissionError, pickBoardPhoto, uploadBoardPhoto } from '../lib/boardPhoto'
import { supabase } from '../lib/supabase'
import { addAppBreadcrumb, captureAppError } from '../lib/observability'
import { elapsedFromIso } from '../lib/displayFormat'
import { publicContentErrorMessage } from '../lib/contentModeration'
import { formatDateTime, useI18n } from '../i18n'
import { boardAliasDisplayName } from '../lib/boardAlias'

const BOARD_COMPOSER_ACCESSORY_ID = 'ingtalk-board-composer-actions'
const boardFilters = ['전체', '인기'] as const
type BoardFilter = typeof boardFilters[number]
type BoardCountryFilter = 'ALL' | 'KR' | 'US' | 'OTHER'

type BoardPost = {
  id: string
  author_id: string
  nickname: string
  gender: string | null
  country_code: 'KR' | 'US' | 'OTHER'
  title: string
  body: string
  image_url: string | null
  created_at: string
  comment_count: number
  view_count: number
  like_count: number
  liked_by_me: boolean
  dislike_count: number
  disliked_by_me: boolean
}

type BoardComment = {
  id: string
  author_id: string
  nickname: string
  gender: string | null
  body: string
  created_at: string
  like_count: number
  liked_by_me: boolean
  parent_id: string | null
  parent_nickname: string | null
  reply_to_id: string | null
  reply_to_nickname: string | null
}

type BoardRequestTarget = {
  postId: string
  authorId: string
  nickname: string
  topic: string
  contentType: 'post' | 'comment'
  contentId: string
}

function elapsed(value: string) {
  return elapsedFromIso(value)
}

function anonymousColor(gender: string | null) {
  return gender === 'male' ? '#60A5FA' : gender === 'female' ? '#FB7185' : '#CBD5E1'
}

function BoardImageViewer({ uri, onClose, embedded = false }: { uri: string | null; onClose: () => void; embedded?: boolean }) {
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
    scale.value = 1
    savedScale.value = 1
    translateX.value = 0
    translateY.value = 0
    savedTranslateX.value = 0
    savedTranslateY.value = 0
    dismissTranslateY.value = 0
    dismissing.value = false
  }, [uri])

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
  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }))
  const viewerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dismissTranslateY.value }] }))

  if (!uri) return null
  const viewer = <Animated.View style={[styles.boardImageViewerFrame, embedded && styles.boardImageViewerEmbedded, viewerStyle]}><SafeAreaView style={styles.boardImageViewerSafe}>
        <View style={styles.boardImageViewerHeader}><View style={styles.boardImageViewerHeading}><Text style={styles.boardImageViewerTitle}>게시글 사진</Text><Text style={styles.boardImageViewerHint}>두 손가락으로 확대 · 한 손가락으로 이동 · 두 번 탭</Text></View><Pressable accessibilityRole="button" accessibilityLabel="사진 닫기" style={styles.boardImageViewerClose} onPress={onClose}><Text style={styles.boardImageViewerCloseText}>닫기</Text></Pressable></View>
        <GestureDetector gesture={gestures}><Animated.View style={styles.boardImageViewerArea}><Animated.Image source={{ uri }} resizeMode="contain" style={[styles.boardImageViewerImage, imageStyle]} /></Animated.View></GestureDetector>
      </SafeAreaView></Animated.View>
  if (embedded) return viewer
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.flex}>
      {viewer}
    </GestureHandlerRootView>
  </Modal>
}

function BoardRequestComposer({ target, onClose }: { target: BoardRequestTarget | null; onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const messageInputRef = useRef<TextInput>(null)
  const androidFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => setMessage(''), [target?.postId, target?.authorId])
  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true))
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false))
    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])
  useEffect(() => () => {
    if (androidFocusTimerRef.current) clearTimeout(androidFocusTimerRef.current)
  }, [])

  const submit = async () => {
    if (!supabase || !target || !message.trim() || submitting) return
    setSubmitting(true)
    const { error } = await supabase.rpc('create_board_chat_request', {
      post_uuid: target.postId,
      receiver_uuid: target.authorId,
      opening_text: message.trim(),
    })
    setSubmitting(false)
    if (error) {
      captureAppError(error, 'chat_request', 'send', { source: 'board' })
      const messageText = error.message.includes('request_already_exists') ? '이미 이 사용자에게 대화를 신청했어요.' : error.message.includes('insufficient_points') ? '포인트가 부족해요. 대화를 신청하려면 100P가 필요합니다.' : error.message.includes('cannot_request_self') ? '본인에게는 대화를 신청할 수 없어요.' : error.message.includes('function') || error.message.includes('schema cache') ? '게시판 대화 신청 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message
      Alert.alert('신청하지 못했어요', messageText)
      return
    }
    addAppBreadcrumb('chat_request_sent', { source: 'board' })
    Alert.alert('대화 신청 완료', '상대방이 수락하면 채팅방이 열립니다.')
    onClose()
  }

  const renderSubmitButton = (keyboardAction = false) => <Pressable disabled={!message.trim() || submitting} onPress={submit} style={[styles.requestButton, keyboardAction && styles.requestKeyboardButton, (!message.trim() || submitting) && styles.disabled]}><Text style={styles.requestButtonText}>{submitting ? '신청 중…' : '대화 신청 보내기 · 100P'}</Text></Pressable>

  return <Modal visible={target !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} onShow={() => {
    if (Platform.OS !== 'android') return
    if (androidFocusTimerRef.current) clearTimeout(androidFocusTimerRef.current)
    androidFocusTimerRef.current = setTimeout(() => messageInputRef.current?.focus(), 300)
  }}>
    <SafeAreaView style={[styles.safe, styles.boardDarkPage]}>
      <View style={[styles.modalHeader, styles.boardDarkHeader]}><Pressable style={styles.headerActionButton} hitSlop={6} onPress={onClose}><Text style={[styles.close, styles.boardAccentText]}>취소</Text></Pressable><Text style={[styles.modalTitle, styles.boardDarkTitle]}>대화 신청</Text><View style={styles.spacer} /></View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
      <View style={styles.requestComposer}>
        <View style={styles.requestAvatar}><Text style={[styles.requestAvatarText, { color: anonymousColor(null) }]}>{target?.nickname[0]}</Text></View>
        <Text style={[styles.requestName, styles.boardDarkTitle]}>{target?.nickname}님에게</Text>
        <Text numberOfLines={2} style={[styles.requestTopic, styles.boardDarkMuted]}>{target?.topic}</Text>
        <Text style={[styles.requestLabel, styles.boardDarkBody]}>첫 인사를 함께 보내주세요</Text>
        <TextInput ref={messageInputRef} value={message} onChangeText={setMessage} multiline maxLength={200} autoFocus={Platform.OS === 'ios'} showSoftInputOnFocus inputAccessoryViewID={Platform.OS === 'ios' ? 'board-request-keyboard-action' : undefined} placeholder="편하게 대화를 시작해 보세요." placeholderTextColor="#7F8B93" style={[styles.requestInput, styles.boardDarkInput]} />
        <Text style={styles.counter}>{message.length}/200</Text>
        {!keyboardVisible && renderSubmitButton()}
      </View>
      {Platform.OS === 'android' && keyboardVisible && <View style={[styles.requestKeyboardAction, styles.boardDarkHeader]}>{renderSubmitButton(true)}</View>}
      </KeyboardAvoidingView>
      {Platform.OS === 'ios' && <InputAccessoryView nativeID="board-request-keyboard-action"><View style={[styles.requestKeyboardAction, styles.boardDarkHeader]}>{renderSubmitButton(true)}</View></InputAccessoryView>}
    </SafeAreaView>
  </Modal>
}

function PostDetailHeader({ post, userId, onRequest, onLike, onDislike, onDelete, onImagePress }: { post: BoardPost; userId: string; onRequest: (target: BoardRequestTarget) => void; onLike: (post: BoardPost) => void; onDislike: (post: BoardPost) => void; onDelete: (post: BoardPost) => void; onImagePress: (uri: string) => void }) {
  const i18n = useI18n()
  return <View style={[styles.originalPost, styles.boardDarkFeatured]}>
    <Text style={[styles.originalTitle, styles.boardDarkTitle]}>{post.title}</Text>
    {post.author_id !== userId ? <Pressable onPress={() => onRequest({ postId: post.id, authorId: post.author_id, nickname: post.nickname, topic: post.body, contentType: 'post', contentId: post.id })}><Text style={[styles.postName, styles.detailAuthor, { color: anonymousColor(post.gender) }]}>{post.nickname}</Text></Pressable> : <Text style={[styles.postName, styles.detailAuthor, { color: anonymousColor(post.gender) }]}>{post.nickname}</Text>}
    <View style={styles.detailDateRow}><Text style={styles.originalTime}>{formatDateTime(post.created_at, i18n.language, i18n.country)}</Text>{post.author_id === userId && <Pressable style={styles.detailDeleteButton} hitSlop={8} onPress={() => onDelete(post)}><Text style={styles.detailDeleteText}>삭제</Text></Pressable>}</View>
    <Text style={[styles.originalBody, styles.detailBody, styles.boardDarkBody]}>{post.body}</Text>
    {post.image_url && <Pressable accessibilityRole="imagebutton" accessibilityLabel="게시글 사진 크게 보기" onPress={() => onImagePress(post.image_url!)} style={styles.detailImageButton}><Image source={{ uri: post.image_url }} resizeMode="cover" style={styles.detailImage} /></Pressable>}
    <View style={styles.detailActionRow}><Pressable onPress={() => onLike(post)} style={[styles.detailLikeButton, styles.boardDarkInput, post.liked_by_me && styles.detailLikeButtonActive]}><Text style={[styles.detailLikeIcon, post.liked_by_me && styles.detailLikeTextActive]}>{post.liked_by_me ? '♥' : '♡'}</Text><Text style={[styles.detailLikeText, post.liked_by_me && styles.detailLikeTextActive]}>좋아요 {post.like_count}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="게시글 싫어요" onPress={() => onDislike(post)} style={[styles.detailDislikeButton, styles.boardDarkInput, post.disliked_by_me && styles.detailLikeButtonActive]}><Text style={[styles.detailLikeIcon, post.disliked_by_me && styles.detailLikeTextActive]}>♢</Text><Text style={[styles.detailLikeText, post.disliked_by_me && styles.detailLikeTextActive]}>싫어요 {post.dislike_count}</Text></Pressable></View>
  </View>
}

function CommentSheet({ post, userId, onClose, onChanged, onRequest, onLike, onDislike, onDelete, onImagePress }: { post: BoardPost | null; userId: string; onClose: () => void; onChanged: () => void | Promise<void>; onRequest: (target: BoardRequestTarget) => void; onLike: (post: BoardPost) => void; onDislike: (post: BoardPost) => void; onDelete: (post: BoardPost) => void; onImagePress: (uri: string) => void }) {
  const insets = useSafeAreaInsets()
  const i18n = useI18n()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const [comments, setComments] = useState<BoardComment[]>([])
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [commentKeyboardVisible, setCommentKeyboardVisible] = useState(false)
  const [closingByGesture, setClosingByGesture] = useState(false)
  const [iosPreviewImageUrl, setIosPreviewImageUrl] = useState<string | null>(null)
  const [replyingTo, setReplyingTo] = useState<BoardComment | null>(null)
  const commentInputRef = useRef<TextInput>(null)
  const dismissing = useSharedValue(false)
  const sheetTranslateX = useSharedValue(0)
  const sheetTranslateY = useSharedValue(0)

  useEffect(() => {
    if (!post) return
    dismissing.value = false
    sheetTranslateX.value = 0
    sheetTranslateY.value = 0
    setClosingByGesture(false)
    setIosPreviewImageUrl(null)
    setReplyingTo(null)
    setBody('')
  }, [post?.id])

  const load = useCallback(async (showLoading = true) => {
    if (!supabase || !post) return
    if (showLoading) setLoading(true)
    const { data, error } = await supabase.rpc('list_board_comments', { post_uuid: post.id })
    if (error) Alert.alert('댓글을 불러오지 못했어요', error.message)
    else setComments(((data ?? []) as BoardComment[]).map(item => ({ ...item, nickname: boardAliasDisplayName(item.nickname, i18n.language), parent_nickname: boardAliasDisplayName(item.parent_nickname, i18n.language) || null, reply_to_nickname: boardAliasDisplayName(item.reply_to_nickname, i18n.language) || null, like_count: Number(item.like_count), liked_by_me: Boolean(item.liked_by_me) })))
    if (showLoading) setLoading(false)
  }, [i18n.language, post?.id])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setCommentKeyboardVisible(true))
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setCommentKeyboardVisible(false))
    return () => { shown.remove(); hidden.remove() }
  }, [])
  const addComment = async () => {
    if (!supabase || !post || !userId || !body.trim() || saving) return
    setSaving(true)
    const { error } = replyingTo
      ? await supabase.rpc('create_board_reply', { post_uuid: post.id, parent_comment_uuid: replyingTo.id, comment_body: body.trim() })
      : await supabase.rpc('create_board_comment', { post_uuid: post.id, comment_body: body.trim() })
    if (error) {
      captureAppError(error, 'board_comment', 'create', { postId: post.id })
      Alert.alert('댓글을 등록하지 못했어요', publicContentErrorMessage(error, '댓글을 저장하지 못했습니다.'))
    } else {
      addAppBreadcrumb('board_comment_created')
      setBody('')
      setReplyingTo(null)
      await load()
      onChanged()
    }
    setSaving(false)
  }

  const removeComment = (comment: BoardComment) => Alert.alert('댓글을 삭제할까요?', comments.some(item => item.parent_id === comment.id) ? '이 댓글에 달린 답글도 함께 삭제되며 복구할 수 없습니다.' : '삭제한 댓글은 복구할 수 없습니다.', [
    { text: '취소', style: 'cancel' },
    { text: '삭제', style: 'destructive', onPress: () => { void supabase?.from('board_comments').delete().eq('id', comment.id).then(async ({ error }) => { if (error) Alert.alert('삭제 실패', error.message); else { setReplyingTo(current => current?.id === comment.id ? null : current); await load(); onChanged() } }) } },
  ])

  const toggleCommentLike = async (comment: BoardComment) => {
    if (!supabase) return
    setComments(current => current.map(item => item.id === comment.id ? { ...item, liked_by_me: !item.liked_by_me, like_count: Math.max(0, item.like_count + (item.liked_by_me ? -1 : 1)) } : item))
    const { error } = await supabase.rpc('toggle_board_comment_like', { comment_uuid: comment.id })
    if (error) {
      await load()
      Alert.alert('좋아요를 반영하지 못했어요', error.message.includes('function') || error.message.includes('schema cache') ? '댓글 좋아요 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
    }
  }

  const refreshPostDetails = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([load(false), Promise.resolve(onChanged())])
    } finally {
      setRefreshing(false)
    }
  }

  const beginReply = (comment: BoardComment) => {
    setReplyingTo(comment)
    requestAnimationFrame(() => commentInputRef.current?.focus())
  }

  const rootCommentNumbers = new Map<string, number>()
  let rootCommentCount = 0
  comments.forEach(comment => {
    if (!comment.parent_id) rootCommentNumbers.set(comment.id, ++rootCommentCount)
  })

  const renderCommentComposer = () => <View style={[
    styles.commentComposerWrap,
    styles.boardDarkHeader,
    { paddingBottom: commentKeyboardVisible ? 0 : Math.max(insets.bottom, 10) },
  ]}>
    {replyingTo && <View style={styles.replyingBar}><Text numberOfLines={1} style={styles.replyingText}><Text style={styles.replyingName}>{replyingTo.nickname}</Text>님에게 답글 작성 중</Text><Pressable accessibilityRole="button" accessibilityLabel="답글 작성 취소" hitSlop={8} onPress={() => setReplyingTo(null)}><Text style={styles.replyingCancel}>×</Text></Pressable></View>}
    <View style={[styles.commentBar, styles.boardDarkHeader]}><TextInput ref={commentInputRef} value={body} onChangeText={setBody} maxLength={300} returnKeyType="send" keyboardAppearance="dark" onSubmitEditing={() => void addComment()} placeholder={replyingTo ? `${replyingTo.nickname}님에게 답글` : '댓글을 입력하세요'} placeholderTextColor="#7F8B93" style={[styles.commentInput, styles.boardDarkInput]} /><Pressable disabled={!body.trim() || saving} onPress={addComment} style={[styles.commentSend, styles.boardAccentButton, (!body.trim() || saving) && styles.disabled]}><Text style={styles.commentSendText}>{replyingTo ? '답글' : '등록'}</Text></Pressable></View>
  </View>

  const closeCommentSheet = () => {
    Keyboard.dismiss()
    dismissing.value = false
    sheetTranslateX.value = 0
    sheetTranslateY.value = 0
    onClose()
  }

  const beginGestureDismiss = () => {
    Keyboard.dismiss()
    setClosingByGesture(true)
  }

  const finishGestureDismiss = () => onClose()

  const dismissDownGesture = Gesture.Pan()
    .enabled(iosPreviewImageUrl === null)
    .activeOffsetY(20)
    .failOffsetX([-28, 28])
    .onUpdate(event => {
      if (event.translationY > 0) sheetTranslateY.value = event.translationY
    })
    .onEnd(event => {
      if (event.translationY > 110 || event.velocityY > 850) {
        dismissing.value = true
        runOnJS(beginGestureDismiss)()
        sheetTranslateY.value = withTiming(screenHeight + 40, { duration: 220 }, finished => {
          if (finished) runOnJS(finishGestureDismiss)()
        })
      } else sheetTranslateY.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!dismissing.value && sheetTranslateY.value > 0 && sheetTranslateY.value <= 110) sheetTranslateY.value = withTiming(0, { duration: 180 })
    })

  const dismissRightGesture = Gesture.Pan()
    .enabled(iosPreviewImageUrl === null)
    .activeOffsetX(20)
    .failOffsetY([-28, 28])
    .onUpdate(event => {
      if (event.translationX > 0) sheetTranslateX.value = event.translationX
    })
    .onEnd(event => {
      if (event.translationX > 90 || event.velocityX > 700) {
        dismissing.value = true
        runOnJS(beginGestureDismiss)()
        sheetTranslateX.value = withTiming(screenWidth + 40, { duration: 210 }, finished => {
          if (finished) runOnJS(finishGestureDismiss)()
        })
      } else sheetTranslateX.value = withTiming(0, { duration: 180 })
    })
    .onFinalize(() => {
      if (!dismissing.value && sheetTranslateX.value > 0 && sheetTranslateX.value <= 90) sheetTranslateX.value = withTiming(0, { duration: 180 })
    })

  // Keep downward dismissal on the header so a pull from the list can refresh.
  const postScreenGesture = dismissRightGesture
  const dismissAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: sheetTranslateX.value }, { translateY: sheetTranslateY.value }],
  }))

  return <Modal visible={post !== null} animationType={Platform.OS === 'android' ? 'fade' : closingByGesture ? 'none' : 'slide'} onRequestClose={closeCommentSheet}>
    <GestureHandlerRootView style={styles.flex}>
      <GestureDetector gesture={postScreenGesture}>
        <Animated.View style={[styles.safe, styles.boardDarkPage, { paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 20 : 0) }, dismissAnimatedStyle]}>
      <GestureDetector gesture={dismissDownGesture}><View style={[styles.modalHeader, styles.commentModalHeader, styles.boardDarkHeader]}><Pressable accessibilityRole="button" accessibilityLabel="게시글 화면 닫기" style={[styles.headerActionButton, styles.commentCloseButton]} hitSlop={14} onPress={closeCommentSheet}><Text style={[styles.close, styles.boardAccentText]}>닫기</Text></Pressable><Text style={[styles.modalTitle, styles.boardDarkTitle]}>게시글</Text><Pressable accessibilityRole="button" accessibilityLabel="게시글 새로고침" accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing} onPress={() => void refreshPostDetails()} style={styles.commentHeaderRefreshButton}>{refreshing ? <ActivityIndicator size="small" color="#7DD3FC" /> : <Text style={styles.commentHeaderRefreshIcon}>↻</Text>}</Pressable></View></GestureDetector>
      <KeyboardAvoidingView
        style={[styles.commentKeyboard, styles.boardDarkPage]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {loading ? <View style={styles.center}><ActivityIndicator color="#7DD3FC" /></View> : <FlatList data={comments} keyExtractor={item => item.id} contentContainerStyle={[styles.commentList, { paddingBottom: 18 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} refreshing={refreshing} onRefresh={() => void refreshPostDetails()} alwaysBounceVertical overScrollMode="always" ListHeaderComponent={post ? <><PostDetailHeader post={post} userId={userId} onRequest={onRequest} onLike={onLike} onDislike={onDislike} onDelete={onDelete} onImagePress={Platform.OS === 'ios' ? setIosPreviewImageUrl : onImagePress} /><View accessibilityLabel={i18n.language === 'ko' ? '광고 영역' : 'Advertisement area'} style={styles.boardDetailAdSlot}><View style={styles.boardDetailAdHeader}><Text style={styles.boardDetailAdBadge}>{i18n.language === 'ko' ? '광고' : 'Ad'}</Text></View><View style={styles.boardDetailAdBody}><Text style={styles.boardDetailAdPlaceholder}>{i18n.language === 'ko' ? '광고가 표시되는 영역입니다' : 'Advertisement space'}</Text></View></View><View style={styles.boardDetailCommentDivider}><Text style={styles.boardDetailCommentDividerText}>{i18n.language === 'ko' ? '댓글' : 'Comments'}</Text></View></> : null} ListEmptyComponent={<Text style={[styles.empty, styles.boardDarkMuted]}>첫 댓글을 남겨보세요.</Text>} renderItem={({ item }) => {
          const isReply = Boolean(item.parent_id)
          return <View style={[styles.comment, styles.boardDarkCard, isReply && styles.replyComment]}><View style={styles.commentBadgeRow}><Text style={[styles.commentBadge, styles.boardDarkBadge, isReply && styles.replyBadge]}>{isReply ? item.reply_to_nickname ? `↳ ${item.reply_to_nickname}에게 답글` : '↳ 삭제된 댓글에 답글' : `댓글 ${rootCommentNumbers.get(item.id) ?? ''}`}</Text></View><View style={styles.rowBetween}>{item.author_id !== userId && post ? <Pressable onPress={() => onRequest({ postId: post.id, authorId: item.author_id, nickname: item.nickname, topic: item.body, contentType: 'comment', contentId: item.id })}><Text style={[styles.commentName, styles.selectableName, { color: anonymousColor(item.gender) }]}>{item.nickname}</Text></Pressable> : <Text style={[styles.commentName, { color: anonymousColor(item.gender) }]}>{item.nickname}</Text>}{item.author_id === userId && <Pressable onPress={() => removeComment(item)}><Text style={styles.deleteText}>삭제</Text></Pressable>}</View><Text style={[styles.commentBody, styles.commentBodyOrdered, styles.boardDarkBody]}>{item.body}</Text><View style={styles.commentFooter}><View style={styles.commentFooterActions}><Pressable onPress={() => void toggleCommentLike(item)} style={styles.commentLikeButton}><Text style={[styles.likeIcon, item.liked_by_me && styles.likeIconActive]}>{item.liked_by_me ? '♥' : '♡'}</Text><Text style={[styles.statText, item.liked_by_me && styles.likeTextActive]}>좋아요 {item.like_count}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`${item.nickname}님에게 답글 작성`} onPress={() => beginReply(item)} style={styles.commentReplyButton}><Text style={styles.commentReplyText}>답글</Text></Pressable></View><Text style={styles.commentElapsed}>{elapsed(item.created_at)}</Text></View></View>
        }} />}
        {renderCommentComposer()}
      </KeyboardAvoidingView>
      {Platform.OS === 'ios' && <BoardImageViewer uri={iosPreviewImageUrl} embedded onClose={() => setIosPreviewImageUrl(null)} />}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  </Modal>
}

export function Board() {
  const insets = useSafeAreaInsets()
  const i18n = useI18n()
  const countryLabels: Record<BoardCountryFilter, string> = i18n.language === 'ko'
    ? { ALL: '모든 국가', KR: '한국', US: '미국', OTHER: '그 외' }
    : { ALL: 'All countries', KR: 'South Korea', US: 'United States', OTHER: 'Other regions' }
  const countryShortLabels: Record<BoardCountryFilter, string> = i18n.language === 'ko'
    ? { ALL: '전체', KR: '한국', US: '미국', OTHER: '기타' }
    : { ALL: 'All', KR: 'KR', US: 'US', OTHER: 'Other' }
  const [posts, setPosts] = useState<BoardPost[]>([])
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [composerVisible, setComposerVisible] = useState(false)
  const [selectedPost, setSelectedPost] = useState<BoardPost | null>(null)
  const [requestTarget, setRequestTarget] = useState<BoardRequestTarget | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [imageUri, setImageUri] = useState<string | null>(null)
  const [imageMimeType, setImageMimeType] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [composerKeyboardVisible, setComposerKeyboardVisible] = useState(false)
  const [composerFocusedInput, setComposerFocusedInput] = useState<'title' | 'body'>('title')
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  const [boardFilter, setBoardFilter] = useState<BoardFilter>('전체')
  const [countryFilter, setCountryFilter] = useState<BoardCountryFilter>(i18n.country === 'KR' || i18n.country === 'US' ? i18n.country : 'OTHER')
  const [countryPickerVisible, setCountryPickerVisible] = useState(false)
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<TextInput>(null)

  const visiblePosts = useMemo(() => {
    let filtered: BoardPost[]
    if (boardFilter === '인기') {
      const popularity = (post: BoardPost) => post.like_count * 5 + post.comment_count * 3 + Math.min(post.view_count, 200) * 0.1
      filtered = posts
        .filter(post => post.like_count > 0 || post.comment_count > 0 || post.view_count >= 10)
        .slice()
        .sort((a, b) => popularity(b) - popularity(a) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 30)
    } else filtered = posts

    const query = searchQuery.trim().toLocaleLowerCase('ko-KR')
    if (!query) return filtered
    return filtered.filter(post => `${post.title}\n${post.body}\n${post.nickname}`.toLocaleLowerCase('ko-KR').includes(query))
  }, [boardFilter, posts, searchQuery])

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

  const chooseCountryFilter = () => setCountryPickerVisible(true)

  useEffect(() => setCountryFilter(i18n.country === 'KR' || i18n.country === 'US' ? i18n.country : 'OTHER'), [i18n.country])

  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const shown = Keyboard.addListener('keyboardWillShow', () => setComposerKeyboardVisible(true))
    const hidden = Keyboard.addListener('keyboardWillHide', () => setComposerKeyboardVisible(false))
    return () => { shown.remove(); hidden.remove() }
  }, [])

  const refresh = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.rpc('list_board_posts', { result_limit: 100, country_filter: countryFilter === 'ALL' ? null : countryFilter })
    if (error) Alert.alert('게시판을 불러오지 못했어요', error.message)
    else {
      const nextPosts = ((data ?? []) as BoardPost[]).map(item => ({ ...item, nickname: boardAliasDisplayName(item.nickname, i18n.language), comment_count: Number(item.comment_count), view_count: Number(item.view_count), like_count: Number(item.like_count), liked_by_me: Boolean(item.liked_by_me), dislike_count: Number(item.dislike_count ?? 0), disliked_by_me: Boolean(item.disliked_by_me) }))
      setPosts(nextPosts)
      setSelectedPost(current => current ? nextPosts.find(item => item.id === current.id) ?? null : null)
    }
    setLoading(false)
  }, [countryFilter, i18n.language])

  const refreshBoardList = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    void client.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? ''))
    void refresh()
    const channel = client.channel('board-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_posts' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'board_comments' }, () => void refresh())
      .subscribe()
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh() })
    return () => { subscription.remove(); void client.removeChannel(channel) }
  }, [refresh])

  const addPost = async () => {
    if (!supabase || !userId || !title.trim() || !body.trim() || saving) return
    setSaving(true)
    try {
      const imageUrl = imageUri ? await uploadBoardPhoto(userId, imageUri, imageMimeType) : null
      const { error } = await supabase.rpc('create_board_post', { post_title: title.trim(), post_body: body.trim(), post_image_url: imageUrl })
      if (error) throw error
      setTitle('')
      setBody('')
      setImageUri(null)
      setImageMimeType(null)
      setComposerVisible(false)
      await refresh()
    } catch (reason) {
      const message = publicContentErrorMessage(reason, '사진 또는 게시글을 저장하지 못했습니다.')
      Alert.alert('글을 등록하지 못했어요', message.includes('schema cache') || message.includes('function') ? '게시판 사진 SQL 마이그레이션을 Supabase에 적용해 주세요.' : message)
    }
    setSaving(false)
  }

  const choosePhoto = async () => {
    try {
      const asset = await pickBoardPhoto()
      if (!asset) return
      setImageUri(asset.uri)
      setImageMimeType(asset.mimeType ?? null)
    } catch (reason) {
      if (reason instanceof BoardPhotoPermissionError) {
        Alert.alert('사진 권한이 필요해요', reason.canAskAgain ? '사진을 첨부하려면 사진 보관함 접근을 허용해 주세요.' : '기기 설정에서 잉톡의 사진 권한을 허용해 주세요.', [
          { text: '취소', style: 'cancel' },
          ...(!reason.canAskAgain ? [{ text: '기기 설정', onPress: () => void Linking.openSettings() }] : []),
        ])
      } else Alert.alert('사진을 선택하지 못했어요', reason instanceof Error ? reason.message : '잠시 후 다시 시도해 주세요.')
    }
  }

  const closeComposer = () => {
    if (saving) return
    Keyboard.dismiss()
    setComposerKeyboardVisible(false)
    setComposerVisible(false)
    setComposerFocusedInput('title')
    setTitle('')
    setBody('')
    setImageUri(null)
    setImageMimeType(null)
  }

  const removePost = (post: BoardPost) => Alert.alert('게시글을 삭제할까요?', '게시글과 댓글이 모두 삭제됩니다.', [
    { text: '취소', style: 'cancel' },
    { text: '삭제', style: 'destructive', onPress: () => { void supabase?.from('board_posts').delete().eq('id', post.id).then(async ({ error }) => { if (error) Alert.alert('삭제 실패', error.message); else { setSelectedPost(current => current?.id === post.id ? null : current); await refresh() } }) } },
  ])

  const openPost = (post: BoardPost) => {
    setSelectedPost(post)
    setPosts(current => current.map(item => item.id === post.id ? { ...item, view_count: item.view_count + 1 } : item))
    void supabase?.rpc('increment_board_post_view', { post_uuid: post.id }).then(({ error }) => {
      if (error && !error.message.includes('function')) console.warn('조회수 반영 실패:', error.message)
    })
  }

  const toggleLike = async (post: BoardPost) => {
    if (!supabase) return
    const activating = !post.liked_by_me
    const nextPost = { ...post, liked_by_me: activating, like_count: Math.max(0, post.like_count + (activating ? 1 : -1)), disliked_by_me: activating ? false : post.disliked_by_me, dislike_count: activating && post.disliked_by_me ? Math.max(0, post.dislike_count - 1) : post.dislike_count }
    setPosts(current => current.map(item => item.id === post.id ? nextPost : item))
    setSelectedPost(current => current?.id === post.id ? nextPost : current)
    const { error } = await supabase.rpc('toggle_board_post_like', { post_uuid: post.id })
    if (error) {
      Alert.alert('좋아요를 반영하지 못했어요', error.message.includes('function') || error.message.includes('schema cache') ? '게시판 통계 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
      await refresh()
    }
  }

  const toggleDislike = async (post: BoardPost) => {
    if (!supabase) return
    const activating = !post.disliked_by_me
    const nextPost = { ...post, disliked_by_me: activating, dislike_count: Math.max(0, post.dislike_count + (activating ? 1 : -1)), liked_by_me: activating ? false : post.liked_by_me, like_count: activating && post.liked_by_me ? Math.max(0, post.like_count - 1) : post.like_count }
    setPosts(current => current.map(item => item.id === post.id ? nextPost : item))
    setSelectedPost(current => current?.id === post.id ? nextPost : current)
    const { error } = await supabase.rpc('toggle_board_post_dislike', { post_uuid: post.id })
    if (error) {
      Alert.alert('싫어요를 반영하지 못했어요', error.message.includes('function') || error.message.includes('schema cache') ? '게시글 싫어요 SQL 마이그레이션을 Supabase에 적용해 주세요.' : error.message)
      await refresh()
    }
  }

  const submitBoardReport = async (target: BoardRequestTarget, reasonCode: 'inappropriate' | 'suspected_minor') => {
    if (!supabase) return
    const { error } = await supabase.rpc('report_board_content', {
      content_type: target.contentType,
      content_uuid: target.contentId,
      reason_code: reasonCode,
    })
    if (error) {
      const message = error.message.includes('report_already_exists')
        ? '이미 신고한 게시판 내용입니다.'
        : error.message.includes('function') || error.message.includes('schema cache')
          ? '게시판 신고 SQL 마이그레이션을 Supabase에 적용해 주세요.'
          : error.message
      Alert.alert('신고하지 못했어요', message)
      return
    }
    Alert.alert('신고가 접수되었습니다', '운영자가 해당 내용과 작성자를 확인합니다.')
  }

  const openNicknameMenu = (target: BoardRequestTarget) => {
    const requestAction = { text: '대화 신청', onPress: () => { setSelectedPost(null); setRequestTarget(target) } }
    const reportAction = { text: '신고하기', onPress: () => Alert.alert('신고 사유 선택', `${target.nickname}님의 ${target.contentType === 'post' ? '게시글' : '댓글'} 신고 사유를 선택해 주세요.`, [
        { text: '취소', style: 'cancel' },
        { text: '부적절한 내용', onPress: () => void submitBoardReport(target, 'inappropriate') },
        { text: '미성년자 의심', style: 'destructive', onPress: () => void submitBoardReport(target, 'suspected_minor') },
      ]) }
    Alert.alert(target.nickname, '원하는 기능을 선택해 주세요.', Platform.OS === 'ios'
      ? [{ text: '취소', style: 'cancel' }, requestAction, reportAction]
      : [{ text: '취소', style: 'cancel' }, reportAction, requestAction])
  }

  const renderComposerActions = () => <View style={[
    styles.composerFooter,
    styles.boardDarkHeader,
    Platform.OS === 'ios' && !composerKeyboardVisible && styles.composerFooterIos,
  ]}><Pressable disabled={saving} style={[styles.cancelButton, styles.boardDarkCancel]} onPress={closeComposer}><Text style={[styles.cancelText, styles.boardDarkBody]}>취소</Text></Pressable><Pressable disabled={!title.trim() || !body.trim() || saving} style={[styles.submitButton, styles.boardAccentButton, (!title.trim() || !body.trim() || saving) && styles.disabled]} onPress={addPost}><Text style={styles.submitText}>{saving ? '등록 중…' : '등록'}</Text></Pressable></View>

  return <View style={[styles.page, styles.boardDarkPage]}>
    <View style={styles.header}><View><Text style={[styles.title, styles.boardDarkTitle]}>익명 게시판</Text><Text style={[styles.subtitle, styles.boardDarkMuted]}>익명으로 편하게 이야기를 나눠요</Text></View><View style={styles.boardHeaderActions}><Pressable accessibilityRole="button" accessibilityLabel="게시판 새로고침" accessibilityState={{ busy: refreshing, disabled: refreshing }} disabled={refreshing} onPress={() => void refreshBoardList()} style={({ pressed }) => [styles.boardRefreshButton, pressed && !refreshing && styles.boardHeaderButtonPressed]}>{refreshing ? <ActivityIndicator size="small" color="#7DD3FC" /> : <Text style={styles.boardRefreshIcon}>↻</Text>}</Pressable><Pressable style={({ pressed }) => [styles.writeButton, styles.boardAccentButton, pressed && styles.boardHeaderButtonPressed]} onPress={() => setComposerVisible(true)}><Text style={styles.writeButtonText}>글쓰기</Text></Pressable></View></View>
    <View style={styles.boardFilterArea}>
      <View style={styles.boardFilterBar}><Pressable accessibilityRole="button" accessibilityLabel={`${i18n.language === 'ko' ? '국가 필터' : 'Country filter'}: ${countryLabels[countryFilter]}`} accessibilityState={{ expanded: countryPickerVisible }} onPress={chooseCountryFilter} style={[styles.boardFilterButton, styles.boardCountryButton]}><Text numberOfLines={1} style={[styles.boardFilterText, styles.boardCountryText]}>{i18n.language === 'ko' ? '국가' : 'Country'}·{countryShortLabels[countryFilter]}</Text><DropdownChevron color="#9EABB3" expanded={countryPickerVisible} /></Pressable><Pressable accessibilityRole="button" accessibilityState={{ selected: boardFilter === '전체' }} onPress={() => setBoardFilter('전체')} style={[styles.boardFilterButton, boardFilter === '전체' && styles.boardFilterButtonActive]}><Text style={[styles.boardFilterText, boardFilter === '전체' && styles.boardFilterTextActive]}>전체</Text></Pressable><Pressable accessibilityRole="button" accessibilityState={{ selected: boardFilter === '인기' }} onPress={() => setBoardFilter('인기')} style={[styles.boardFilterButton, boardFilter === '인기' && styles.boardFilterButtonActive]}><Text style={[styles.boardFilterText, boardFilter === '인기' && styles.boardFilterTextActive]}>인기</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={searchVisible ? '게시판 검색 닫기' : '게시판 검색'} accessibilityState={{ expanded: searchVisible }} onPress={toggleSearch} style={[styles.boardFilterButton, styles.boardSearchButton, searchVisible && styles.boardSearchButtonActive]}><Text style={[styles.boardFilterText, styles.boardSearchButtonText, searchVisible && styles.boardFilterTextActive]}>⌕ 검색</Text></Pressable></View>
      {searchVisible && <View style={styles.boardSearchRow}><TextInput ref={searchInputRef} value={searchQuery} onChangeText={setSearchQuery} maxLength={60} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} autoCorrect={false} autoCapitalize="none" keyboardAppearance="dark" placeholder="제목, 내용, 작성자 검색" placeholderTextColor="#7F8B93" style={[styles.boardSearchInput, styles.boardDarkInput]} /><Pressable accessibilityRole="button" accessibilityLabel={searchQuery ? '검색어 지우기' : '검색 닫기'} hitSlop={8} onPress={() => searchQuery ? setSearchQuery('') : toggleSearch()} style={styles.boardSearchClear}><Text style={styles.boardSearchClearText}>{searchQuery ? '×' : '닫기'}</Text></Pressable></View>}
    </View>
    {loading ? <View style={styles.center}><ActivityIndicator color="#7DD3FC" /></View> : <FlatList data={visiblePosts} keyExtractor={item => item.id} contentContainerStyle={styles.postList} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" refreshing={refreshing} onRefresh={() => void refreshBoardList()} alwaysBounceVertical overScrollMode="always" ListEmptyComponent={<Text style={[styles.empty, styles.boardDarkMuted]}>{searchQuery.trim() ? `“${searchQuery.trim()}” 검색 결과가 없어요.` : boardFilter === '인기' ? '아직 인기글이 없어요.' : <>아직 게시글이 없어요.{`\n`}첫 글을 작성해 보세요.</>}</Text>} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.title} 게시글 열기`} onPress={() => openPost(item)} style={({ pressed }) => [styles.post, styles.boardDarkCard, pressed && styles.postPressed]}>
      <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.postHeadline, styles.boardDarkTitle]}>{item.title}</Text><Text numberOfLines={1} ellipsizeMode="tail" style={[styles.postPreview, styles.boardDarkMuted]}>{item.body}</Text>{item.image_url && <Image source={{ uri: item.image_url }} resizeMode="cover" style={styles.postImage} />}
      <View style={styles.authorRow}>{item.author_id !== userId ? <Pressable hitSlop={8} onPress={event => { event.stopPropagation(); openNicknameMenu({ postId: item.id, authorId: item.author_id, nickname: item.nickname, topic: item.body, contentType: 'post', contentId: item.id }) }}><Text style={[styles.postName, styles.selectableName, { color: anonymousColor(item.gender) }]}>{item.nickname}</Text></Pressable> : <Text style={[styles.postName, { color: anonymousColor(item.gender) }]}>{item.nickname}</Text>}{item.author_id === userId && <Pressable hitSlop={10} onPress={event => { event.stopPropagation(); removePost(item) }}><Text style={styles.deleteText}>삭제</Text></Pressable>}</View>
      <View style={[styles.statRow, styles.boardDarkDivider]}><View style={styles.statItem}><Text style={styles.statIcon}>◉</Text><Text style={styles.statText}>{item.view_count}</Text></View><Pressable style={styles.statItem} onPress={event => { event.stopPropagation(); void toggleLike(item) }}><Text style={[styles.likeIcon, item.liked_by_me && styles.likeIconActive]}>{item.liked_by_me ? '♥' : '♡'}</Text><Text style={[styles.statText, item.liked_by_me && styles.likeTextActive]}>{item.like_count}</Text></Pressable><View style={styles.statItem}><Text style={styles.statIcon}>💬</Text><Text style={styles.statText}>{item.comment_count}</Text></View><Text style={styles.elapsedText}>{elapsed(item.created_at)}</Text></View>
    </Pressable>} />}
    <Modal visible={composerVisible} animationType="slide" presentationStyle="fullScreen" onRequestClose={closeComposer}>
      <InsetSafeAreaView edges={['top', 'bottom']} style={[styles.composerSafe, styles.boardDarkPage]}>
        <KeyboardAvoidingView style={[styles.composerContainer, styles.boardDarkPage]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
          <ScrollView style={styles.flex} contentContainerStyle={[styles.composerPage, styles.boardDarkPage, Platform.OS === 'ios' && styles.composerPageIos]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} showsVerticalScrollIndicator={false}>
            <Text style={[styles.composerTitle, styles.boardDarkTitle]}>익명 글쓰기</Text>
            <Text style={[styles.inputLabel, styles.boardDarkBody]}>제목</Text><TextInput value={title} onChangeText={setTitle} onFocus={() => setComposerFocusedInput('title')} maxLength={60} returnKeyType="next" autoCorrect={false} spellCheck={false} autoComplete="off" textContentType="none" keyboardAppearance="dark" inputAccessoryViewID={Platform.OS === 'ios' ? BOARD_COMPOSER_ACCESSORY_ID : undefined} placeholder="제목을 입력하세요." placeholderTextColor="#7F8B93" style={[styles.titleInput, styles.boardDarkInput]} />
            <Text style={[styles.inputLabel, styles.boardDarkBody]}>내용</Text><TextInput value={body} onChangeText={setBody} onFocus={() => setComposerFocusedInput('body')} multiline maxLength={500} keyboardAppearance="dark" placeholder="자유롭게 이야기를 남겨주세요." placeholderTextColor="#7F8B93" style={[styles.postInput, styles.boardDarkInput]} />
            <Text style={styles.counter}>{body.length}/500</Text>
            <Text style={[styles.inputLabel, styles.boardDarkBody]}>사진 (선택)</Text>{imageUri ? <View style={styles.photoPreviewWrap}><Image source={{ uri: imageUri }} resizeMode="cover" style={styles.photoPreview} /><Pressable style={styles.removePhotoButton} onPress={() => { setImageUri(null); setImageMimeType(null) }}><Text style={styles.removePhotoText}>사진 삭제</Text></Pressable></View> : <Pressable style={[styles.photoPickerButton, styles.boardDarkInput]} onPress={() => void choosePhoto()}><Text style={[styles.photoPickerIcon, styles.boardAccentText]}>▧</Text><Text style={[styles.photoPickerText, styles.boardDarkBody]}>사진 첨부</Text></Pressable>}
          </ScrollView>
          {!(Platform.OS === 'ios' && composerKeyboardVisible && composerFocusedInput === 'title') && renderComposerActions()}
        </KeyboardAvoidingView>
        {Platform.OS === 'ios' && <InputAccessoryView nativeID={BOARD_COMPOSER_ACCESSORY_ID}>{renderComposerActions()}</InputAccessoryView>}
      </InsetSafeAreaView>
    </Modal>
    <Modal visible={countryPickerVisible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setCountryPickerVisible(false)}>
      <Pressable style={styles.boardCountryPickerOverlay} onPress={() => setCountryPickerVisible(false)}>
        <Pressable style={styles.boardCountryPickerSheet} onPress={event => event.stopPropagation()}>
          <View style={styles.boardCountryPickerHeader}>
            <View style={styles.boardCountryPickerHeading}>
              <Text style={styles.boardCountryPickerTitle}>{i18n.language === 'ko' ? '국가 선택' : 'Select country'}</Text>
              <Text style={styles.boardCountryPickerDescription}>{i18n.language === 'ko' ? '게시글을 볼 국가를 선택해 주세요.' : 'Choose which country’s posts to view.'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={i18n.language === 'ko' ? '국가 선택 닫기' : 'Close country picker'} hitSlop={10} onPress={() => setCountryPickerVisible(false)} style={styles.boardCountryPickerClose}>
              <Text style={styles.boardCountryPickerCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.boardCountryPickerList} contentContainerStyle={styles.boardCountryPickerListContent} showsVerticalScrollIndicator>
            {(['ALL', 'KR', 'US', 'OTHER'] as BoardCountryFilter[]).map(value => {
              const selected = countryFilter === value
              return <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => { setCountryFilter(value); setCountryPickerVisible(false) }} style={[styles.boardCountryPickerOption, selected && styles.boardCountryPickerOptionActive]}>
                <Text style={[styles.boardCountryPickerOptionText, selected && styles.boardCountryPickerOptionTextActive]}>{countryLabels[value]}</Text>
                {selected && <Text style={styles.boardCountryPickerCheck}>✓</Text>}
              </Pressable>
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
    <CommentSheet post={selectedPost} userId={userId} onClose={() => setSelectedPost(null)} onChanged={refresh} onRequest={openNicknameMenu} onLike={post => void toggleLike(post)} onDislike={post => void toggleDislike(post)} onDelete={removePost} onImagePress={setPreviewImageUrl} />
    <BoardImageViewer uri={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
    <BoardRequestComposer target={requestTarget} onClose={() => setRequestTarget(null)} />
  </View>
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: '#FFF7F9' }, page: { flex: 1, backgroundColor: '#FFF7F9' }, header: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 15, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, title: { color: '#3B1F2B', fontSize: 25, lineHeight: 32, fontWeight: '900', letterSpacing: -0.4 }, subtitle: { color: '#B84A67', fontSize: 12, lineHeight: 17, fontWeight: '700', marginTop: 3 }, boardHeaderActions: { marginTop: 3, marginLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, boardRefreshButton: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' }, boardRefreshIcon: { color: '#7DD3FC', fontSize: 25, lineHeight: 30, fontWeight: '800' }, boardHeaderButtonPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] }, writeButton: { width: 78, height: 40, backgroundColor: '#D94F70', borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#9F2949', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, writeButtonText: { color: '#FFFFFF', fontSize: 13, lineHeight: 18, fontWeight: '900' }, boardFilterArea: { paddingBottom: 16 }, boardFilterBar: { paddingHorizontal: 10, gap: 4, flexDirection: 'row', alignItems: 'center' }, boardFilterButton: { flex: 1, minHeight: 36, borderRadius: 18, borderWidth: 1, borderColor: '#39444C', backgroundColor: '#20272C', alignItems: 'center', justifyContent: 'center' }, boardFilterButtonActive: { borderColor: '#0284A8', backgroundColor: '#0284A8' }, boardFilterText: { color: '#9EABB3', fontSize: 12, fontWeight: '800' }, boardFilterTextActive: { color: '#FFFFFF', fontWeight: '900' }, boardSearchButton: { flex: 1.2, borderColor: '#52616B' }, boardSearchButtonActive: { borderColor: '#38BDF8', backgroundColor: '#075B75' }, boardSearchButtonText: { fontSize: 11 }, boardSearchRow: { minHeight: 46, marginHorizontal: 10, marginTop: 9, paddingLeft: 13, paddingRight: 5, borderRadius: 14, borderWidth: 1, borderColor: '#39444C', backgroundColor: '#20272C', flexDirection: 'row', alignItems: 'center' }, boardSearchInput: { flex: 1, height: 44, paddingVertical: 0, paddingHorizontal: 0, borderWidth: 0, backgroundColor: 'transparent', color: '#F1F5F7', fontSize: 14 }, boardSearchClear: { minWidth: 44, minHeight: 38, alignItems: 'center', justifyContent: 'center' }, boardSearchClearText: { color: '#7DD3FC', fontSize: 13, fontWeight: '900' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, postList: { paddingHorizontal: 20, paddingBottom: 25, flexGrow: 1 }, post: { backgroundColor: '#FFFCFD', borderWidth: 1, borderColor: '#F0D9E1', borderRadius: 20, paddingHorizontal: 17, paddingVertical: 16, marginBottom: 11, shadowColor: '#7B3048', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, postPressed: { opacity: 0.78, transform: [{ scale: 0.995 }] }, postHeadline: { color: '#3B1F2B', fontSize: 17, lineHeight: 24, fontWeight: '900' }, postPreview: { color: '#806B73', fontSize: 13, lineHeight: 20, marginTop: 6 }, authorRow: { minHeight: 27, marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, postName: { color: '#68515A', fontSize: 13, fontWeight: '900' }, postBody: { color: '#3B2730', fontSize: 15, lineHeight: 22, marginTop: 10 }, statRow: { minHeight: 30, flexDirection: 'row', alignItems: 'center', marginTop: 7, borderTopWidth: 1, borderTopColor: '#F5E7EC', paddingTop: 7 }, statItem: { flexDirection: 'row', alignItems: 'center', marginRight: 15, minHeight: 26 }, statIcon: { color: '#AD98A0', fontSize: 13, marginRight: 4 }, likeIcon: { color: '#AD98A0', fontSize: 17, marginRight: 4 }, likeIconActive: { color: '#D94F70' }, statText: { color: '#AD98A0', fontSize: 11, fontWeight: '700' }, likeTextActive: { color: '#D94F70' }, elapsedText: { color: '#AD98A0', fontSize: 11, marginLeft: 'auto' }, commentCount: { color: '#D94F70', fontSize: 11, fontWeight: '800', marginTop: 12 }, deleteText: { color: '#DC2626', fontSize: 11, fontWeight: '800' }, empty: { textAlign: 'center', color: '#A58D96', lineHeight: 21, marginTop: 65 }, overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }, composerScroll: { width: '100%' }, composerScrollContent: { flexGrow: 1, justifyContent: 'center', padding: 22 }, composer: { width: '100%', backgroundColor: '#FFF7F9', borderRadius: 20, padding: 19 }, composerTitle: { color: '#3B1F2B', fontSize: 19, fontWeight: '900', marginBottom: 6 }, inputLabel: { color: '#68515A', fontSize: 12, fontWeight: '800', marginTop: 10, marginBottom: 7 }, titleInput: { height: 48, backgroundColor: '#FFFCFD', borderWidth: 1, borderColor: '#ECD7DE', borderRadius: 13, paddingHorizontal: 14, color: '#3B1F2B', fontSize: 15, fontWeight: '700' }, postInput: { minHeight: 130, backgroundColor: '#FFFCFD', borderWidth: 1, borderColor: '#ECD7DE', borderRadius: 15, padding: 14, textAlignVertical: 'top', color: '#3B1F2B', fontSize: 15 }, counter: { color: '#A58D96', alignSelf: 'flex-end', fontSize: 10, marginTop: 5 }, actions: { flexDirection: 'row', gap: 9, marginTop: 14 }, cancelButton: { flex: 1, minHeight: 48, backgroundColor: '#EFE5E8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' }, cancelText: { color: '#68515A', fontSize: 14, fontWeight: '900' }, submitButton: { flex: 2, backgroundColor: '#D94F70', borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' }, submitText: { color: '#FFFFFF', fontWeight: '900' }, disabled: { opacity: 0.4 }, modalHeader: { height: 64, backgroundColor: '#FFFCFD', borderBottomWidth: 1, borderBottomColor: '#F0DDE3', paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerActionButton: { width: 76, height: 64, justifyContent: 'center', paddingLeft: 10 }, close: { color: '#D94F70', fontSize: 15, fontWeight: '900' }, modalTitle: { color: '#3B1F2B', fontSize: 16, fontWeight: '900' }, spacer: { width: 76 }, commentList: { padding: 18, flexGrow: 1 }, originalPost: { backgroundColor: '#FFF0F4', borderRadius: 17, padding: 17, marginBottom: 16, borderWidth: 1, borderColor: '#F3CBD7', borderLeftWidth: 5, borderLeftColor: '#D94F70' }, originalBadgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, originalBadge: { color: '#FFFFFF', backgroundColor: '#D94F70', borderRadius: 8, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 4, fontSize: 11, fontWeight: '900' }, originalTime: { color: '#A58D96', fontSize: 11 }, originalTitle: { color: '#3B1F2B', fontSize: 19, lineHeight: 27, fontWeight: '900', marginBottom: 10 }, originalBody: { color: '#513A43', fontSize: 15, lineHeight: 23 }, comment: { backgroundColor: '#FFFCFD', borderRadius: 12, paddingHorizontal: 13, paddingVertical: 9, marginBottom: 7, marginLeft: 12, borderWidth: 1, borderColor: '#ECDDE2', borderLeftWidth: 3, borderLeftColor: '#DFC1CA' }, commentBadgeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 }, commentBadge: { color: '#806B73', backgroundColor: '#F8EFF2', borderRadius: 7, overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 2, fontSize: 9, fontWeight: '800' }, commentName: { color: '#806B73', fontSize: 11, fontWeight: '800' }, commentBody: { color: '#3B2730', fontSize: 14, lineHeight: 19 }, commentBar: { backgroundColor: '#FFFCFD', borderTopWidth: 1, borderTopColor: '#F0DDE3', padding: 10, flexDirection: 'row', alignItems: 'center' }, commentInput: { flex: 1, backgroundColor: '#F8EFF2', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: '#3B1F2B' }, commentSend: { backgroundColor: '#D94F70', borderRadius: 18, paddingHorizontal: 15, paddingVertical: 10, marginLeft: 8 }, commentSendText: { color: '#FFFFFF', fontWeight: '900' },
  bodyFirst: { marginTop: 0 }, authorBelow: { marginTop: 10 }, commentBodyOrdered: { marginTop: 5 }, commentFooter: { minHeight: 28, marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, commentLikeButton: { minHeight: 28, flexDirection: 'row', alignItems: 'center' }, commentElapsed: { color: '#7F8B93', fontSize: 10 },
  boardDetailAdSlot: { minHeight: 96, marginBottom: 18, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: '#46525A', backgroundColor: '#1A2025', overflow: 'hidden' }, boardDetailAdHeader: { minHeight: 26, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' }, boardDetailAdBadge: { color: '#94A3B8', fontSize: 9, fontWeight: '800' }, boardDetailAdBody: { flex: 1, minHeight: 68, alignItems: 'center', justifyContent: 'center' }, boardDetailAdPlaceholder: { color: '#66737C', fontSize: 11, fontWeight: '700' }, boardDetailCommentDivider: { marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#333D44', paddingBottom: 8 }, boardDetailCommentDividerText: { color: '#B8C3C9', fontSize: 12, fontWeight: '900' },
  replyComment: { marginLeft: 34, borderLeftColor: '#38BDF8', backgroundColor: '#1C252B' }, replyBadge: { color: '#7DD3FC', backgroundColor: '#26343C' }, commentFooterActions: { flexDirection: 'row', alignItems: 'center', gap: 12 }, commentReplyButton: { minHeight: 28, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' }, commentReplyText: { color: '#7DD3FC', fontSize: 11, fontWeight: '900' }, commentComposerWrap: { borderTopWidth: 1, borderTopColor: '#333D44' }, replyingBar: { minHeight: 34, paddingLeft: 15, paddingRight: 12, backgroundColor: '#202A30', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, replyingText: { flex: 1, color: '#AAB6BD', fontSize: 11 }, replyingName: { color: '#7DD3FC', fontWeight: '900' }, replyingCancel: { color: '#9EABB3', fontSize: 22, lineHeight: 24, fontWeight: '700' },
  composerSafe: { flex: 1, backgroundColor: '#FFF9F5' }, composerContainer: { flex: 1 }, composerPage: { flexGrow: 1, padding: 20, paddingTop: 24, paddingBottom: 28, backgroundColor: '#FFF9F5' }, composerPageIos: { paddingTop: 36 }, composerFooter: { backgroundColor: '#FFF9F5', borderTopWidth: 1, borderTopColor: '#EEE7E2', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, flexDirection: 'row', gap: 9 }, composerFooterIos: { paddingBottom: 22 },
  postImage: { width: '100%', height: 180, borderRadius: 13, backgroundColor: '#F5F5F4', marginTop: 12 },
  detailImageButton: { width: '100%', height: 260, borderRadius: 14, marginTop: 14, overflow: 'hidden' },
  detailImage: { width: '100%', height: '100%', backgroundColor: '#F5F5F4' },
  boardImageViewerFrame: { flex: 1, backgroundColor: 'rgba(0,0,0,0.96)' }, boardImageViewerSafe: { flex: 1 }, boardImageViewerEmbedded: { ...StyleSheet.absoluteFillObject, zIndex: 100, elevation: 100 }, boardImageViewerHeader: { minHeight: 72, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, boardImageViewerHeading: { flex: 1, marginRight: 12 }, boardImageViewerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' }, boardImageViewerHint: { color: '#94A3B8', fontSize: 10, marginTop: 3 }, boardImageViewerClose: { minWidth: 54, minHeight: 42, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' }, boardImageViewerCloseText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' }, boardImageViewerArea: { flex: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, boardImageViewerImage: { width: '100%', height: '100%' },
  photoPickerButton: { minHeight: 54, borderWidth: 1, borderStyle: 'dashed', borderColor: '#D6D3D1', borderRadius: 13, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  photoPickerIcon: { color: '#F26B4B', fontSize: 20, marginRight: 8 },
  photoPickerText: { color: '#57534E', fontSize: 14, fontWeight: '800' },
  photoPreviewWrap: { position: 'relative' },
  photoPreview: { width: '100%', height: 190, borderRadius: 14, backgroundColor: '#F5F5F4' },
  removePhotoButton: { position: 'absolute', right: 9, top: 9, minHeight: 34, borderRadius: 10, backgroundColor: 'rgba(31,41,55,0.82)', paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center' },
  removePhotoText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  commentKeyboard: { flex: 1 }, commentBarOverlay: { position: 'absolute', left: 0, right: 0, zIndex: 20, elevation: 20 }, commentModalHeader: { height: 64 }, commentCloseButton: { width: 104, height: 64, paddingLeft: 18, justifyContent: 'center' }, commentHeaderSpacer: { width: 104 }, commentHeaderRefreshButton: { width: 104, height: 64, paddingRight: 18, alignItems: 'flex-end', justifyContent: 'center' }, commentHeaderRefreshIcon: { color: '#7DD3FC', fontSize: 25, lineHeight: 30, fontWeight: '800' }, selectableName: {}, originalMetaActions: { flexDirection: 'row', alignItems: 'center', gap: 10 }, detailAuthor: { marginTop: 2 }, detailDateRow: { minHeight: 34, marginTop: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, detailBody: { marginTop: 14 }, detailDeleteButton: { minWidth: 48, minHeight: 32, borderRadius: 9, borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }, detailDeleteText: { color: '#DC2626', fontSize: 12, fontWeight: '900' }, detailActionRow: { marginTop: 14, flexDirection: 'row', gap: 9 }, detailLikeButton: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#E7DFDA', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }, detailLikeButtonActive: { borderColor: '#FCA5A5', backgroundColor: '#FFF1F2' }, detailLikeIcon: { color: '#78716C', fontSize: 19, marginRight: 7 }, detailLikeText: { color: '#57534E', fontSize: 13, fontWeight: '800' }, detailLikeTextActive: { color: '#EF4444' }, detailDislikeButton: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }, detailDislikeButtonActive: { borderColor: '#64748B', backgroundColor: '#26313A' }, detailDislikeIcon: { color: '#94A3B8', fontSize: 18, marginRight: 6, fontWeight: '900' }, detailDislikeText: { color: '#94A3B8', fontSize: 13, fontWeight: '800' }, detailDislikeTextActive: { color: '#E2E8F0' }, requestComposer: { flex: 1, padding: 22, alignItems: 'center' }, requestAvatar: { width: 66, height: 66, borderRadius: 33, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center', marginTop: 18 }, requestAvatarText: { fontSize: 24, fontWeight: '900' }, requestName: { color: '#1F2937', fontSize: 19, fontWeight: '900', marginTop: 12 }, requestTopic: { color: '#78716C', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7 }, requestLabel: { color: '#374151', fontSize: 13, fontWeight: '800', alignSelf: 'stretch', marginTop: 27, marginBottom: 9 }, requestInput: { width: '100%', minHeight: 120, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7DFDA', borderRadius: 15, padding: 14, textAlignVertical: 'top', color: '#1F2937', fontSize: 15 }, requestButton: { width: '100%', backgroundColor: '#F26B4B', borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 18 }, requestKeyboardAction: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderTopColor: '#24323B' }, requestKeyboardButton: { marginTop: 0 }, requestButtonText: { color: '#FFFFFF', fontWeight: '900' },
  cleanPage: { backgroundColor: '#F7F9FA' }, cleanCard: { backgroundColor: '#FFFFFF', borderColor: '#E5E7EB', shadowOpacity: 0, elevation: 0 },
  boardCountryButton: { flex: 1.35, paddingHorizontal: 3, borderColor: '#52616B', backgroundColor: '#20272C', flexDirection: 'row' }, boardCountryText: { flexShrink: 1, color: '#B8C3C9', fontSize: 10 },
  boardCountryPickerOverlay: { flex: 1, paddingHorizontal: 22, backgroundColor: 'rgba(0,0,0,0.62)', alignItems: 'center', justifyContent: 'center' },
  boardCountryPickerSheet: { width: '100%', maxWidth: 420, maxHeight: '72%', borderRadius: 22, borderWidth: 1, borderColor: '#39444C', backgroundColor: '#191F24', padding: 18 },
  boardCountryPickerHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }, boardCountryPickerHeading: { flex: 1, paddingRight: 12 },
  boardCountryPickerTitle: { color: '#F1F5F7', fontSize: 19, lineHeight: 26, fontWeight: '900' }, boardCountryPickerDescription: { color: '#9EABB3', fontSize: 12, lineHeight: 18, marginTop: 4 },
  boardCountryPickerClose: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#2A3339', alignItems: 'center', justifyContent: 'center' }, boardCountryPickerCloseText: { color: '#D7DEE3', fontSize: 25, lineHeight: 28 },
  boardCountryPickerList: { flexGrow: 0 }, boardCountryPickerListContent: { gap: 8, paddingBottom: 2 }, boardCountryPickerOption: { minHeight: 50, paddingHorizontal: 15, borderRadius: 14, borderWidth: 1, borderColor: '#39444C', backgroundColor: '#20272C', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, boardCountryPickerOptionActive: { borderColor: '#38BDF8', backgroundColor: '#075B75' }, boardCountryPickerOptionText: { color: '#D7DEE3', fontSize: 14, fontWeight: '800' }, boardCountryPickerOptionTextActive: { color: '#FFFFFF', fontWeight: '900' }, boardCountryPickerCheck: { color: '#7DD3FC', fontSize: 18, fontWeight: '900' },
  boardDarkPage: { backgroundColor: '#151A1E' }, boardDarkHeader: { backgroundColor: '#191F24', borderColor: '#2B343B' }, boardDarkCard: { backgroundColor: '#20272C', borderColor: '#303A41', shadowOpacity: 0, elevation: 0 }, boardDarkFeatured: { backgroundColor: '#20272C', borderColor: '#3B4850', borderLeftColor: '#38BDF8' }, boardDarkTitle: { color: '#F1F5F7' }, boardDarkBody: { color: '#D7DEE3' }, boardDarkMuted: { color: '#9EABB3' }, boardDarkInput: { backgroundColor: '#20272C', borderColor: '#39444C', color: '#F1F5F7' }, boardDarkBadge: { backgroundColor: '#2B353C', color: '#B8C3C9' }, boardDarkDivider: { borderTopColor: '#333D44' }, boardDarkCancel: { backgroundColor: '#2A3339' }, boardAccentButton: { backgroundColor: '#0284A8', shadowOpacity: 0, elevation: 0 }, boardAccentText: { color: '#7DD3FC' },
})

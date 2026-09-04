import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { AdminBoardComment, AdminOpenChatDetail, AdminOpenChatRoom, AdminPublicContent, AdminRole } from './types'

type Area = 'openChat' | 'talk' | 'board'

const formatDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '-'

export function ContentOperationsPage({ role }: { role: AdminRole }) {
  const canModerate = role === 'moderator' || role === 'owner'
  const [area, setArea] = useState<Area>('openChat')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [reason, setReason] = useState('')
  const [rooms, setRooms] = useState<AdminOpenChatRoom[]>([])
  const [contents, setContents] = useState<AdminPublicContent[]>([])
  const [selectedRoom, setSelectedRoom] = useState<AdminOpenChatDetail | null>(null)
  const [selectedContent, setSelectedContent] = useState<AdminPublicContent | null>(null)
  const [comments, setComments] = useState<AdminBoardComment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    if (area === 'openChat') {
      const result = await supabase.rpc('admin_list_open_chat_rooms', {
        search_text: appliedQuery, status_filter: status === 'all' ? null : status, result_limit: 500,
      })
      if (result.error) setError(result.error.message)
      else setRooms((result.data as AdminOpenChatRoom[] | null) ?? [])
    } else {
      const result = await supabase.rpc('admin_list_public_content', {
        content_filter: area === 'talk' ? 'talk' : 'post', search_text: appliedQuery,
        status_filter: area === 'talk' && status !== 'all' ? status : null, result_limit: 500,
      })
      if (result.error) setError(result.error.message)
      else setContents((result.data as AdminPublicContent[] | null) ?? [])
    }
    setLoading(false)
  }, [area, appliedQuery, status])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setStatus('all'); setSelectedRoom(null); setSelectedContent(null); setComments([]) }, [area])

  const search = (event: FormEvent) => { event.preventDefault(); setAppliedQuery(query.trim()) }
  const requireReason = () => {
    if (reason.trim().length >= 2) return true
    setError('조치 사유를 2자 이상 입력해 주세요. 모든 조치는 감사 기록에 남습니다.')
    return false
  }
  const runAction = async (name: string, args: Record<string, unknown>, confirmText: string) => {
    if (!supabase || !requireReason() || !window.confirm(confirmText)) return false
    setLoading(true); setError('')
    const result = await supabase.rpc(name, args)
    setLoading(false)
    if (result.error) { setError(result.error.message); return false }
    setReason(''); await load(); return true
  }
  const openRoom = async (room: AdminOpenChatRoom) => {
    if (!supabase) return
    setLoading(true); setError('')
    const result = await supabase.rpc('admin_get_open_chat_room', { target_room_uuid: room.room_id })
    setLoading(false)
    if (result.error) setError(result.error.message)
    else setSelectedRoom(result.data as AdminOpenChatDetail)
  }
  const refreshRoom = async () => {
    if (!selectedRoom) return
    const summary = rooms.find(room => room.room_id === selectedRoom.room.id)
    if (summary) await openRoom(summary)
    else setSelectedRoom(null)
  }
  const openPost = async (content: AdminPublicContent) => {
    setSelectedContent(content); setComments([])
    if (!supabase || content.content_kind !== 'post') return
    const result = await supabase.rpc('admin_list_board_comments', { target_post_uuid: content.content_id, result_limit: 500 })
    if (result.error) setError(result.error.message)
    else setComments((result.data as AdminBoardComment[] | null) ?? [])
  }

  return <>
    <header className="topbar"><div><p className="eyebrow">CONTENT OPERATIONS</p><h1>콘텐츠 관리</h1><p>수다방, 톡쓰기와 익명게시판을 조회하고 운영 조치를 실행합니다</p></div><button className="refresh" onClick={() => void load()} disabled={loading}>↻ 새로고침</button></header>
    <div className="content-notice">검토자는 조회만 가능하며, 삭제·퇴장·종료 조치는 운영자 이상만 실행할 수 있습니다. 모든 조치는 감사 기록에 남습니다.</div>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
    <div className="content-tabs">
      <button className={area === 'openChat' ? 'active' : ''} onClick={() => setArea('openChat')}>수다방</button>
      <button className={area === 'talk' ? 'active' : ''} onClick={() => setArea('talk')}>톡쓰기</button>
      <button className={area === 'board' ? 'active' : ''} onClick={() => setArea('board')}>익명게시판</button>
    </div>
    <div className="content-toolbar">
      <form onSubmit={search}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="제목, 내용, 닉네임 또는 ID 검색" /><button>검색</button></form>
      {(area === 'openChat' || area === 'talk') && <select aria-label="상태 필터" value={status} onChange={event => setStatus(event.target.value)}><option value="all">전체 상태</option><option value="active">활성</option><option value={area === 'openChat' ? 'closed' : 'inactive'}>{area === 'openChat' ? '종료' : '비활성'}</option></select>}
    </div>
    {canModerate && <label className="content-reason">조치 사유<input value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} placeholder="삭제·종료·퇴장 등의 판단 근거를 입력하세요" /></label>}

    {area === 'openChat' ? <div className="content-layout">
      <section className="content-list">{loading && rooms.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : rooms.length === 0 ? <div className="empty">조건에 맞는 수다방이 없습니다</div> : rooms.map(room => <button key={room.room_id} className={`content-row ${selectedRoom?.room.id === room.room_id ? 'selected' : ''}`} onClick={() => void openRoom(room)}><div><strong>{room.title}</strong><span className={`chat-state ${room.room_status}`}>{room.room_status === 'active' ? '활성' : '종료'}</span></div><p>{room.owner_nickname ?? '종료된 방'} · {room.category}</p><small>참여 {room.member_count}/{room.max_members} · 메시지 {room.message_count} · 신고 {room.report_count}</small><small>최근 대화 {formatDate(room.last_user_message_at)}</small></button>)}</section>
      <section className="content-detail">{!selectedRoom ? <div className="detail-empty"><div className="empty-symbol">♧</div><h3>수다방을 선택해 주세요</h3><p>참여자, 차단 목록과 최근 메시지를 확인할 수 있습니다</p></div> : <>
        <div className="content-detail-head"><div><span className={`chat-state ${selectedRoom.room.status}`}>{selectedRoom.room.status === 'active' ? '활성' : '종료'}</span><h2>{selectedRoom.room.title}</h2><p>{selectedRoom.room.id}</p></div><button onClick={() => setSelectedRoom(null)}>×</button></div>
        <p className="content-body">{selectedRoom.room.description || '방 소개 없음'}</p>
        <div className="content-summary"><span>방장<strong>{selectedRoom.room.owner_nickname ?? '-'}</strong></span><span>최근 대화<strong>{formatDate(selectedRoom.room.last_user_message_at)}</strong></span><span>종료 사유<strong>{selectedRoom.room.closed_reason ?? '-'}</strong></span></div>
        {canModerate && selectedRoom.room.status === 'active' && <button className="content-danger" onClick={async () => { if (await runAction('admin_close_open_chat_room', { target_room_uuid: selectedRoom.room.id, admin_note: reason.trim() }, '이 수다방을 종료하고 모든 참여자를 퇴장시킬까요?')) { setSelectedRoom(null) } }}>수다방 종료·전원 퇴장</button>}
        <h3 className="content-section-title">참여자 {selectedRoom.participants.length}</h3><div className="member-list">{selectedRoom.participants.map(member => <article key={member.user_id}><div><strong>{member.nickname}{member.is_owner ? ' · 방장' : ''}</strong><small>{member.user_id}</small></div>{canModerate && !member.is_owner && <div><button onClick={async () => { if (await runAction('admin_remove_open_chat_member', { target_room_uuid: selectedRoom.room.id, target_user_uuid: member.user_id, block_reentry: false, admin_note: reason.trim() }, `${member.nickname}님을 강제 퇴장시킬까요?`)) await refreshRoom() }}>퇴장</button><button className="danger" onClick={async () => { if (await runAction('admin_remove_open_chat_member', { target_room_uuid: selectedRoom.room.id, target_user_uuid: member.user_id, block_reentry: true, admin_note: reason.trim() }, `${member.nickname}님을 퇴장시키고 재입장을 차단할까요?`)) await refreshRoom() }}>퇴장+차단</button></div>}</article>)}</div>
        {selectedRoom.bans.length > 0 && <><h3 className="content-section-title">재입장 차단 {selectedRoom.bans.length}</h3><div className="member-list">{selectedRoom.bans.map(member => <article key={member.user_id}><div><strong>{member.nickname ?? '탈퇴 사용자'}</strong><small>{member.user_id}</small></div>{canModerate && <button onClick={async () => { if (await runAction('admin_unban_open_chat_member', { target_room_uuid: selectedRoom.room.id, target_user_uuid: member.user_id, admin_note: reason.trim() }, '재입장 차단을 해제할까요?')) await refreshRoom() }}>차단 해제</button>}</article>)}</div></>}
        <h3 className="content-section-title">최근 메시지 {selectedRoom.messages.length}</h3><div className="open-chat-messages">{selectedRoom.messages.map(message => <article className={message.message_type === 'system' ? 'system' : ''} key={message.id}><div><strong>{message.sender_nickname ?? '시스템'}</strong><time>{formatDate(message.created_at)}</time></div><p>{message.message_type === 'audio' ? `음성 메시지 · ${message.audio_duration_ms ?? 0}ms` : message.message_type === 'image' ? `사진${message.content ? ` · ${message.content}` : ''}` : message.content}</p><small>#{message.id}{message.report_count ? ` · 신고 ${message.report_count}` : ''}</small>{canModerate && message.message_type !== 'system' && <button onClick={async () => { if (await runAction('admin_delete_open_chat_message', { target_message_id: message.id, admin_note: reason.trim() }, '이 메시지를 수다방에서 삭제할까요?')) await refreshRoom() }}>메시지 삭제</button>}</article>)}</div>
      </>}</section>
    </div> : <div className="content-layout">
      <section className="content-list">{loading && contents.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : contents.length === 0 ? <div className="empty">조건에 맞는 콘텐츠가 없습니다</div> : contents.map(content => <button key={content.content_id} className={`content-row ${selectedContent?.content_id === content.content_id ? 'selected' : ''}`} onClick={() => void openPost(content)}><div><strong>{content.title}</strong><span className={`chat-state ${content.content_status}`}>{content.content_status === 'active' ? '활성' : '비활성'}</span></div><p>{content.author_nickname} · {content.country_code}</p><small>{content.body}</small><small>작성 {formatDate(content.created_at)} · 신고 {content.report_count}{content.content_kind === 'post' ? ` · 댓글 ${content.comment_count}` : ''}</small></button>)}</section>
      <section className="content-detail">{!selectedContent ? <div className="detail-empty"><div className="empty-symbol">⌁</div><h3>콘텐츠를 선택해 주세요</h3><p>작성 내용과 관련 댓글을 검토할 수 있습니다</p></div> : <><div className="content-detail-head"><div><span className={`chat-state ${selectedContent.content_status}`}>{selectedContent.content_status === 'active' ? '활성' : '비활성'}</span><h2>{selectedContent.title}</h2><p>{selectedContent.content_id}</p></div><button onClick={() => setSelectedContent(null)}>×</button></div><p className="content-body">{selectedContent.body}</p><div className="content-summary"><span>작성자<strong>{selectedContent.author_nickname}</strong></span><span>작성 시각<strong>{formatDate(selectedContent.created_at)}</strong></span><span>신고 참고<strong>{selectedContent.report_count}건</strong></span></div>
        {canModerate && selectedContent.content_kind === 'talk' && <button className={selectedContent.content_status === 'active' ? 'content-danger' : 'content-restore'} onClick={async () => { if (await runAction('admin_set_conversation_card_active', { target_card_uuid: selectedContent.content_id, next_active: selectedContent.content_status !== 'active', admin_note: reason.trim() }, selectedContent.content_status === 'active' ? '이 톡을 발견 목록에서 숨길까요?' : '이 톡을 다시 활성화할까요?')) setSelectedContent(null) }}>{selectedContent.content_status === 'active' ? '톡 비활성화' : '톡 다시 활성화'}</button>}
        {canModerate && selectedContent.content_kind === 'post' && <button className="content-danger" onClick={async () => { if (await runAction('admin_delete_board_content', { target_kind: 'post', target_content_uuid: selectedContent.content_id, admin_note: reason.trim() }, '게시글과 모든 댓글을 영구 삭제할까요?')) setSelectedContent(null) }}>게시글과 댓글 삭제</button>}
        {selectedContent.content_kind === 'post' && <><h3 className="content-section-title">댓글 {comments.length}</h3><div className="board-comment-list">{comments.length === 0 ? <p className="muted">댓글이 없습니다.</p> : comments.map(comment => <article key={comment.comment_id}><div><strong>{comment.anonymous_name} <small>({comment.author_nickname})</small></strong><time>{formatDate(comment.created_at)}</time></div><p>{comment.body}</p>{canModerate && <button onClick={async () => { if (await runAction('admin_delete_board_content', { target_kind: 'comment', target_content_uuid: comment.comment_id, admin_note: reason.trim() }, '이 댓글과 하위 답글을 삭제할까요?')) await openPost(selectedContent) }}>댓글 삭제</button>}</article>)}</div></>}
      </>}</section>
    </div>}
  </>
}

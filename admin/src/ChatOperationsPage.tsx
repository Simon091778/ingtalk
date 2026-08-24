import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { AdminChatRequest, AdminChatRoom, AdminMessageBackup } from './types'

const requestStatusLabels: Record<string, string> = { pending: '대기 중', accepted: '수락', declined: '거절', cancelled: '취소' }

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function shorten(value: string) { return value.length > 12 ? `${value.slice(0, 8)}…` : value }

export function ChatOperationsPage() {
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'requests' | 'rooms'>('requests')
  const [requests, setRequests] = useState<AdminChatRequest[]>([])
  const [rooms, setRooms] = useState<AdminChatRoom[]>([])
  const [selectedRoom, setSelectedRoom] = useState<AdminChatRoom | null>(null)
  const [messages, setMessages] = useState<AdminMessageBackup[]>([])
  const [loading, setLoading] = useState(false)
  const [messageLoading, setMessageLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (searchText = '') => {
    if (!supabase) return
    setLoading(true); setError('')
    const search_text = searchText.trim() || null
    const [requestResult, roomResult] = await Promise.all([
      supabase.rpc('admin_list_chat_requests', { search_text, result_limit: 300 }),
      supabase.rpc('admin_list_chat_rooms', { search_text, result_limit: 300 }),
    ])
    if (requestResult.error || roomResult.error) setError(requestResult.error?.message ?? roomResult.error?.message ?? '대화 운영 기록을 불러오지 못했습니다')
    else {
      setRequests((requestResult.data as AdminChatRequest[] | null) ?? [])
      setRooms(((roomResult.data as AdminChatRoom[] | null) ?? []).map(room => ({ ...room, live_message_count: Number(room.live_message_count), backup_message_count: Number(room.backup_message_count), deleted_message_count: Number(room.deleted_message_count) })))
      setSelectedRoom(null); setMessages([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const search = (event: FormEvent) => { event.preventDefault(); void load(query) }

  const openRoom = async (room: AdminChatRoom) => {
    if (!supabase) return
    setSelectedRoom(room); setMessages([]); setMessageLoading(true); setError('')
    const { data, error: messageError } = await supabase.rpc('admin_list_message_backups', { target_room_uuid: room.room_id, result_limit: 500 })
    if (messageError) setError(messageError.message)
    else setMessages((data as AdminMessageBackup[] | null) ?? [])
    setMessageLoading(false)
  }

  return <>
    <header className="topbar"><div><p className="eyebrow">CHAT OPERATIONS</p><h1>대화 기록</h1><p>대화 신청, 대화방 상태와 보존된 메시지를 확인합니다</p></div><button className="refresh" onClick={() => void load(query)} disabled={loading}>↻ 새로고침</button></header>
    <div className="chat-privacy-note">운영 목적의 조회만 허용됩니다. 사용자에게 삭제된 메시지도 관리자 백업에는 별도로 표시됩니다.</div>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
    <div className="chat-ops-toolbar"><form onSubmit={search}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="닉네임, 사용자 ID, 대화방 ID 검색" /><button>검색</button></form><div className="chat-ops-tabs"><button className={activeTab === 'requests' ? 'active' : ''} onClick={() => setActiveTab('requests')}>신청 기록 {requests.length}</button><button className={activeTab === 'rooms' ? 'active' : ''} onClick={() => setActiveTab('rooms')}>대화방 {rooms.length}</button></div></div>

    {activeTab === 'requests' ? <section className="chat-record-list">
      {loading && requests.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : requests.length === 0 ? <div className="empty">조건에 맞는 대화 신청이 없습니다</div> : requests.map(request => <article className="chat-record" key={request.request_id}>
        <div className="chat-record-head"><div><strong>{request.sender_nickname}</strong><span>→</span><strong>{request.receiver_nickname}</strong></div><span className={`chat-state ${request.request_status}`}>{request.withdrawn_at ? '발신자 삭제' : (requestStatusLabels[request.request_status] ?? request.request_status)}</span></div>
        <p className="chat-opening">{request.opening_message || '첫 인사 없음'}</p>
        <div className="chat-record-meta"><span>신청 {formatDate(request.created_at)}</span><span>응답 {formatDate(request.responded_at)}</span><span>대화방 {request.room_id ? shorten(request.room_id) : '-'}</span><span>출처 {request.board_post_id ? '익명게시판' : '발견'}</span></div><small>ID {request.request_id}</small>
      </article>)}
    </section> : <div className="chat-ops-layout">
      <section className="chat-room-list">{loading && rooms.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : rooms.length === 0 ? <div className="empty">조건에 맞는 대화방이 없습니다</div> : rooms.map(room => <button className={`chat-room-row ${selectedRoom?.room_id === room.room_id ? 'selected' : ''}`} key={room.room_id} onClick={() => void openRoom(room)}><div><strong>{room.sender_nickname}</strong><span>↔</span><strong>{room.receiver_nickname}</strong><em className={`chat-state ${room.room_status}`}>{room.room_status === 'active' ? '활성' : '사용자 삭제'}</em></div><p>현재 메시지 {room.live_message_count} · 백업 {room.backup_message_count} · 삭제 표시 {room.deleted_message_count}</p><small>최근 메시지 {formatDate(room.last_message_at)} · {shorten(room.room_id)}</small></button>)}</section>
      <section className="chat-backup-panel">{!selectedRoom ? <div className="detail-empty"><div className="empty-symbol">↔</div><h3>대화방을 선택해 주세요</h3><p>사용자 화면과 분리 보관된 메시지 백업을 확인할 수 있습니다</p></div> : <><div className="chat-backup-head"><div><span className={`chat-state ${selectedRoom.room_status}`}>{selectedRoom.room_status === 'active' ? '활성' : '사용자 삭제'}</span><h2>{selectedRoom.sender_nickname} · {selectedRoom.receiver_nickname}</h2><p>{selectedRoom.room_id}</p></div><button onClick={() => { setSelectedRoom(null); setMessages([]) }}>×</button></div><div className="chat-room-summary"><span>생성<strong>{formatDate(selectedRoom.created_at)}</strong></span><span>종료<strong>{formatDate(selectedRoom.closed_at)}</strong></span><span>백업<strong>{selectedRoom.backup_message_count}건</strong></span></div><div className="backup-messages">{messageLoading ? <div className="empty"><div className="spinner" />백업 확인 중</div> : messages.length === 0 ? <div className="empty">보관된 메시지가 없습니다</div> : messages.map(message => <article className={message.deleted_from_live_at ? 'deleted-copy' : ''} key={message.original_message_id}><div><strong>{message.sender_nickname ?? shorten(message.sender_id)}</strong><time>{formatDate(message.message_created_at)}</time></div><p>{message.body}</p>{message.deleted_from_live_at && <small>사용자 화면에서 삭제됨 · {message.deletion_action === 'block' ? '차단' : '대화방 삭제'} · {formatDate(message.deleted_from_live_at)}</small>}</article>)}</div></>}</section>
    </div>}
  </>
}

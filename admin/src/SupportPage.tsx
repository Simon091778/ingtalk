import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { SupportMessage, SupportThreadSummary } from './types'

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function SupportPage() {
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open')
  const [threads, setThreads] = useState<SupportThreadSummary[]>([])
  const [selected, setSelected] = useState<SupportThreadSummary | null>(null)
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const loadThreads = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    const { data, error: loadError } = await supabase.rpc('admin_list_support_threads', { status_filter: filter === 'all' ? null : filter, result_limit: 300 })
    if (loadError) setError(loadError.message)
    else setThreads((data as SupportThreadSummary[] | null) ?? [])
    setLoading(false)
  }, [filter])

  useEffect(() => { void loadThreads() }, [loadThreads])

  const openThread = async (thread: SupportThreadSummary) => {
    if (!supabase) return
    setSelected(thread); setMessages([]); setError(''); setLoading(true)
    const { data, error: loadError } = await supabase.rpc('admin_list_support_messages', { target_thread_uuid: thread.thread_id, result_limit: 500 })
    if (loadError) setError(loadError.message)
    else setMessages((data as SupportMessage[] | null) ?? [])
    setLoading(false)
    void loadThreads()
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || !selected || !reply.trim() || sending) return
    setSending(true); setError('')
    const { error: sendError } = await supabase.rpc('admin_send_support_message', { target_thread_uuid: selected.thread_id, message_body: reply.trim() })
    if (sendError) setError(sendError.message)
    else { setReply(''); await openThread({ ...selected, status: 'open' }) }
    setSending(false)
  }

  const setStatus = async (status: 'open' | 'closed') => {
    if (!supabase || !selected) return
    const { error: statusError } = await supabase.rpc('admin_set_support_status', { target_thread_uuid: selected.thread_id, next_status: status })
    if (statusError) setError(statusError.message)
    else { setSelected({ ...selected, status }); await loadThreads() }
  }

  return <>
    <header className="topbar"><div><p className="eyebrow">CUSTOMER SUPPORT</p><h1>고객 문의</h1><p>사용자 문의를 확인하고 운영자 답변을 보냅니다</p></div><button className="refresh" onClick={() => void loadThreads()} disabled={loading}>↻ 새로고침</button></header>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
    <div className="support-filter"><button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>처리 중</button><button className={filter === 'closed' ? 'active' : ''} onClick={() => setFilter('closed')}>종료</button><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>전체</button></div>
    <div className="support-layout">
      <section className="support-thread-list">{loading && threads.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : threads.length === 0 ? <div className="empty">문의가 없습니다</div> : threads.map(thread => <button key={thread.thread_id} className={`support-thread ${selected?.thread_id === thread.thread_id ? 'selected' : ''}`} onClick={() => void openThread(thread)}><div><strong>{thread.nickname}</strong>{thread.unread_by_admin && <span className="support-unread">새 문의</span>}<em>{thread.status === 'open' ? '처리 중' : '종료'}</em></div><p>{thread.last_message || '내용 없음'}</p><small>{formatDate(thread.last_message_at)} · {thread.user_id}</small></button>)}</section>
      <section className="support-detail">{!selected ? <div className="detail-empty"><div className="empty-symbol">?</div><h3>문의를 선택해 주세요</h3><p>내용 확인과 답변을 한 화면에서 처리할 수 있습니다</p></div> : <><div className="support-detail-head"><div><span>{selected.status === 'open' ? '처리 중' : '종료'}</span><h2>{selected.nickname}</h2><p>{selected.user_id}</p></div><button onClick={() => { setSelected(null); setMessages([]) }}>×</button></div><div className="support-messages">{messages.map(message => <article className={message.sender_type === 'admin' ? 'admin-reply' : ''} key={message.message_id}><div><strong>{message.sender_type === 'admin' ? `운영자 · ${message.sender_label}` : message.sender_label}</strong><time>{formatDate(message.created_at)}</time></div><p>{message.body}</p></article>)}</div><form className="support-reply" onSubmit={send}><textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={2000} placeholder="사용자에게 보낼 답변을 입력하세요" /><div><button type="button" className="support-status-button" onClick={() => void setStatus(selected.status === 'open' ? 'closed' : 'open')}>{selected.status === 'open' ? '문의 종료' : '다시 열기'}</button><button disabled={!reply.trim() || sending}>{sending ? '전송 중…' : '답변 보내기'}</button></div></form></>}</section>
    </div>
  </>
}

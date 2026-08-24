import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { AdminOperator, AuditEvent } from './types'

const actionLabels: Record<string, string> = {
  start_review: '신고 검토 시작', dismiss: '신고 기각', resolve: '신고 처리 완료',
  suspend: '기간 정지', ban: '영구 정지', restore: '이용 복구', adjust_points: '포인트 조정',
  delete_message_backup: '채팅 보관본 영구 삭제',
}
const roleLabels = { reviewer: '검토자', moderator: '운영자', owner: '최고 관리자' }
const dt = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
function localDate(daysAgo = 0) { const value = new Date(); value.setDate(value.getDate() - daysAgo); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` }
const entries = (state: Record<string, unknown> | null) => Object.entries(state ?? {}).filter(([, value]) => value !== null && value !== '')
function display(value: unknown) { if (typeof value === 'boolean') return value ? '예' : '아니오'; if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return dt(value); return String(value ?? '-') }

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [operators, setOperators] = useState<AdminOperator[]>([])
  const [startDate, setStartDate] = useState(localDate(30))
  const [endDate, setEndDate] = useState(localDate())
  const [operatorId, setOperatorId] = useState('all')
  const [action, setAction] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    const start = startDate ? new Date(`${startDate}T00:00:00`).toISOString() : null
    const end = endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : null
    const [eventResult, operatorResult] = await Promise.all([
      supabase.rpc('admin_list_audit_events', { started_at: start, ended_at: end, operator_uuid: operatorId === 'all' ? null : operatorId, action_filter: action === 'all' ? null : action, result_limit: 500 }),
      supabase.rpc('admin_list_operators'),
    ])
    if (eventResult.error || operatorResult.error) setError(eventResult.error?.message ?? operatorResult.error?.message ?? '감사 기록을 불러오지 못했습니다')
    else { setEvents((eventResult.data as AuditEvent[] | null) ?? []); setOperators((operatorResult.data as AdminOperator[] | null) ?? []) }
    setLoading(false)
  }, [action, endDate, operatorId, startDate])
  useEffect(() => { void load() }, [load])
  const submit = (event: FormEvent) => { event.preventDefault(); void load() }

  return <>
    <header className="topbar"><div><p className="eyebrow">AUDIT TRAIL</p><h1>감사 기록</h1><p>운영자의 모든 처리와 변경 전·후 상태를 확인합니다</p></div><button className="refresh" onClick={() => void load()} disabled={loading}>↻ 새로고침</button></header>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
    <form className="audit-filters" onSubmit={submit}>
      <label>시작일<input type="date" value={startDate} max={endDate || undefined} onChange={e => setStartDate(e.target.value)} /></label>
      <label>종료일<input type="date" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} /></label>
      <label>운영자<select value={operatorId} onChange={e => setOperatorId(e.target.value)}><option value="all">전체 운영자</option>{operators.map(item => <option key={item.user_id} value={item.user_id}>{item.email} · {roleLabels[item.role]}</option>)}</select></label>
      <label>조치 종류<select value={action} onChange={e => setAction(e.target.value)}><option value="all">전체 조치</option>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button disabled={loading}>{loading ? '조회 중…' : '조회'}</button>
    </form>
    <div className="audit-summary"><strong>{events.length.toLocaleString()}</strong><span>개의 기록</span><small>최대 500개까지 최근순으로 표시됩니다</small></div>
    <section className="audit-list">
      {loading && events.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : events.length === 0 ? <div className="empty">조건에 맞는 감사 기록이 없습니다</div> : events.map(item => {
        const before = entries(item.before_state); const after = entries(item.after_state)
        return <article className="audit-event" key={item.id}>
          <div className="audit-event-head"><div><span className={`audit-action ${item.action}`}>{actionLabels[item.action] ?? item.action}</span>{item.point_amount !== null && <strong className={item.point_amount >= 0 ? 'point-plus' : 'point-minus'}>{item.point_amount > 0 ? '+' : ''}{Number(item.point_amount).toLocaleString()}P</strong>}</div><time>{dt(item.created_at)}</time></div>
          <div className="audit-parties"><div><span>운영자</span><strong>{item.admin_email}</strong><small>{item.admin_role ? roleLabels[item.admin_role] : '권한 정보 없음'}</small></div><div><span>대상 이용자</span><strong>{item.target_nickname ?? '대상 없음'}</strong><small>{item.target_user_id ?? '-'}</small></div></div>
          <div className="audit-reason"><span>처리 사유</span><p>{item.note || '별도 사유가 기록되지 않았습니다'}</p></div>
          {(before.length > 0 || after.length > 0) && <div className="state-change"><section><h3>변경 전</h3>{before.length ? before.map(([key, value]) => <div key={key}><span>{key}</span><strong>{display(value)}</strong></div>) : <p>기록 없음</p>}</section><b>→</b><section><h3>변경 후</h3>{after.length ? after.map(([key, value]) => <div key={key}><span>{key}</span><strong>{display(value)}</strong></div>) : <p>기록 없음</p>}</section></div>}
          <footer>{item.report_id && <span>신고 ID {item.report_id}</span>}<span>기록 #{item.id}</span></footer>
        </article>
      })}
    </section>
  </>
}

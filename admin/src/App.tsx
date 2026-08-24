import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './supabase'
import type { AdminIdentity, DashboardStats, ReportItem, ReportStatus } from './types'
import { UsersPage } from './UsersPage'
import { AuditPage } from './AuditPage'
import { ChatOperationsPage } from './ChatOperationsPage'
import { SupportPage } from './SupportPage'

const reasonLabels: Record<string, string> = {
  sexual: '음란물·성적 콘텐츠', illegal_meeting: '불법 만남·성매매 유도', harassment: '욕설·괴롭힘',
  fraud: '사기·금전 요구', spam: '광고·도배', privacy: '개인정보 노출', suspected_minor: '미성년자 의심',
  illegal_image: '불법 촬영물 의심', other: '기타',
}
const roleLabels = { reviewer: '검토자', moderator: '운영자', owner: '최고 관리자' }
const statusLabels = { open: '신규', reviewing: '검토 중', resolved: '처리 완료', dismissed: '기각' }
const defaultStats: DashboardStats = { open_reports: 0, reviewing_reports: 0, urgent_reports: 0, suspended_users: 0, actions_today: 0 }

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase || loading) return
    setLoading(true); setError('')
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)
    if (signInError) setError('이메일 또는 비밀번호를 확인해 주세요')
    else onSignedIn()
  }

  return <main className="login-page">
    <section className="login-panel">
      <div className="brand-mark">잉</div>
      <p className="eyebrow">INGTALK OPERATIONS</p>
      <h1>잉톡 운영센터</h1>
      <p className="login-copy">신고와 이용자 안전을 관리하는 운영자 전용 공간입니다</p>
      <form onSubmit={submit} className="login-form">
        <label>운영자 이메일<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required /></label>
        <label>비밀번호<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={loading}>{loading ? '확인 중…' : '안전하게 로그인'}</button>
      </form>
      <p className="security-note">일반 잉톡 계정으로는 접근할 수 없습니다</p>
    </section>
  </main>
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [admin, setAdmin] = useState<AdminIdentity | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [stats, setStats] = useState(defaultStats)
  const [reports, setReports] = useState<ReportItem[]>([])
  const [filter, setFilter] = useState<ReportStatus | 'all'>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [suspensionDays, setSuspensionDays] = useState('7')
  const [pointAmount, setPointAmount] = useState('')
  const [pointReason, setPointReason] = useState('')
  const [page, setPage] = useState<'dashboard' | 'users' | 'audit' | 'chats' | 'support'>('dashboard')

  const selected = useMemo(() => reports.find(item => item.id === selectedId) ?? null, [reports, selectedId])
  const canModerate = admin?.role === 'moderator' || admin?.role === 'owner'
  const isOwner = admin?.role === 'owner'

  const loadAdmin = useCallback(async () => {
    if (!supabase) return
    const { data, error: adminError } = await supabase.rpc('admin_me')
    const identity = (data as AdminIdentity[] | null)?.[0] ?? null
    setAdmin(identity)
    setAccessDenied(Boolean(adminError || !identity))
  }, [])

  const loadData = useCallback(async () => {
    if (!supabase || !admin) return
    setLoading(true); setError('')
    const [statsResult, reportsResult] = await Promise.all([
      supabase.rpc('admin_dashboard_stats'),
      supabase.rpc('admin_list_reports', { status_filter: filter === 'all' ? null : filter, result_limit: 200 }),
    ])
    if (statsResult.error || reportsResult.error) setError(statsResult.error?.message ?? reportsResult.error?.message ?? '자료를 불러오지 못했습니다')
    else {
      setStats((statsResult.data as DashboardStats | null) ?? defaultStats)
      setReports((reportsResult.data as ReportItem[] | null) ?? [])
    }
    setLoading(false)
  }, [admin, filter])

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return }
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => listener.subscription.unsubscribe()
  }, [])
  useEffect(() => { if (session) void loadAdmin(); else { setAdmin(null); setAccessDenied(false) } }, [session, loadAdmin])
  useEffect(() => { if (admin) void loadData() }, [admin, loadData])

  const openReport = async (report: ReportItem) => {
    setSelectedId(report.id); setNote(report.review_note ?? '')
    if (report.status === 'open' && supabase) {
      await supabase.rpc('admin_mark_report_reviewing', { report_uuid: report.id })
      void loadData()
    }
  }

  const resolve = async (resolution: 'dismiss' | 'resolve' | 'suspend' | 'ban' | 'restore') => {
    if (!supabase || !selected) return
    const labels = { dismiss: '신고를 기각', resolve: '처리 완료', suspend: `${suspensionDays}일 이용 정지`, ban: '영구 정지', restore: '이용 복구' }
    if (!window.confirm(`${selected.reported_nickname} 사용자를 ${labels[resolution]} 처리할까요?`)) return
    setLoading(true); setError('')
    const { error: actionError } = await supabase.rpc('admin_resolve_report', {
      report_uuid: selected.id, resolution, admin_note: note.trim(),
      suspension_days: resolution === 'suspend' ? Number(suspensionDays) : null,
    })
    if (actionError) setError(actionError.message)
    else { setSelectedId(null); await loadData() }
    setLoading(false)
  }

  const adjustPoints = async () => {
    if (!supabase || !selected || !pointAmount || !pointReason.trim()) return
    const amount = Number(pointAmount)
    if (!Number.isInteger(amount) || amount === 0) { setError('포인트는 0이 아닌 정수로 입력해 주세요'); return }
    if (!window.confirm(`${selected.reported_nickname} 사용자에게 ${amount > 0 ? '+' : ''}${amount}P를 반영할까요?`)) return
    setLoading(true); setError('')
    const { data, error: pointError } = await supabase.rpc('admin_adjust_points', {
      target_user_uuid: selected.reported_user_id, point_amount: amount, adjustment_reason: pointReason.trim(),
    })
    if (pointError) setError(pointError.message)
    else { window.alert(`반영되었습니다. 현재 잔액은 ${Number(data).toLocaleString()}P입니다.`); setPointAmount(''); setPointReason(''); await loadData() }
    setLoading(false)
  }

  if (!configured) return <main className="center-message"><h1>환경변수 설정이 필요합니다</h1><p><code>admin/.env</code>에 Supabase URL과 Publishable Key를 입력해 주세요</p></main>
  if (!authReady) return <main className="center-message"><div className="spinner" /><p>보안 세션 확인 중</p></main>
  if (!session) return <Login onSignedIn={() => void loadAdmin()} />
  if (accessDenied) return <main className="center-message"><h1>접근 권한이 없습니다</h1><p>이 계정은 잉톡 운영자로 등록되지 않았습니다</p><button className="secondary" onClick={() => void supabase?.auth.signOut()}>로그아웃</button></main>
  if (!admin) return <main className="center-message"><div className="spinner" /><p>운영자 권한 확인 중</p></main>

  return <div className="app-shell">
    <aside className="sidebar">
      <div><div className="side-brand"><div className="brand-mark small">잉</div><div><strong>잉톡</strong><span>운영센터</span></div></div>
        <nav><button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}><span>⌂</span>안전 대시보드</button><button className={page === 'users' ? 'active' : ''} onClick={() => setPage('users')}><span>◎</span>이용자 관리</button><button className={page === 'audit' ? 'active' : ''} onClick={() => setPage('audit')}><span>◇</span>감사 기록</button><button className={page === 'support' ? 'active' : ''} onClick={() => setPage('support')}><span>?</span>고객 문의</button>{canModerate && <button className={page === 'chats' ? 'active' : ''} onClick={() => setPage('chats')}><span>↔</span>대화 기록</button>}</nav>
      </div>
      <div className="operator"><span>{admin.email}</span><strong>{roleLabels[admin.role]}</strong><button onClick={() => void supabase?.auth.signOut()}>로그아웃</button></div>
    </aside>
    <main className="workspace">
      {page === 'users' ? <UsersPage role={admin.role} /> : page === 'audit' ? <AuditPage /> : page === 'support' ? <SupportPage /> : page === 'chats' ? <ChatOperationsPage /> : <>
      <header className="topbar"><div><p className="eyebrow">SAFETY OVERVIEW</p><h1>안전 대시보드</h1><p>신고를 우선순위에 따라 검토하고 필요한 조치를 기록합니다</p></div><button className="refresh" onClick={() => void loadData()} disabled={loading}>↻ 새로고침</button></header>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
      <section className="stats-grid">
        <article><span>신규 신고</span><strong>{stats.open_reports}</strong><small>검토가 필요합니다</small></article>
        <article><span>검토 중</span><strong>{stats.reviewing_reports}</strong><small>운영자가 확인 중입니다</small></article>
        <article className="urgent"><span>긴급 신고</span><strong>{stats.urgent_reports}</strong><small>우선 확인 대상입니다</small></article>
        <article><span>정지 사용자</span><strong>{stats.suspended_users}</strong><small>현재 이용이 제한됨</small></article>
        <article><span>오늘의 조치</span><strong>{stats.actions_today}</strong><small>감사 로그에 기록됨</small></article>
      </section>
      <section className="report-section">
        <div className="section-heading"><div><h2>신고 대기열</h2><p>긴급도와 접수 시간 순으로 표시됩니다</p></div><div className="filters">{(['open', 'reviewing', 'resolved', 'dismissed', 'all'] as const).map(value => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => { setFilter(value); setSelectedId(null) }}>{value === 'all' ? '전체' : statusLabels[value]}</button>)}</div></div>
        <div className="report-layout">
          <div className="report-list">{loading && reports.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : reports.length === 0 ? <div className="empty">이 상태의 신고가 없습니다</div> : reports.map(report => <button key={report.id} className={`report-row ${selectedId === report.id ? 'selected' : ''}`} onClick={() => void openReport(report)}><div className="row-top"><span className={`priority ${report.priority}`}>{report.priority === 'urgent' ? '긴급' : report.priority === 'high' ? '높음' : '일반'}</span><time>{formatDate(report.created_at)}</time></div><strong>{report.reported_nickname}</strong><p>{reasonLabels[report.reason] ?? report.reason}</p><div className="row-bottom"><span>신고자 {report.reporter_nickname}</span><span className={`status ${report.status}`}>{statusLabels[report.status]}</span></div></button>)}</div>
          <div className="detail-panel">{!selected ? <div className="detail-empty"><div className="empty-symbol">⌁</div><h3>신고를 선택해 주세요</h3><p>신고 내용과 대화 증거를 확인할 수 있습니다</p></div> : <>
            <div className="detail-header"><div><span className={`priority ${selected.priority}`}>{selected.priority === 'urgent' ? '긴급' : selected.priority === 'high' ? '높음' : '일반'}</span><h2>{selected.reported_nickname}</h2><p>{reasonLabels[selected.reason] ?? selected.reason}</p></div><button className="close-detail" onClick={() => setSelectedId(null)}>×</button></div>
            <div className="profile-summary"><div><span>계정 상태</span><strong>{selected.reported_status}{selected.suspended_until ? ` · ${formatDate(selected.suspended_until)}까지` : ''}</strong></div><div><span>신고자</span><strong>{selected.reporter_nickname}</strong></div><div><span>접수 시각</span><strong>{formatDate(selected.created_at)}</strong></div></div>
            {selected.details && <section className="detail-block"><h3>신고자 설명</h3><p>{selected.details}</p></section>}
            <section className="detail-block"><h3>최근 대화 증거 <span>{selected.content_snapshot?.length ?? 0}건</span></h3><div className="evidence">{selected.content_snapshot?.length ? selected.content_snapshot.map(message => <article key={message.id} className={message.sender_id === selected.reported_user_id ? 'reported' : ''}><div><strong>{message.sender_id === selected.reported_user_id ? selected.reported_nickname : '신고자'}</strong><time>{formatDate(message.created_at)}</time></div><p>{message.body}</p></article>) : <p className="muted">보존된 대화가 없습니다</p>}</div></section>
            <section className="decision-box"><label>운영 메모<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} placeholder="판단 근거와 조치 내용을 기록해 주세요" /></label><div className="decision-actions"><button onClick={() => void resolve('dismiss')} disabled={loading}>기각</button><button onClick={() => void resolve('resolve')} disabled={loading}>처리 완료</button></div>{canModerate && <div className="moderator-actions"><div><label>정지 기간<input type="number" min="1" max="365" value={suspensionDays} onChange={event => setSuspensionDays(event.target.value)} /></label><button className="danger" onClick={() => void resolve('suspend')} disabled={loading}>기간 정지</button></div><button onClick={() => void resolve('restore')} disabled={loading}>이용 복구</button>{isOwner && <button className="danger solid" onClick={() => void resolve('ban')} disabled={loading}>영구 정지</button>}</div>}</section>
            {canModerate && <section className="point-box"><h3>포인트 조정</h3><p>모든 변경은 거래 내역과 감사 로그에 남습니다</p><div><input type="number" value={pointAmount} onChange={event => setPointAmount(event.target.value)} placeholder="예: 500 또는 -100" /><input value={pointReason} onChange={event => setPointReason(event.target.value)} maxLength={300} placeholder="조정 사유" /><button onClick={() => void adjustPoints()} disabled={loading || !pointAmount || pointReason.trim().length < 2}>반영</button></div></section>}
          </>}</div>
        </div>
      </section>
      </>}
    </main>
  </div>
}

export default App

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { UserAccountOperations } from './UserAccountOperations'
import type { AdminRole, UserDetail, UserSummary } from './types'

type DetailTab = 'overview' | 'talks' | 'posts' | 'comments' | 'history' | 'points' | 'account'

const actionLabels: Record<string, string> = {
  start_review: '신고 검토 시작', dismiss: '신고 기각', resolve: '처리 완료', suspend: '기간 정지',
  ban: '영구 정지', restore: '이용 복구', adjust_points: '포인트 조정',
  revoke_device_sessions: '기기 로그아웃',
}
const pointReasonLabels: Record<string, string> = {
  chat_request: '대화 신청', reward_attendance: '출석 보상', reward_talk_write: '톡 작성 보상',
  reward_board_post: '게시글 작성 보상', reward_board_comment: '댓글 작성 보상', admin_adjustment: '운영자 조정',
  reward_rewarded_ad: '광고 시청 보상', point_purchase: '포인트 구매', point_purchase_refund: '구매 환불 회수',
  welcome_account: '가입 보상',
}

function date(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function genderLabel(value: string | null) { return value === 'male' ? '남성' : value === 'female' ? '여성' : value === 'other' ? '기타' : '비공개' }
function age(birthYear: number) { return new Date().getFullYear() - Number(birthYear) }

export function UsersPage({ role }: { role: AdminRole }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [users, setUsers] = useState<UserSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const detailRequest = useRef(0)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [days, setDays] = useState('7')
  const [pointAmount, setPointAmount] = useState('')
  const [pointReason, setPointReason] = useState('')
  const canModerate = role === 'moderator' || role === 'owner'

  const search = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    const { data, error: searchError } = await supabase.rpc('admin_search_users', {
      search_text: query.trim(), status_filter: status === 'all' ? null : status, result_limit: 200,
    })
    if (searchError) setError(searchError.message)
    else setUsers(((data as UserSummary[] | null) ?? []).map(user => ({
      ...user,
      point_balance: Number(user.point_balance), talk_count: Number(user.talk_count), post_count: Number(user.post_count),
      comment_count: Number(user.comment_count), report_count: Number(user.report_count), action_count: Number(user.action_count),
    })))
    setLoading(false)
  }, [query, status])

  const loadDetail = useCallback(async (userId: string) => {
    if (!supabase || selectedRef.current !== userId) return
    const request = ++detailRequest.current
    setDetailLoading(true); setError('')
    const [detailResult, locationResult] = await Promise.all([
      supabase.rpc('admin_get_user_detail', { target_user_uuid: userId }),
      supabase.rpc('admin_list_user_talk_location_status', { target_user_uuid: userId }),
    ])
    if (request !== detailRequest.current || selectedRef.current !== userId) return
    if (detailResult.error || locationResult.error) setError(detailResult.error?.message ?? locationResult.error?.message ?? '이용자 정보를 불러오지 못했습니다')
    else {
      const next = detailResult.data as UserDetail
      const locationByCard = new Map(((locationResult.data as Array<{ card_id: string; location_captured_at: string | null }> | null) ?? [])
        .map(item => [item.card_id, item.location_captured_at]))
      next.talks = next.talks.map(talk => ({ ...talk, location_captured_at: locationByCard.get(talk.id) ?? null }))
      next.profile.point_balance = Number(next.profile.point_balance)
      setDetail(next)
    }
    setDetailLoading(false)
  }, [])

  useEffect(() => { void search() }, [status])
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(null) }, [selectedId, loadDetail])
  useEffect(() => () => { detailRequest.current++; selectedRef.current = null }, [])

  const submitSearch = (event: FormEvent) => { event.preventDefault(); void search() }
  const manage = async (action: 'suspend' | 'ban' | 'restore') => {
    if (!supabase || !detail || !canModerate) return
    if (note.trim().length < 2) { setError('계정 조치 사유를 2글자 이상 입력해 주세요'); return }
    const label = action === 'suspend' ? `${days}일 정지` : action === 'ban' ? '영구 정지' : '이용 복구'
    if (!window.confirm(`${detail.profile.nickname} 사용자를 ${label} 처리할까요?`)) return
    setDetailLoading(true); setError('')
    const { error: manageError } = await supabase.rpc('admin_manage_user', {
      target_user_uuid: detail.profile.id, management_action: action, admin_note: note.trim(),
      suspension_days: action === 'suspend' ? Number(days) : null,
    })
    if (manageError) setError(manageError.message)
    else { setNote(''); await Promise.all([loadDetail(detail.profile.id), search()]) }
    setDetailLoading(false)
  }

  const adjustPoints = async () => {
    if (!supabase || !detail || !canModerate) return
    const amount = Number(pointAmount)
    if (!Number.isInteger(amount) || amount === 0 || pointReason.trim().length < 2) { setError('포인트 정수와 조정 사유를 입력해 주세요'); return }
    if (!window.confirm(`${amount > 0 ? '지급' : '회수'} ${Math.abs(amount).toLocaleString()}P를 반영할까요?`)) return
    setDetailLoading(true); setError('')
    const { error: pointError } = await supabase.rpc('admin_adjust_points', {
      target_user_uuid: detail.profile.id, point_amount: amount, adjustment_reason: pointReason.trim(),
    })
    if (pointError) setError(pointError.message)
    else { setPointAmount(''); setPointReason(''); await Promise.all([loadDetail(detail.profile.id), search()]) }
    setDetailLoading(false)
  }

  return <>
    <header className="topbar"><div><p className="eyebrow">USER OPERATIONS</p><h1>이용자 관리</h1><p>계정과 활동 기록을 확인하고 필요한 운영 조치를 수행합니다</p></div><button className="refresh" onClick={() => void search()} disabled={loading}>↻ 새로고침</button></header>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
    <section className="user-toolbar">
      <form onSubmit={submitSearch}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="닉네임 또는 사용자 ID 검색" /><button>검색</button></form>
      <div className="filters">{['all', 'active', 'suspended', 'paused', 'deleted'].map(value => <button key={value} className={status === value ? 'selected' : ''} onClick={() => setStatus(value)}>{value === 'all' ? '전체' : value === 'active' ? '정상' : value === 'suspended' ? '정지' : value === 'paused' ? '일시중지' : '삭제'}</button>)}</div>
    </section>
    <section className="user-layout">
      <div className="user-list">{loading && users.length === 0 ? <div className="empty"><div className="spinner" />불러오는 중</div> : users.length === 0 ? <div className="empty">검색된 이용자가 없습니다</div> : users.map(user => <button key={user.user_id} className={`user-row ${selectedId === user.user_id ? 'selected' : ''}`} onClick={() => { if (selectedRef.current !== user.user_id) { selectedRef.current = user.user_id; detailRequest.current++; setDetail(null); setDetailLoading(true); setSelectedId(user.user_id); setNote(''); setPointAmount(''); setPointReason('') } setTab('overview') }}><div className="user-avatar">{user.nickname[0]}</div><div className="user-row-main"><div><strong>{user.nickname}</strong><span className={`account-status ${user.status}`}>{user.status === 'active' ? '정상' : user.status === 'suspended' ? '정지' : user.status}</span></div><p>{user.user_id}</p><div className="user-metrics"><span>{Number(user.point_balance).toLocaleString()}P</span><span>톡 {user.talk_count}</span><span>글 {user.post_count}</span><span>댓글 {user.comment_count}</span>{user.report_count > 0 && <b>신고 {user.report_count}</b>}</div></div></button>)}</div>
      <div className="user-detail">{detailLoading && !detail ? <div className="empty"><div className="spinner" />이용자 정보 확인 중</div> : !detail ? <div className="detail-empty"><div className="empty-symbol">◎</div><h3>이용자를 선택해 주세요</h3><p>프로필, 콘텐츠, 신고와 제재 이력을 확인할 수 있습니다</p></div> : <>
        <div className="user-profile-head">{detail.profile.avatar_url ? <img src={detail.profile.avatar_url} alt="" /> : <div className="large-user-avatar">{detail.profile.nickname[0]}</div>}<div><div><h2>{detail.profile.nickname}</h2><span className={`account-status ${detail.profile.status}`}>{detail.profile.status === 'active' ? '정상' : detail.profile.status === 'suspended' ? '이용 정지' : detail.profile.status}</span></div><p>{detail.profile.id}</p><span>{genderLabel(detail.profile.gender)} · {age(detail.profile.birth_year)}세 · 가입 {date(detail.profile.created_at)}</span></div></div>
        {detail.profile.suspension_reason && <div className="suspension-notice"><strong>정지 사유</strong><span>{detail.profile.suspension_reason}</span><small>{detail.profile.suspended_until ? `${date(detail.profile.suspended_until)}까지` : '영구 정지'}</small></div>}
        <div className="detail-tabs">{([['overview', '요약'], ['talks', `톡 ${detail.talks.length}`], ['posts', `게시글 ${detail.posts.length}`], ['comments', `댓글 ${detail.comments.length}`], ['history', `신고·제재 ${detail.reports.length + detail.actions.length}`], ['points', '포인트'], ['account', '로그인·보상']] as const).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
        <div className="user-tab-content">
          {tab === 'account' && <UserAccountOperations key={detail.profile.id} accountId={detail.profile.id} role={role} />}
          {tab === 'overview' && <div className="overview-grid"><article><span>보유 포인트</span><strong>{Number(detail.profile.point_balance).toLocaleString()}P</strong></article><article><span>계정 상태</span><strong>{detail.profile.status}</strong></article><article><span>신뢰 점수</span><strong>{detail.profile.trust_score}</strong></article><article><span>최근 수정</span><strong>{date(detail.profile.updated_at)}</strong></article><section><h3>자기소개</h3><p>{detail.profile.introduction || '등록된 자기소개가 없습니다'}</p></section></div>}
          {tab === 'talks' && <ContentList empty="작성한 톡이 없습니다" items={detail.talks.map(item => ({ id: item.id, title: item.purpose, body: item.topic, meta: `${item.is_active ? '노출 중' : '비활성'} · ${date(item.created_at)} · ${item.location_captured_at ? `작성 위치 저장 ${date(item.location_captured_at)}` : '작성 위치 없음'}` }))} />}
          {tab === 'posts' && <ContentList empty="작성한 게시글이 없습니다" items={detail.posts.map(item => ({ id: item.id, title: item.title, body: item.body, meta: `조회 ${item.view_count} · ${date(item.created_at)}`, image: item.image_url }))} />}
          {tab === 'comments' && <ContentList empty="작성한 댓글이 없습니다" items={detail.comments.map(item => ({ id: item.id, title: item.post_title, body: item.body, meta: date(item.created_at) }))} />}
          {tab === 'history' && <div className="history-columns"><section><h3>신고 이력</h3>{detail.reports.length ? detail.reports.map(item => <article key={item.id}><div><span className={`priority ${item.priority}`}>{item.priority === 'urgent' ? '긴급' : item.priority === 'high' ? '높음' : '일반'}</span><time>{date(item.created_at)}</time></div><strong>{item.reason}</strong><p>{item.details || '상세 설명 없음'}</p><small>{item.status}{item.review_note ? ` · ${item.review_note}` : ''}</small></article>) : <p className="muted">신고 이력이 없습니다</p>}</section><section><h3>운영 조치</h3>{detail.actions.length ? detail.actions.map(item => <article key={item.id}><div><strong>{actionLabels[item.action] ?? item.action}</strong><time>{date(item.created_at)}</time></div><p>{item.note || '운영 메모 없음'}</p><small>{item.admin_email ?? '운영자'}</small></article>) : <p className="muted">제재 이력이 없습니다</p>}</section></div>}
          {tab === 'points' && <div className="point-history">{detail.point_transactions.length ? detail.point_transactions.map(item => <article key={item.id}><div><strong className={item.amount > 0 ? 'plus' : 'minus'}>{item.amount > 0 ? '+' : ''}{Number(item.amount).toLocaleString()}P</strong><span>{pointReasonLabels[item.reason] ?? item.reason}</span></div><time>{date(item.created_at)}</time></article>) : <p className="muted">포인트 내역이 없습니다</p>}</div>}
        </div>
        {canModerate && <section className="user-operations"><h3>운영 조치</h3><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="정지 또는 복구 사유를 입력해 주세요" maxLength={1000} /><div className="account-actions"><label>정지 기간<input type="number" min="1" max="365" value={days} onChange={event => setDays(event.target.value)} /></label><button className="danger" onClick={() => void manage('suspend')} disabled={detailLoading}>기간 정지</button><button onClick={() => void manage('restore')} disabled={detailLoading}>이용 복구</button>{role === 'owner' && <button className="danger solid" onClick={() => void manage('ban')} disabled={detailLoading}>영구 정지</button>}</div><div className="user-point-adjust"><input type="number" value={pointAmount} onChange={event => setPointAmount(event.target.value)} placeholder="지급 +500 / 회수 -100" /><input value={pointReason} onChange={event => setPointReason(event.target.value)} placeholder="포인트 조정 사유" maxLength={300} /><button onClick={() => void adjustPoints()} disabled={detailLoading}>포인트 반영</button></div></section>}
      </>}</div>
    </section>
  </>
}

function ContentList({ items, empty }: { items: Array<{ id: string; title: string; body: string; meta: string; image?: string | null }>; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>
  return <div className="admin-content-list">{items.map(item => <article key={item.id}>{item.image && <img src={item.image} alt="첨부" />}<div><strong>{item.title}</strong><p>{item.body}</p><small>{item.meta}</small></div></article>)}</div>
}

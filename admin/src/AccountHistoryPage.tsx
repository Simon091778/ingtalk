import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { AdminAccountMerge, AdminPointPurchase } from './types'
import { formatAdminDateTime as dt, formatAdminPhone } from './adminFormat'

type Tab = 'merges' | 'purchases'
const providers = { phone: '휴대폰', google: 'Google', kakao: '카카오' }
const statuses = { credited: '지급 완료', refunded: '환불' }
const accountStatuses: Record<string, string> = { active: '정상', suspended: '이용 제한', banned: '영구 정지', merged: '병합됨', deleted: '탈퇴·삭제', unavailable: '현재 확인 불가' }
const policyLabel = (value: string) => value === 'discard_losing_assets' ? '현재 계정 유지 · 상대 자산 삭제' : value === 'legacy_transfer' ? '이전 이관 정책' : value
const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`
const identityStatus = (status: 'active' | 'detached' | 'none' | 'unavailable') => status === 'active' ? '인증 연결 유효' : status === 'detached' ? '인증 해제됨' : status === 'none' ? '연결 없음' : '인증 상태 확인 필요'

function PurchasePayer({ item }: { item: AdminPointPurchase }) {
  const payer = item.payer
  const displayName = payer.nickname ?? (payer.merged ? '병합된 원본 계정' : item.account_deleted_at ? '탈퇴·삭제된 계정' : '결제자 현재 확인 불가')
  return <section className="purchase-payer" aria-label="결제자">
    <div className="purchase-payer-head"><div><span>결제자</span><strong>{displayName}</strong></div><b className={`account-status ${payer.account_status}`}>{accountStatuses[payer.account_status] ?? payer.account_status}</b></div>
    <dl className="purchase-account-ids">
      <div><dt>원본 결제 Account</dt><dd>{payer.original_account_id ?? '과거 증빙으로 확인 불가'}</dd></div>
      <div><dt>현재 Operational Account</dt><dd>{payer.operational_account_id ?? '연결 없음'}</dd></div>
      {payer.merged && payer.canonical_account_id && <div><dt>현재 Canonical Account</dt><dd>{payer.canonical_account_id}{payer.canonical_nickname ? ` · ${payer.canonical_nickname}` : ''}</dd></div>}
    </dl>
    <div className="purchase-identities">
      <article><strong>계정 휴대전화 이력</strong><b>{(payer.phone.status === 'active' || payer.phone.status === 'detached') && payer.phone.phone ? formatAdminPhone(payer.phone.phone) : identityStatus(payer.phone.status)}</b><span>{identityStatus(payer.phone.status)}</span>{payer.phone.status !== 'none' && <small>인증일시: {dt(payer.phone.verified_at)}</small>}{payer.phone.status === 'detached' && <small>인증 해제일시: {dt(payer.phone.detached_at ?? null)}</small>}</article>
      <article><strong>Google</strong><b>{payer.google.status === 'active' && payer.google.email ? payer.google.email : identityStatus(payer.google.status)}</b><span>{identityStatus(payer.google.status)}</span>{payer.google.status !== 'none' && <small>인증일시: {dt(payer.google.verified_at)}</small>}</article>
      <article><strong>카카오</strong><b>{payer.kakao.status === 'active' ? '카카오 로그인 연결' : identityStatus(payer.kakao.status)}</b><span>{identityStatus(payer.kakao.status)}</span>{payer.kakao.status !== 'none' && <small>인증일시: {dt(payer.kakao.verified_at)}</small>}</article>
    </div>
  </section>
}

export function AccountHistoryPage() {
  const [tab, setTab] = useState<Tab>('merges')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'credited' | 'refunded'>('all')
  const [merges, setMerges] = useState<AdminAccountMerge[]>([])
  const [purchases, setPurchases] = useState<AdminPointPurchase[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setError('')
    const result = tab === 'merges'
      ? await supabase.rpc('admin_list_account_merges', { search_text: appliedQuery || null, result_limit: 200 })
      : await supabase.rpc('admin_list_point_purchases', { search_text: appliedQuery || null, status_filter: status === 'all' ? null : status, result_limit: 200 })
    if (result.error) setError(result.error.message)
    else if (tab === 'merges') setMerges((result.data as AdminAccountMerge[] | null) ?? [])
    else setPurchases((result.data as AdminPointPurchase[] | null) ?? [])
    setLoading(false)
  }, [appliedQuery, status, tab])

  useEffect(() => { void load() }, [load])
  const search = (event: FormEvent) => { event.preventDefault(); setAppliedQuery(query.trim()) }

  return <>
    <header className="topbar"><div><p className="eyebrow">ACCOUNT OPERATIONS</p><h1>계정·결제 이력</h1><p>검증된 계정 통합과 앱스토어 구매 증빙을 읽기 전용으로 확인합니다</p></div><button className="refresh" onClick={() => void load()} disabled={loading}>↻ 새로고침</button></header>
    <p className="account-history-notice">인증 원문, 세션·기기 해시, 결제사의 원본 payload와 전체 거래번호는 노출하지 않습니다. 통합 실행·취소 및 결제 상태 변경 기능은 제공하지 않습니다.</p>
    <div className="account-history-tabs">
      <button className={tab === 'merges' ? 'active' : ''} onClick={() => { setTab('merges'); setQuery(''); setAppliedQuery('') }}>계정 통합</button>
      <button className={tab === 'purchases' ? 'active' : ''} onClick={() => { setTab('purchases'); setQuery(''); setAppliedQuery('') }}>구매 증빙</button>
    </div>
    <div className="account-history-toolbar">
      <form onSubmit={search}><input aria-label="이력 검색" value={query} onChange={event => setQuery(event.target.value)} placeholder={tab === 'merges' ? '닉네임, 계정 ID, 인증수단 검색' : '닉네임, 계정 ID, 상품, 거래번호 검색'} /><button>검색</button></form>
      {tab === 'purchases' && <select aria-label="구매 상태" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">전체 상태</option><option value="credited">지급 완료</option><option value="refunded">환불</option></select>}
    </div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {loading ? <div className="empty"><div className="spinner" />불러오는 중</div> : tab === 'merges' ?
      merges.length === 0 ? <div className="empty">조건에 맞는 계정 통합 이력이 없습니다</div> : <div className="account-history-list">{merges.map(item => <article key={item.merge_id}>
        <header><div><span className="history-badge">{providers[item.verified_provider]}</span><strong>{item.survivor_nickname ?? '삭제된 계정'}</strong></div><time>{dt(item.created_at)}</time></header>
        <div className="history-account-flow"><span><small>현재 canonical 계정</small><b>{shortId(item.survivor_account_id)}</b></span><i>← 통합</i><span><small>종료된 계정</small><b>{shortId(item.losing_account_id)}</b></span></div>
        <div className="history-metrics"><span>기존 포인트 <b>{item.survivor_balance.toLocaleString()}P</b></span><span>상대 포인트 <b>{item.losing_balance.toLocaleString()}P</b></span><span>최종 포인트 <b>{item.merged_balance.toLocaleString()}P</b></span><span>상대 원장 <b>{item.point_ledger_entries}건</b></span></div>
        <p className="history-policy">{policyLabel(item.asset_policy)}</p>
        <footer>삭제 기록 · 게시글 {item.deleted_posts} · 댓글 {item.deleted_comments} · 1:1 메시지 {item.deleted_messages} · 수다방 메시지 {item.deleted_open_chat_messages} · 대화카드 {item.deleted_conversation_cards} · 구매 연결 {item.deleted_purchases}</footer>
      </article>)}</div>
      : purchases.length === 0 ? <div className="empty">조건에 맞는 구매 증빙이 없습니다</div> : <div className="purchase-history-list">{purchases.map(item => <article key={item.receipt_id}>
        <header><div><span className={`history-status ${item.status}`}>{statuses[item.status]}</span><strong>{item.product_id}</strong></div><time>결제일시: {dt(item.purchased_at ?? item.created_at)}</time></header>
        <PurchasePayer item={item} />
        <section className="purchase-facts" aria-label="결제 정보">
          <dl>
            <div><dt>결제금액</dt><dd>{item.purchase_amount != null ? `${item.purchase_amount.toLocaleString()} ${item.purchase_currency ?? ''}` : `${item.price_won.toLocaleString()}원 (기준가)`}</dd></div>
            <div><dt>지급 포인트</dt><dd>{item.point_amount.toLocaleString()}P</dd></div>
            <div><dt>결제수단</dt><dd>{item.store}<small>{item.payment_provider} · {item.environment}</small></dd></div>
            <div><dt>결제 상태</dt><dd>{statuses[item.status]}{item.unrecovered_points > 0 && <small>미회수 {item.unrecovered_points.toLocaleString()}P</small>}</dd></div>
            <div><dt>거래 ID</dt><dd>{item.transaction_reference}</dd></div>
            <div><dt>결제 국가</dt><dd>{item.purchase_country_code ?? '확인 불가'}</dd></div>
            {item.refunded_at && <div><dt>환불일시</dt><dd>{dt(item.refunded_at)}</dd></div>}
            {item.account_deleted_at && <div><dt>계정정보 삭제일시</dt><dd>{dt(item.account_deleted_at)}</dd></div>}
          </dl>
        </section>
      </article>)}</div>}
  </>
}

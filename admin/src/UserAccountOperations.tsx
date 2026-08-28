import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import type { AccountOperations, AdminRole } from './types'

const providers: Record<string, string> = { google: 'Google', kakao: '카카오', phone: '휴대폰' }
const platforms: Record<string, string> = { android: 'Android', ios: 'iOS', web: '웹' }
const rewards: Record<string, string> = { attendance: '출석', talk_write: '톡 작성', board_post: '게시글 작성', board_comment: '댓글 작성', rewarded_ad: '광고 시청' }
const statuses = { pending: '서버 확인 대기', awarded: '50P 지급 완료', denied: '미지급 처리', expired: '확인 기한 만료' }
const dt = (value: string | null) => value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '-'
const errorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? '정보를 불러오지 못했습니다')
  if (/PGRST202|Could not find the function/.test(message)) return '관리자 API가 아직 적용되지 않았습니다. 데이터베이스 마이그레이션 110을 적용해 주세요.'
  if (/admin_required|admin_role_required/.test(message)) return '이 작업을 수행할 관리자 권한이 없습니다.'
  return message
}

// Parent keys this component by account ID. In-flight requests cannot update a
// newly selected user's view or submit actions against that user.
export function UserAccountOperations({ accountId, role }: { accountId: string; role: AdminRole }) {
  const [data, setData] = useState<AccountOperations | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const generation = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const canModerate = role === 'moderator' || role === 'owner'
  const load = useCallback(async () => {
    if (!supabase) return
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await supabase.rpc('admin_get_account_operations', { target_user_uuid: accountId })
      if (result.error) throw result.error
      if (!mounted.current || request !== generation.current) return
      const next = result.data as AccountOperations
      if (!next || next.account_id !== accountId) throw new Error('계정 정보가 일치하지 않습니다. 다시 조회해 주세요.')
      setData(next)
      setDeviceId(current => next.devices.some(d => d.id === current) ? current : next.devices[0]?.id ?? '')
    } catch (e) {
      if (mounted.current && request === generation.current) { setData(null); setError(errorMessage(e)) }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false)
    }
  }, [accountId])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; generation.current++ }
  }, [load])

  const revoke = async (id: string) => {
    if (!supabase || !canModerate || pending.current || loading || !data?.devices.some(d => d.id === id)) return
    if (reason.trim().length < 2) { setError('로그아웃 사유를 2글자 이상 입력해 주세요.'); return }
    if (!window.confirm('선택한 기기의 로그인 세션을 종료할까요? 다시 이용하려면 인증이 필요합니다. 계정 연결, 포인트와 보상 제한은 유지됩니다.')) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await supabase.rpc('admin_revoke_device_sessions', { target_user_uuid: accountId, target_device_uuid: id, admin_note: reason.trim() })
      if (result.error) throw result.error
      if (!mounted.current) return
      setReason(''); setNotice(`${Number(result.data.revoked_sessions)}개의 로그인 세션을 종료했습니다.`)
      await load()
    } catch (e) { if (mounted.current) setError(errorMessage(e)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  const device = data?.devices.find(d => d.id === deviceId)
  const deviceName = (id: string | null) => {
    const index = data?.devices.findIndex(d => d.id === id) ?? -1
    return index >= 0 ? `기기 ${index + 1}` : '이전 기기'
  }
  return <section className="account-operations" aria-label="로그인 및 보상 관리">
    <div className="account-section-head"><div><h3>로그인·보상 관리</h3><p className="muted">조회 시점 {data ? dt(data.checked_at) : '-'}</p></div><button onClick={() => void load()} disabled={loading || busy}>상태 새로고침</button></div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">계정과 보상 상태를 불러오는 중…</p>}
    {!loading && data && <>
      <h4>연결된 인증 수단</h4>
      <p className="muted">연결된 Google 또는 카카오 계정으로 인증하면 재설치 후 같은 앱 계정과 포인트를 복구할 수 있습니다. 서로 다른 앱 계정은 자동으로 합쳐지지 않습니다.</p>
      {data.identities.length ? <div className="account-provider-list">{data.identities.map(item => <article key={item.provider}><strong>{providers[item.provider] ?? item.provider}</strong><span>{item.active ? '인증 연결 유효' : '인증 상태 확인 필요'}</span><small>연결 {dt(item.linked_at)}</small></article>)}</div> : <p className="muted">연결된 인증 정보가 없습니다. 기존 계정 또는 삭제된 계정인지 확인해 주세요.</p>}
      <h4>등록 기기</h4>
      <p className="muted">현재 허용된 앱 세션 수이며 실제 접속 중인 사용자 수는 아닙니다. 로그아웃은 다음 서버 요청부터 적용되며 기기 등록과 복구 연결은 유지됩니다.</p>
      {canModerate && data.devices.length > 0 && <label className="account-reason">로그아웃 사유<input value={reason} maxLength={300} disabled={busy} onChange={e => setReason(e.target.value)} placeholder="조치 사유 (2~300자, 감사 기록에 저장)" /></label>}
      {!canModerate && <p className="muted">검토자는 조회만 가능합니다. 기기 로그아웃은 운영자 이상 권한이 필요합니다.</p>}
      {data.devices.length ? <div className="account-device-list">{data.devices.map((item, index) => <article key={item.id}><div><strong>기기 {index + 1} · {platforms[item.platform] ?? item.platform}{item.is_primary ? ' · 최초 등록' : ''}</strong><small>등록 {dt(item.created_at)}</small><small>허용된 세션 {item.active_sessions}개 · ID {item.id.slice(0, 8)}</small></div>{canModerate && <button onClick={() => void revoke(item.id)} disabled={busy || loading || Number(item.active_sessions) === 0}>기기 {index + 1} 로그아웃</button>}</article>)}</div> : <p className="muted">등록된 기기가 없습니다.</p>}
      <h4>기기별 50P 보상 제한</h4>
      <p className="muted">각 활동은 계정과 기기 모두 24시간이 지나야 다시 보상받을 수 있습니다. 같은 기기의 다른 계정에서 받은 보상도 제한에 포함됩니다. 수령 가능 표시는 실제 활동 및 서버 검증 완료를 대신하지 않습니다.</p>
      {!data.profile_active && <p role="status">현재 계정 상태에서는 보상을 지급할 수 없습니다.</p>}
      {data.devices.length > 0 && <label>확인할 기기<select value={deviceId} onChange={e => setDeviceId(e.target.value)}>{data.devices.map((item, index) => <option key={item.id} value={item.id}>기기 {index + 1} · {platforms[item.platform] ?? item.platform}</option>)}</select></label>}
      {device ? <div className="account-table-wrap"><table><thead><tr><th>활동</th><th>계정 최근 수령</th><th>기기 최근 수령</th><th>조회 시점 상태</th></tr></thead><tbody>{device.rewards.map(item => <tr key={item.type}><th>{rewards[item.type] ?? item.type}</th><td>{dt(item.account_claimed_at)}</td><td>{dt(item.device_claimed_at)}</td><td>{item.available ? '수령 가능' : !data.profile_active ? '계정 상태 제한' : `대기 · ${dt(item.next_available_at)} 이후`}</td></tr>)}</tbody></table></div> : <p className="muted">기기 정보가 없어 보상 가능 여부를 확인할 수 없습니다.</p>}
      <h4>광고 보상 요청 · 최근 30건</h4>
      <p className="muted">확인 대기는 광고 시청 완료의 증거가 아닙니다. 서명 검증에 실패한 요청은 이 내역에 저장되지 않습니다. 장애 조사는 서버 로그를 함께 확인해 주세요.</p>
      {data.ad_claims.length ? <div className="account-table-wrap"><table><thead><tr><th>요청 / 기기</th><th>요청 시각</th><th>결과</th><th>처리 시각 / 확인 기한</th></tr></thead><tbody>{data.ad_claims.map(item => <tr key={item.reference}><td>{item.reference}<small>{deviceName(item.device_id)}</small></td><td>{dt(item.created_at)}</td><td>{statuses[item.status]}</td><td>{dt(item.processed_at ?? item.expires_at)}</td></tr>)}</tbody></table></div> : <p className="muted">광고 보상 요청이 없습니다.</p>}
      <h4>서버 검증 기록 · 최근 30건</h4>
      {data.verifications.length ? <div className="account-table-wrap"><table><thead><tr><th>기록</th><th>검증 시각</th><th>보상 결과</th></tr></thead><tbody>{data.verifications.map(item => <tr key={item.id}><td>#{item.id} · {item.provider}</td><td>{dt(item.verified_at)}</td><td>{item.awarded ? '50P 지급 완료' : '미지급 (보상 제한 등)'}</td></tr>)}</tbody></table></div> : <p className="muted">수신된 서버 검증 기록이 없습니다.</p>}
    </>}
  </section>
}

import './setup'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountOperations } from '../types'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: mocks.rpc } }))
import { UserAccountOperations } from '../UserAccountOperations'

const fixture: AccountOperations = {
  account_id: 'account-a', checked_at: '2026-08-28T12:00:00Z', profile_active: true,
  identities: [{ provider: 'google', linked_at: '2026-08-25T12:00:00Z', active: true }, { provider: 'kakao', linked_at: '2026-08-26T12:00:00Z', active: false }],
  devices: [{ id: 'device-a', platform: 'android', is_primary: true, created_at: '2026-08-25T12:00:00Z', active_sessions: 1, rewards: [{ type: 'attendance', account_claimed_at: null, device_claimed_at: null, available: true, next_available_at: null }] },
    { id: 'device-b', platform: 'ios', is_primary: false, created_at: '2026-08-26T12:00:00Z', active_sessions: 0, rewards: [{ type: 'rewarded_ad', account_claimed_at: null, device_claimed_at: '2026-08-28T11:00:00Z', available: false, next_available_at: '2026-08-29T11:00:00Z' }] }],
  ad_claims: ['pending', 'awarded', 'denied', 'expired'].map((status, i) => ({ reference: `safe-ref-${i}`, device_id: 'device-a', created_at: '2026-08-28T12:00:00Z', expires_at: '2026-08-29T12:00:00Z', processed_at: null, status: status as AccountOperations['ad_claims'][number]['status'] })),
  verifications: [{ id: 123, provider: 'admob', awarded: true, verified_at: '2026-08-28T12:00:00Z' }],
}

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue({ data: fixture, error: null })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('account operations', () => {
  it('shows providers, all ad states and selected device cooldown without mutation controls for reviewers', async () => {
    render(<UserAccountOperations accountId="account-a" role="reviewer" />)
    expect(await screen.findByText('Google')).toBeInTheDocument()
    expect(screen.getByText('인증 상태 확인 필요')).toBeInTheDocument()
    expect(screen.getByText('서버 확인 대기')).toBeInTheDocument()
    expect(screen.getAllByText('50P 지급 완료')).toHaveLength(2)
    expect(screen.getByText('미지급 처리')).toBeInTheDocument()
    expect(screen.getByText('확인 기한 만료')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /로그아웃/ })).not.toBeInTheDocument()
    expect(screen.getByText('수령 가능')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'device-b' } })
    expect(screen.getByText('광고 시청')).toBeInTheDocument()
    expect(screen.queryByText('수령 가능')).not.toBeInTheDocument()
    expect(screen.getByText(/대기 ·/)).toBeInTheDocument()
  })

  it('requires a reason and confirmation, scopes mutation, disables repeats and refreshes result', async () => {
    let complete!: (value: unknown) => void
    mocks.rpc.mockImplementation((name: string) => name === 'admin_revoke_device_sessions' ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ data: fixture, error: null }))
    render(<UserAccountOperations accountId="account-a" role="moderator" />)
    const button = await screen.findByRole('button', { name: '기기 1 로그아웃' })
    expect(screen.getByRole('button', { name: '기기 2 로그아웃' })).toBeDisabled()
    fireEvent.click(button)
    expect(screen.getByRole('alert')).toHaveTextContent('사유를 2글자 이상')
    fireEvent.change(screen.getByLabelText('로그아웃 사유'), { target: { value: ' 고객 요청 ' } })
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    fireEvent.click(button)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    fireEvent.click(button); fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_revoke_device_sessions', { target_user_uuid: 'account-a', target_device_uuid: 'device-a', admin_note: '고객 요청' })
    await act(async () => complete({ data: { revoked_sessions: 1 }, error: null }))
    expect(await screen.findByText('1개의 로그인 세션을 종료했습니다.')).toBeInTheDocument()
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_get_account_operations', { target_user_uuid: 'account-a' })
  })

  it('handles RPC errors and permits retry without displaying stale data', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function' } })
    render(<UserAccountOperations accountId="account-a" role="owner" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('마이그레이션 110')
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }))
    expect(await screen.findByText('Google')).toBeInTheDocument()
    mocks.rpc.mockRejectedValueOnce(new Error('network unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable')
    expect(screen.queryByText('Google')).not.toBeInTheDocument()
  })

  it('ignores an old account response after selection changes', async () => {
    let complete!: (value: unknown) => void
    mocks.rpc.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    const { rerender } = render(<UserAccountOperations key="a" accountId="account-a" role="owner" />)
    mocks.rpc.mockResolvedValue({ data: { ...fixture, account_id: 'account-b', identities: [], devices: [] }, error: null })
    rerender(<UserAccountOperations key="b" accountId="account-b" role="owner" />)
    await screen.findByText('등록된 기기가 없습니다.')
    await act(async () => complete({ data: fixture, error: null }))
    expect(screen.queryByText('Google')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /로그아웃/ })).not.toBeInTheDocument()
  })

  it('shows safe empty states and rejects mismatched account data', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ...fixture, identities: [], devices: [], ad_claims: [], verifications: [], profile_active: false }, error: null })
    render(<UserAccountOperations accountId="account-a" role="owner" />)
    expect(await screen.findByText('광고 보상 요청이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('현재 계정 상태에서는 보상을 지급할 수 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('기기 정보가 없어 보상 가능 여부를 확인할 수 없습니다.')).toBeInTheDocument()
    mocks.rpc.mockResolvedValueOnce({ data: { ...fixture, account_id: 'wrong' }, error: null })
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('계정 정보가 일치하지 않습니다'))
  })
})

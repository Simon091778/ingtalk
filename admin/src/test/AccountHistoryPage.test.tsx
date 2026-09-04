import './setup'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../supabase', () => ({ supabase: { rpc } }))
import { AccountHistoryPage } from '../AccountHistoryPage'

const merge = {
  merge_id: '10000000-0000-4000-8000-000000000001', survivor_account_id: '11000000-0000-4000-8000-000000000011',
  survivor_nickname: '현재사용자', losing_account_id: '12000000-0000-4000-8000-000000000012', verified_provider: 'google',
  survivor_balance: 100, losing_balance: 300, merged_balance: 300, asset_policy: 'discard_losing_assets',
  deleted_posts: 2, deleted_comments: 3, deleted_messages: 4, deleted_purchases: 1,
  deleted_conversation_cards: 5, deleted_open_chat_messages: 6, point_ledger_entries: 7, created_at: '2026-09-01T01:00:00Z',
}
const purchase = {
  receipt_id: '20000000-0000-4000-8000-000000000002', user_id: '21000000-0000-4000-8000-000000000021', nickname: '결제사용자',
  payer: {
    original_account_id: '21000000-0000-4000-8000-000000000021', canonical_account_id: '22000000-0000-4000-8000-000000000022',
    operational_account_id: '21000000-0000-4000-8000-000000000021', nickname: '결제사용자', canonical_nickname: '현재결제계정',
    account_status: 'merged', canonical_account_status: 'active', merged: true,
    phone: { status: 'active', phone: '+821012345678', verified_at: '2026-08-28T01:00:00Z' },
    google: { status: 'active', email: 'payer@example.com', verified_at: '2026-08-29T01:00:00Z' },
    kakao: { status: 'active', verified_at: '2026-08-30T01:00:00Z' },
  },
  payment_provider: 'revenuecat',
  product_id: 'kr.ingtalk.points.3000', point_amount: 3000, price_won: 3000, purchase_currency: 'KRW', purchase_amount: 3000,
  purchase_country_code: 'KR', store: 'PLAY_STORE', environment: 'SANDBOX', status: 'refunded', unrecovered_points: 100,
  transaction_reference: 'abcd…123456', purchased_at: '2026-08-31T01:00:00Z', refunded_at: '2026-09-01T01:00:00Z',
  account_deleted_at: null, created_at: '2026-08-31T01:00:00Z',
}
const deletedPurchase = {
  ...purchase,
  receipt_id: '23000000-0000-4000-8000-000000000023', user_id: null, nickname: null,
  payer: {
    original_account_id: '23000000-0000-4000-8000-000000000099', operational_account_id: null,
    canonical_account_id: null, nickname: null, canonical_nickname: null, account_status: 'deleted', canonical_account_status: null, merged: false,
    phone: { status: 'none', phone: null, verified_at: null }, google: { status: 'none', email: null, verified_at: null },
    kakao: { status: 'none', verified_at: null },
  },
  account_deleted_at: '2026-09-01T00:00:00Z',
}

describe('계정·결제 이력', () => {
  beforeEach(() => {
    rpc.mockReset()
    rpc.mockImplementation(async (name: string) => name === 'admin_list_account_merges'
      ? { data: [merge], error: null } : { data: [purchase], error: null })
  })

  it('통합 계정과 포인트 및 삭제 자산 요약을 표시한다', async () => {
    render(<AccountHistoryPage />)
    expect(await screen.findByText('현재사용자')).toBeInTheDocument()
    expect(screen.getByText('현재 계정 유지 · 상대 자산 삭제')).toBeInTheDocument()
    expect(screen.getByText(/게시글 2 · 댓글 3 · 1:1 메시지 4/)).toBeInTheDocument()
    expect(rpc).toHaveBeenCalledWith('admin_list_account_merges', { search_text: null, result_limit: 200 })
  })

  it('구매 증빙에서 결제자와 모든 현재 인증수단 및 결제 정보를 함께 표시한다', async () => {
    const user = userEvent.setup()
    render(<AccountHistoryPage />)
    await screen.findByText('현재사용자')
    await user.click(screen.getByRole('button', { name: '구매 증빙' }))
    expect(await screen.findByText('결제사용자')).toBeInTheDocument()
    expect(screen.getByText('010-1234-5678')).toBeInTheDocument()
    expect(screen.getByText('payer@example.com')).toBeInTheDocument()
    expect(screen.getByText('카카오 로그인 연결')).toBeInTheDocument()
    expect(screen.getByText('현재 Canonical Account')).toBeInTheDocument()
    expect(screen.getByText('3,000 KRW')).toBeInTheDocument()
    expect(screen.getByText('revenuecat · SANDBOX')).toBeInTheDocument()
    expect(screen.getByText('abcd…123456')).toBeInTheDocument()
    expect(screen.getByText('미회수 100P')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('구매 상태'), 'refunded')
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('admin_list_point_purchases', { search_text: null, status_filter: 'refunded', result_limit: 200 }))
  })

  it('삭제되어 identity가 없는 결제도 개인정보를 복원하지 않고 결제 증빙을 표시한다', async () => {
    rpc.mockImplementation(async (name: string) => name === 'admin_list_account_merges'
      ? { data: [merge], error: null } : { data: [deletedPurchase], error: null })
    const user = userEvent.setup()
    render(<AccountHistoryPage />)
    await screen.findByText('현재사용자')
    await user.click(screen.getByRole('button', { name: '구매 증빙' }))
    expect(await screen.findByText('탈퇴·삭제된 계정')).toBeInTheDocument()
    expect(screen.getByText('23000000-0000-4000-8000-000000000099')).toBeInTheDocument()
    expect(screen.getAllByText('연결 없음')).toHaveLength(7)
    expect(screen.getByText('abcd…123456')).toBeInTheDocument()
    expect(screen.getByText('계정정보 삭제일시')).toBeInTheDocument()
  })

  it('검색어를 서버 RPC에 전달한다', async () => {
    const user = userEvent.setup()
    render(<AccountHistoryPage />)
    await screen.findByText('현재사용자')
    await user.type(screen.getByLabelText('이력 검색'), '현재사용자')
    await user.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('admin_list_account_merges', { search_text: '현재사용자', result_limit: 200 }))
  })
})

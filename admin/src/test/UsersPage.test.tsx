import './setup'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../UserAccountOperations', () => ({ UserAccountOperations: ({ accountId }: { accountId: string }) => <div>계정 관리 대상 {accountId}</div> }))
import { UsersPage } from '../UsersPage'

const user = (id: string) => ({ user_id: id, nickname: `이용자${id}`, status: 'active', point_balance: 50, talk_count: 0, post_count: 0, comment_count: 0, report_count: 0, action_count: 0 })
const detail = (id: string) => ({ profile: { id, nickname: `이용자${id}`, status: 'active', gender: 'male', birth_year: 1990, created_at: '2026-08-28T00:00:00Z', updated_at: '2026-08-28T00:00:00Z', point_balance: 50 }, talks: [], posts: [], comments: [], reports: [], actions: [], point_transactions: [{ id: 1, amount: 50, reason: 'reward_rewarded_ad', created_at: '2026-08-28T00:00:00Z' }] })
beforeEach(() => { mocks.rpc.mockReset() })

it('opens account operations for the selected user and labels rewarded ad points', async () => {
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'admin_search_users' ? [user('A')] : name === 'admin_get_user_detail' ? detail('A') : [], error: null }))
  render(<UsersPage role="reviewer" />)
  fireEvent.click(await screen.findByRole('button', { name: /이용자A/ }))
  fireEvent.click(await screen.findByRole('button', { name: '로그인·보상' }))
  expect(screen.getByText('계정 관리 대상 A')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '포인트' }))
  expect(screen.getByText('광고 시청 보상')).toBeInTheDocument()
})

it('does not restore the previous user when detail responses arrive out of order', async () => {
  let complete!: (value: unknown) => void
  mocks.rpc.mockImplementation((name: string, args: { target_user_uuid?: string }) => {
    if (name === 'admin_get_user_detail' && args.target_user_uuid === 'A') return new Promise(resolve => { complete = resolve })
    return Promise.resolve({ data: name === 'admin_search_users' ? [user('A'), user('B')] : name === 'admin_get_user_detail' ? detail('B') : [], error: null })
  })
  render(<UsersPage role="owner" />)
  fireEvent.click(await screen.findByRole('button', { name: /이용자A/ }))
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('admin_get_user_detail', { target_user_uuid: 'A' }))
  fireEvent.click(screen.getByRole('button', { name: /이용자B/ }))
  expect(await screen.findByRole('heading', { name: '이용자B' })).toBeInTheDocument()
  await act(async () => complete({ data: detail('A'), error: null }))
  expect(screen.queryByRole('heading', { name: '이용자A' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '로그인·보상' }))
  expect(screen.getByText('계정 관리 대상 B')).toBeInTheDocument()
})

import './setup'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../UserAccountOperations', () => ({ UserAccountOperations: ({ accountId }: { accountId: string }) => <div>계정 관리 대상 {accountId}</div> }))
import { UsersPage } from '../UsersPage'

const user = (id: string) => ({ user_id: id, nickname: `이용자${id}`, status: 'active', point_balance: 50, talk_count: 0, post_count: 0, comment_count: 0, report_count: 0, action_count: 0 })
const detail = (id: string) => ({ profile: { id, nickname: `이용자${id}`, status: 'active', gender: 'male', birth_year: 1990, created_at: '2026-08-28T00:00:00Z', updated_at: '2026-08-28T00:00:00Z', point_balance: 50 }, talks: [], posts: [], comments: [], reports: [], actions: [], point_transactions: [{ id: 1, amount: 50, reason: 'reward_rewarded_ad', created_at: '2026-08-28T00:00:00Z' }, { id: 2, amount: -100, reason: 'open_chat_room_create', created_at: '2026-09-01T00:00:00Z' }] })
beforeEach(() => { mocks.rpc.mockReset() })

it('opens account operations and labels rewarded ad and room creation points', async () => {
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'admin_search_users' ? [user('A')] : name === 'admin_get_user_detail' ? detail('A') : [], error: null }))
  render(<UsersPage role="reviewer" />)
  fireEvent.click(await screen.findByRole('button', { name: /이용자A/ }))
  fireEvent.click(await screen.findByRole('button', { name: '로그인·보상' }))
  expect(screen.getByText('계정 관리 대상 A')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '포인트' }))
  expect(screen.getByText('광고 시청 보상')).toBeInTheDocument()
  expect(screen.getByText('수다방 만들기')).toBeInTheDocument()
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

it('uses one non-URL search field for nickname, ID, phone and Google email', async () => {
  mocks.rpc.mockResolvedValue({ data: [], error: null })
  render(<UsersPage role="reviewer" />)
  const input = screen.getByPlaceholderText('닉네임, ID, 전화번호, Google 이메일 검색')
  const initialUrl = window.location.href

  fireEvent.change(input, { target: { value: ' 010-1234-5678 ' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(mocks.rpc).toHaveBeenLastCalledWith('admin_search_users', {
    search_text: '010-1234-5678', status_filter: null, result_limit: 200,
  }))

  fireEvent.change(input, { target: { value: ' User.Example@Gmail.com ' } })
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(mocks.rpc).toHaveBeenLastCalledWith('admin_search_users', {
    search_text: 'User.Example@Gmail.com', status_filter: null, result_limit: 200,
  }))
  expect(window.location.href).toBe(initialUrl)
})

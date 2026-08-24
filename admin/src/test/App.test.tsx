import type { Session } from '@supabase/supabase-js'
import './setup'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as Session | null,
  role: 'owner' as 'reviewer' | 'moderator' | 'owner',
  signInError: null as { message: string } | null,
}))

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../supabase', () => ({
  configured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: state.session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: mocks.unsubscribe } } })),
      signInWithPassword: mocks.signInWithPassword,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
  },
}))

vi.mock('../UsersPage', () => ({ UsersPage: () => <h1>이용자 관리 화면</h1> }))
vi.mock('../AuditPage', () => ({ AuditPage: () => <h1>감사 기록 화면</h1> }))
vi.mock('../SupportPage', () => ({ SupportPage: () => <h1>고객 문의 화면</h1> }))
vi.mock('../ChatOperationsPage', () => ({ ChatOperationsPage: () => <h1>대화 기록 화면</h1> }))

import App from '../App'

const adminSession = { user: { id: 'admin-user' } } as Session

function configureAdmin(role: typeof state.role = 'owner') {
  state.session = adminSession
  state.role = role
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'admin_me') return { data: [{ user_id: 'admin-user', email: 'admin@ingtalk.test', role }], error: null }
    if (name === 'admin_dashboard_stats') return {
      data: { open_reports: 12, reviewing_reports: 3, urgent_reports: 2, suspended_users: 4, actions_today: 7 },
      error: null,
    }
    if (name === 'admin_list_reports') return { data: [], error: null }
    return { data: null, error: null }
  })
}

describe('관리자 페이지', () => {
  beforeEach(() => {
    state.session = null
    state.role = 'owner'
    state.signInError = null
    mocks.rpc.mockReset()
    mocks.signInWithPassword.mockReset()
    mocks.signInWithPassword.mockImplementation(async () => ({ error: state.signInError }))
    mocks.signOut.mockResolvedValue({ error: null })
  })

  it('세션이 없으면 운영자 로그인 화면을 표시한다', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: '잉톡 운영센터' })).toBeInTheDocument()
    expect(screen.getByLabelText('운영자 이메일')).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('비밀번호')).toHaveAttribute('type', 'password')
  })

  it('잘못된 로그인 정보를 사용자에게 안전한 문구로 안내한다', async () => {
    state.signInError = { message: 'invalid credentials' }
    const user = userEvent.setup()
    render(<App />)

    await user.type(await screen.findByLabelText('운영자 이메일'), 'wrong@example.com')
    await user.type(screen.getByLabelText('비밀번호'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: '안전하게 로그인' }))

    expect(await screen.findByText('이메일 또는 비밀번호를 확인해 주세요')).toBeInTheDocument()
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'wrong@example.com', password: 'wrong-password' })
  })

  it('운영자 세션을 확인하고 대시보드 통계를 표시한다', async () => {
    configureAdmin('owner')
    render(<App />)

    expect(await screen.findByRole('heading', { name: '안전 대시보드' })).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('admin@ingtalk.test')).toBeInTheDocument()
    expect(mocks.rpc).toHaveBeenCalledWith('admin_me')
    expect(mocks.rpc).toHaveBeenCalledWith('admin_dashboard_stats')
  })

  it('최고 관리자는 핵심 운영 메뉴를 모두 이동할 수 있다', async () => {
    configureAdmin('owner')
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: '안전 대시보드' })

    await user.click(screen.getByRole('button', { name: /이용자 관리/ }))
    expect(screen.getByRole('heading', { name: '이용자 관리 화면' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /감사 기록/ }))
    expect(screen.getByRole('heading', { name: '감사 기록 화면' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /고객 문의/ }))
    expect(screen.getByRole('heading', { name: '고객 문의 화면' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /대화 기록/ }))
    expect(screen.getByRole('heading', { name: '대화 기록 화면' })).toBeInTheDocument()
  })

  it('검토자에게는 대화 기록 메뉴를 노출하지 않는다', async () => {
    configureAdmin('reviewer')
    render(<App />)
    await screen.findByRole('heading', { name: '안전 대시보드' })

    expect(screen.queryByRole('button', { name: /대화 기록/ })).not.toBeInTheDocument()
    expect(screen.getByText('검토자')).toBeInTheDocument()
  })

  it('로그아웃 버튼이 Supabase 세션 종료를 호출한다', async () => {
    configureAdmin('moderator')
    render(<App />)
    await screen.findByRole('heading', { name: '안전 대시보드' })

    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }))
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1))
  })
})

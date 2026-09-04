import './setup'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: mocks.rpc } }))
import { ContentOperationsPage } from '../ContentOperationsPage'

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'admin_list_open_chat_rooms') return { data: [{
      room_id: 'room-a', title: '운영 수다방', category: '수다', room_status: 'active', owner_user_id: 'owner-a',
      owner_nickname: '방장', member_count: 2, max_members: 10, message_count: 4, report_count: 1,
      created_at: '2026-08-01T00:00:00Z', last_user_message_at: '2026-08-31T00:00:00Z',
      inactivity_warning_at: null, closed_at: null, closed_reason: null,
    }], error: null }
    if (name === 'admin_get_open_chat_room') return { data: {
      room: { id: 'room-a', title: '운영 수다방', description: '소개', notice: '', category: '수다', region: null, tags: [], status: 'active', owner_user_id: 'owner-a', owner_nickname: '방장', max_members: 10, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-31T00:00:00Z', last_user_message_at: '2026-08-31T00:00:00Z', inactivity_warning_at: null, closed_at: null, closed_reason: null, cover_storage_path: null },
      participants: [{ user_id: 'owner-a', nickname: '방장', account_status: 'active', joined_at: '2026-08-01T00:00:00Z', is_owner: true }], bans: [], messages: [],
    }, error: null }
    if (name === 'admin_list_public_content') return { data: [], error: null }
    return { data: null, error: null }
  })
})

it('loads open chats and exposes room operations to moderators', async () => {
  render(<ContentOperationsPage role="moderator" />)
  expect(await screen.findByText('운영 수다방')).toBeInTheDocument()
  fireEvent.click(screen.getByText('운영 수다방'))
  expect(await screen.findByRole('button', { name: '수다방 종료·전원 퇴장' })).toBeInTheDocument()
  expect(mocks.rpc).toHaveBeenCalledWith('admin_get_open_chat_room', { target_room_uuid: 'room-a' })
})

it('keeps destructive controls hidden from reviewers and switches content areas', async () => {
  render(<ContentOperationsPage role="reviewer" />)
  await screen.findByText('운영 수다방')
  expect(screen.queryByText('조치 사유')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '톡쓰기' }))
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('admin_list_public_content', expect.objectContaining({ content_filter: 'talk' })))
})

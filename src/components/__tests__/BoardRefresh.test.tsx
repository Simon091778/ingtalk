import { act, render } from '@testing-library/react-native'
import { AppState, Keyboard } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Board } from '../Board'
import { supabase } from '../../lib/supabase'

jest.mock('../../lib/supabase', () => ({ supabase: { rpc: jest.fn(), channel: jest.fn(), removeChannel: jest.fn() } }))
jest.mock('../../lib/phoneAuth', () => ({ getAccountId: jest.fn().mockResolvedValue('viewer') }))
jest.mock('../BoardBannerAd', () => ({ BoardBannerAd: () => null }))

test('hidden board drops subscriptions and keyboard listeners; return preserves posts pending validation', async () => {
  const listeners: Array<{ kind: string; remove: jest.Mock }> = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => { const s = { kind: 'app', remove: jest.fn() }; listeners.push(s); return s })
  jest.spyOn(Keyboard, 'addListener').mockImplementation(() => { const s = { kind: 'keyboard', remove: jest.fn() }; listeners.push(s); return s as unknown as ReturnType<typeof Keyboard.addListener> })
  const channel = { on: jest.fn(), subscribe: jest.fn() }
  channel.on.mockReturnValue(channel); channel.subscribe.mockReturnValue(channel)
  jest.mocked(supabase!.channel).mockReturnValue(channel as never)
  const post = { id: 'post', author_id: 'peer', nickname: 'Author', title: 'retained post', body: 'body', created_at: '2026-09-04T00:00:00Z' }
  jest.mocked(supabase!.rpc).mockResolvedValue({ data: [post], error: null } as never)
  const tree = (active: boolean) => <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}><Board isActive={active} /></SafeAreaProvider>
  const screen = render(tree(true))
  await screen.findByText('retained post')
  screen.rerender(tree(false))
  expect(supabase!.removeChannel).toHaveBeenCalledWith(channel)
  expect(listeners.every(s => s.remove.mock.calls.length === 1)).toBe(true)
  let finish!: (value: unknown) => void
  jest.mocked(supabase!.rpc).mockImplementation(() => new Promise(resolve => { finish = resolve }) as never)
  screen.rerender(tree(true))
  expect(screen.getByText('retained post')).toBeTruthy()
  await act(async () => {})
  await act(async () => finish({ data: [{ ...post, title: 'validated post' }], error: null }))
  expect(screen.getByText('validated post')).toBeTruthy()
  screen.unmount()
  jest.restoreAllMocks()
})

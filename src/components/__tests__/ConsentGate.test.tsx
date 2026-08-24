import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { ConsentGate } from '../ConsentGate'
import { requestConsentPermissions } from '../../lib/consentPermissions'

jest.mock('../../lib/consentPermissions', () => ({ requestConsentPermissions: jest.fn().mockResolvedValue(undefined) }))

describe('ConsentGate', () => {
  it('필수·선택 항목을 기본 선택하고 동의 결과를 저장한다', async () => {
    const onComplete = jest.fn()
    const screen = render(<ConsentGate onComplete={onComplete} />)

    await waitFor(() => expect(screen.getByText('동의하고 시작하기')).toBeTruthy())
    fireEvent.press(screen.getByText('동의하고 시작하기'))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ location: true, notifications: true }))
    expect(requestConsentPermissions).toHaveBeenCalledWith({ location: true, notifications: true })
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'ingtalk.consent.v4',
      expect.stringContaining('adultConfirmedAt'),
    )
  })

  it('필수 약관을 해제하면 시작할 수 없다', async () => {
    const onComplete = jest.fn()
    const screen = render(<ConsentGate onComplete={onComplete} />)

    await waitFor(() => expect(screen.getByText('서비스 이용약관 동의')).toBeTruthy())
    fireEvent.press(screen.getByText('서비스 이용약관 동의'))
    fireEvent.press(screen.getByText('동의하고 시작하기'))

    expect(onComplete).not.toHaveBeenCalled()
    expect(requestConsentPermissions).not.toHaveBeenCalled()
  })

  it('성인 확인을 해제하면 시작할 수 없다', async () => {
    const onComplete = jest.fn()
    const screen = render(<ConsentGate onComplete={onComplete} />)

    await waitFor(() => expect(screen.getByText('본인은 만 19세 이상입니다')).toBeTruthy())
    fireEvent.press(screen.getByText('본인은 만 19세 이상입니다'))
    fireEvent.press(screen.getByText('동의하고 시작하기'))

    expect(onComplete).not.toHaveBeenCalled()
    expect(requestConsentPermissions).not.toHaveBeenCalled()
  })

  it('선택 권한을 해제해도 앱을 시작할 수 있고 OS 권한을 요청하지 않는다', async () => {
    const onComplete = jest.fn()
    const screen = render(<ConsentGate onComplete={onComplete} />)

    await waitFor(() => expect(screen.getByText('위치 접근 권한')).toBeTruthy())
    fireEvent.press(screen.getByText('위치 접근 권한'))
    fireEvent.press(screen.getByText('알림 수신 권한'))
    fireEvent.press(screen.getByText('동의하고 시작하기'))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ location: false, notifications: false }))
    expect(requestConsentPermissions).toHaveBeenCalledWith({ location: false, notifications: false })
  })

  it('저장된 동의가 있으면 권한 팝업을 다시 표시하지 않고 복원한다', async () => {
    localStorage.setItem('ingtalk.consent.v4', JSON.stringify({
      acceptedAt: '2026-08-20T00:00:00.000Z',
      adultConfirmedAt: '2026-08-20T00:00:00.000Z',
      permissions: { location: false, notifications: true },
    }))
    const onComplete = jest.fn()

    render(<ConsentGate onComplete={onComplete} />)

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ location: false, notifications: true }))
    expect(requestConsentPermissions).not.toHaveBeenCalled()
  })
})

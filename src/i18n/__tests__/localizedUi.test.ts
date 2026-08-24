import { localizeText, setLocalizedUiLanguage } from '../localizedUi'
import { Fragment, createElement } from 'react'
import { render } from '@testing-library/react-native'
import { Text } from '../localizedUi'
import { formatDateTime, formatTime } from '..'

describe('localized UI', () => {
  afterEach(() => setLocalizedUiLanguage('ko'))

  it('keeps the Korean interface unchanged', () => {
    setLocalizedUiLanguage('ko')
    expect(localizeText('게시판')).toBe('게시판')
  })

  it('uses the regional brand name', () => {
    setLocalizedUiLanguage('en', 'US')
    expect(localizeText('잉톡')).toBe('Ingtalk')
    expect(localizeText('잉톡 운영자')).toBe('Ingtalk Support')
    setLocalizedUiLanguage('en', 'OTHER')
    expect(localizeText('잉톡')).toBe('Ingtalk')
    setLocalizedUiLanguage('en', 'KR')
    expect(localizeText('잉톡')).toBe('Ingtalk')
    setLocalizedUiLanguage('ko', 'US')
    expect(localizeText('잉톡')).toBe('잉톡')
  })

  it('translates navigation, onboarding, board, chat, and account labels', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('게시판')).toBe('Board')
    expect(localizeText('동의하고 시작하기')).toBe('Agree and continue')
    expect(localizeText('익명 게시판')).toBe('Anonymous Board')
    expect(localizeText('대화 상대 신고')).toBe('Report user')
    expect(localizeText('회원 탈퇴')).toBe('Delete account')
  })

  it('localizes dynamic time and interaction labels', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('12분 전')).toBe('12m ago')
    expect(localizeText('좋아요 7')).toBe('Like 7')
    expect(localizeText('민지님에게')).toBe('To 민지')
  })

  it('translates dynamic Discover and Chats gender labels', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('남30대 초반')).toBe('M Early 30s')
    expect(localizeText('여20대 후반')).toBe('F Late 20s')
    expect(localizeText('(남34세)')).toBe('(M 34)')
    expect(localizeText(' (여29세)')).toBe(' (F 29)')
    expect(localizeText('(기타25세)')).toBe('(O 25)')
  })

  it('formats dates and times with the selected language and country', () => {
    const value = '2026-08-22T03:05:00.000Z'
    expect(formatDateTime(value, 'en', 'US')).not.toMatch(/[가-힣]/)
    expect(formatDateTime(value, 'en', 'US', true)).toContain('2026')
    expect(formatDateTime(value, 'ko', 'KR', true)).toContain('2026')
    expect(formatTime(value, 'en', 'US')).not.toMatch(/[가-힣]/)
    expect(formatDateTime(value, 'ko', 'KR')).toMatch(/8/)
  })

  it('translates composite discovery, board search, and permission labels', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('아직 주변에 등록된 대화 카드가 없어요.')).toBe('No nearby talk cards yet.')
    expect(localizeText('화면을 아래로 당겨 새로고침해 보세요.')).toBe('Pull down to refresh.')
    expect(localizeText('⌕ 검색')).toBe('⌕ Search')
    expect(`${localizeText('위치, 사진, 알림 등 기기 권한 관리 · ')}2/2${localizeText(' 허용')}`).toBe('Manage location, photo, and notification permissions · 2/2 allowed')
  })

  it('translates the App Store and Google Play payment notice', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('결제는 Apple App Store 또는 Google Play에서 처리됩니다. 실제 청구 금액은 결제 확인 화면의 현지 통화 가격을 기준으로 합니다.'))
      .toBe('Payments are processed through the Apple App Store or Google Play. The actual amount charged is based on the local-currency price shown on the purchase confirmation screen.')
  })

  it('shows corresponding English anonymous board aliases', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('다정한수달')).toBe('Kind Otter')
    expect(localizeText('호기심많은이야기꾼')).toBe('Curious Storyteller')
    expect(localizeText('푸른하늘')).toBe('Blue Sky')
    setLocalizedUiLanguage('ko')
    expect(localizeText('다정한수달')).toBe('다정한수달')
  })

  it('translates the nested Discover empty-state fragment', () => {
    setLocalizedUiLanguage('en')
    const screen = render(createElement(Text, null,
      createElement(Fragment, null, '아직 주변에 등록된 대화 카드가 없어요.', '\n', '화면을 아래로 당겨 새로고침해 보세요.'),
    ))
    expect(screen.getByText('No nearby talk cards yet.\nPull down to refresh.')).toBeTruthy()
  })

  it('preserves React keys while localizing mixed Text children', () => {
    setLocalizedUiLanguage('en')
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    render(createElement(Text, null, '현재 포인트', ' · ', createElement(Text, null, '충전하기')))
    expect(consoleError.mock.calls.some(call => String(call[0]).includes('unique "key" prop'))).toBe(false)
    consoleError.mockRestore()
  })

  it('does not alter user-authored Korean content', () => {
    setLocalizedUiLanguage('en')
    expect(localizeText('오늘 저녁 같이 산책하실 분')).toBe('오늘 저녁 같이 산책하실 분')
  })
})

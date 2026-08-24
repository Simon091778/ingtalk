import { PUBLIC_CONTENT_BLOCKED_MESSAGE, publicContentErrorMessage } from '../contentModeration'

describe('publicContentErrorMessage', () => {
  it('서버 필터 오류를 사용자용 문구로 변환한다', () => {
    expect(publicContentErrorMessage(new Error('public_content_blocked'), '실패')).toBe(PUBLIC_CONTENT_BLOCKED_MESSAGE)
  })
  it('일반 서버 오류는 원래 문구를 유지한다', () => {
    expect(publicContentErrorMessage({ message: 'network_error' }, '실패')).toBe('network_error')
  })
  it('오류 문구가 없으면 지정한 기본 문구를 사용한다', () => {
    expect(publicContentErrorMessage(null, '저장하지 못했습니다.')).toBe('저장하지 못했습니다.')
  })
})

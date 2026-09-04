import { elapsedFromIso, formatDiscoveryElapsedSeconds, formatDistanceMeters, formatElapsedMinutes } from '../displayFormat'

describe('발견 시간 표시', () => {
  test.each([
    [0, '0초 전'],
    [1, '1초 전'],
    [59, '59초 전'],
    [60, '1분 전'],
    [61, '1분 전'],
    [119, '1분 전'],
    [120, '2분 전'],
  ])('%i초를 %s으로 표시한다', (seconds, expected) => {
    expect(formatDiscoveryElapsedSeconds(seconds)).toBe(expected)
  })

  it('미래 시각으로 계산된 음수 경과값은 0초로 제한한다', () => {
    expect(formatDiscoveryElapsedSeconds(-1)).toBe('0초 전')
  })
})

describe('시간 표시', () => {
  test.each([
    [0, '0분 전'],
    [59, '59분 전'],
    [60, '1시간 전'],
    [1439, '23시간 전'],
    [1440, '1일 전'],
    [2881, '2일 전'],
  ])('%i분을 %s으로 표시한다', (minutes, expected) => {
    expect(formatElapsedMinutes(minutes)).toBe(expected)
  })

  it('60초가 지나지 않은 ISO 시각은 0분 전으로 표시한다', () => {
    const now = Date.parse('2026-08-20T10:00:00.000Z')
    expect(elapsedFromIso('2026-08-20T09:59:40.000Z', now)).toBe('0분 전')
    expect(elapsedFromIso('2026-08-20T09:59:00.000Z', now)).toBe('1분 전')
    expect(elapsedFromIso('2026-08-20T10:00:10.000Z', now)).toBe('0분 전')
  })
})

describe('거리 표시', () => {
  test.each([
    [null, false, '? km'],
    [Number.NaN, false, '? km'],
    [0, false, '0km'],
    [900, false, '0km'],
    [999, false, '0km'],
    [1000, false, '1km'],
    [1001, false, '1km'],
    [1900, false, '1km'],
    [2000, false, '2km'],
    [15500, false, '15km'],
    [50000, false, '50km'],
    [50000, true, '내 글'],
  ])('거리 %s, 내 글 %s를 %s으로 표시한다', (meters, isMine, expected) => {
    expect(formatDistanceMeters(meters, isMine)).toBe(expected)
  })
})

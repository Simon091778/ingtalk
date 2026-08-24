export const PUBLIC_CONTENT_BLOCKED_MESSAGE = '공개 글에는 불법·유해 표현, 연락처 또는 외부 오픈채팅 링크를 사용할 수 없어요.'

export function publicContentErrorMessage(reason: unknown, fallback: string) {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === 'object' && reason !== null && 'message' in reason
      ? String(reason.message)
      : ''
  return message.includes('public_content_blocked') ? PUBLIC_CONTENT_BLOCKED_MESSAGE : message || fallback
}

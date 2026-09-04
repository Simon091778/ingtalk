export const formatAdminDateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value))
  : '-'

export const formatAdminPhone = (value: string) => {
  const normalized = value.trim()
  const koreanMobile = normalized.match(/^\+?82(10)(\d{3,4})(\d{4})$/)
  return koreanMobile ? `0${koreanMobile[1]}-${koreanMobile[2]}-${koreanMobile[3]}` : normalized
}

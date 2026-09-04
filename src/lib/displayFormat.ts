export function formatElapsedMinutes(value: number) {
  const minutes = Math.max(0, Math.floor(value))
  if (minutes < 60) return `${minutes}분 전`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`
  return `${Math.floor(minutes / 1440)}일 전`
}

export function formatDiscoveryElapsedSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value))
  if (seconds < 60) return `${seconds}초 전`
  return formatElapsedMinutes(seconds / 60)
}

export function elapsedFromIso(value: string, now = Date.now()) {
  const elapsedMinutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000))
  return formatElapsedMinutes(elapsedMinutes)
}

export function formatDistanceMeters(distanceMeters?: number | null, isMine = false) {
  if (isMine) return '내 글'
  if (distanceMeters == null || !Number.isFinite(distanceMeters)) return '? km'
  return `${Math.floor(Math.max(0, distanceMeters) / 1000)}km`
}

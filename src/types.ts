export type TalkPurpose = '수다' | '대화' | '취미' | '친구' | '연애' | '고민상담' | '만남' | '식사' | '산책'

export type TalkCard = {
  id: string
  authorId: string
  nickname: string
  ageRange: string
  region: string
  purpose: TalkPurpose
  topic: string
  trustLabel: string
  gender?: 'male' | 'female' | 'other' | 'private' | null
  avatarUrl?: string | null
  minutesAgo: number
  elapsedSeconds?: number
  distanceMeters?: number | null
  isMine?: boolean
}

export type ChatPreview = {
  id: string
  nickname: string
  message: string
  time: string
  unread: number
}

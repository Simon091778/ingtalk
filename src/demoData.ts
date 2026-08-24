import type { ChatPreview, TalkCard } from './types'

export const talkCards: TalkCard[] = [
  {
    id: 'card-1', authorId: 'demo-1', nickname: '소담', ageRange: '20대 후반',
    region: '서울 마포', purpose: '취미', topic: '이번 주말 전시 같이 볼 사람 있나요?',
    trustLabel: '따뜻한 대화자', minutesAgo: 8, distanceMeters: 1200,
  },
  {
    id: 'card-2', authorId: 'demo-2', nickname: '여름밤', ageRange: '30대 초반',
    region: '경기 성남', purpose: '수다', topic: '오늘 하루 어땠는지 편하게 이야기해요.',
    trustLabel: '본인 인증', minutesAgo: 14, distanceMeters: 4800,
  },
  {
    id: 'card-3', authorId: 'demo-3', nickname: '파란구름', ageRange: '30대 중반',
    region: '서울 송파', purpose: '친구', topic: '주말 아침 한강 러닝 메이트를 찾아요!',
    trustLabel: '믿을 수 있는 대화자', minutesAgo: 31, distanceMeters: 8700,
  },
]

export const chatPreviews: ChatPreview[] = [
  { id: 'chat-1', nickname: '소담', message: '저도 그 전시 궁금했어요!', time: '오후 8:42', unread: 2 },
  { id: 'chat-2', nickname: '여름밤', message: '오늘은 조금 바쁜 하루였네요 😌', time: '어제', unread: 0 },
]

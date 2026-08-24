import type { AppLanguage } from '../i18n'

const adjectives: Array<[string, string]> = [
  ['고요한', 'Quiet'], ['다정한', 'Kind'], ['솔직한', 'Honest'], ['따뜻한', 'Warm'], ['유쾌한', 'Cheerful'], ['느긋한', 'Easygoing'], ['반짝이는', 'Sparkling'], ['자유로운', 'Free'],
  ['씩씩한', 'Brave'], ['포근한', 'Cozy'], ['신나는', 'Excited'], ['수줍은', 'Shy'], ['명랑한', 'Bright'], ['차분한', 'Calm'], ['용감한', 'Courageous'], ['산뜻한', 'Fresh'],
  ['부드러운', 'Gentle'], ['재치있는', 'Witty'], ['행복한', 'Happy'], ['설레는', 'Thrilled'], ['꿈꾸는', 'Dreaming'], ['노래하는', 'Singing'], ['여행하는', 'Traveling'], ['웃음많은', 'Smiling'],
  ['호기심많은', 'Curious'], ['생각깊은', 'Thoughtful'], ['마음넓은', 'Openhearted'], ['상냥한', 'Sweet'], ['활기찬', 'Lively'], ['담백한', 'Sincere'], ['기분좋은', 'Sunny'], ['정겨운', 'Friendly'],
  ['여유로운', 'Relaxed'], ['낭만적인', 'Romantic'], ['순수한', 'Pure'], ['당당한', 'Confident'], ['빛나는', 'Shining'], ['사려깊은', 'Considerate'], ['푸근한', 'Comforting'], ['새로운', 'New'],
]

const nouns: Array<[string, string]> = [
  ['고양이', 'Cat'], ['여우', 'Fox'], ['토끼', 'Rabbit'], ['수달', 'Otter'], ['다람쥐', 'Squirrel'], ['펭귄', 'Penguin'], ['돌고래', 'Dolphin'], ['고래', 'Whale'],
  ['참새', 'Sparrow'], ['부엉이', 'Owl'], ['알파카', 'Alpaca'], ['판다', 'Panda'], ['코알라', 'Koala'], ['사슴', 'Deer'], ['강아지', 'Puppy'], ['라쿤', 'Raccoon'],
  ['하늘', 'Sky'], ['구름', 'Cloud'], ['별빛', 'Starlight'], ['달빛', 'Moonlight'], ['햇살', 'Sunshine'], ['노을', 'Sunset'], ['바람', 'Breeze'], ['파도', 'Wave'],
  ['숲길', 'Forest Path'], ['호수', 'Lake'], ['바다', 'Sea'], ['민들레', 'Dandelion'], ['라일락', 'Lilac'], ['튤립', 'Tulip'], ['장미', 'Rose'], ['소나무', 'Pine'],
  ['단풍', 'Maple'], ['오로라', 'Aurora'], ['은하수', 'Milky Way'], ['유성', 'Meteor'], ['여행자', 'Traveler'], ['탐험가', 'Explorer'], ['사진가', 'Photographer'], ['이야기꾼', 'Storyteller'],
]

const legacy: Record<string, string> = {
  푸른하늘: 'Blue Sky', 파란고래: 'Blue Whale', 푸른바다: 'Blue Sea', 파란여우: 'Blue Fox', 푸른별빛: 'Blue Starlight', 파란구름: 'Blue Cloud', 푸른나무: 'Blue Tree', 파란새: 'Blue Bird',
  붉은노을: 'Red Sunset', 빨간장미: 'Red Rose', 붉은여우: 'Red Fox', 빨간사과: 'Red Apple', 붉은별빛: 'Red Starlight', 빨간구름: 'Red Cloud', 붉은튤립: 'Red Tulip', 빨간새: 'Red Bird',
  익명달빛: 'Anonymous Moonlight', 익명바람: 'Anonymous Breeze', 익명나무: 'Anonymous Tree', 익명구름: 'Anonymous Cloud', 익명별빛: 'Anonymous Starlight', 익명여우: 'Anonymous Fox',
}

export function boardAliasDisplayName(name: string | null, language: AppLanguage) {
  if (!name || language === 'ko') return name ?? ''
  if (legacy[name]) return legacy[name]
  for (const [koreanAdjective, englishAdjective] of adjectives) {
    if (!name.startsWith(koreanAdjective)) continue
    const koreanNoun = name.slice(koreanAdjective.length)
    const noun = nouns.find(([candidate]) => candidate === koreanNoun)
    if (noun) return `${englishAdjective} ${noun[1]}`
  }
  return name
}

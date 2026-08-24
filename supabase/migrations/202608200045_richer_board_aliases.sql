-- Expand anonymous board aliases with adjective + noun combinations.
-- Existing aliases stay unchanged; new posts and first-time commenters use this generator.

create or replace function public.generate_board_alias(profile_gender text)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  adjectives text[] := array[
    '고요한', '다정한', '솔직한', '따뜻한', '유쾌한', '느긋한', '반짝이는', '자유로운',
    '씩씩한', '포근한', '신나는', '수줍은', '명랑한', '차분한', '용감한', '산뜻한',
    '부드러운', '재치있는', '행복한', '설레는', '꿈꾸는', '노래하는', '여행하는', '웃음많은',
    '호기심많은', '생각깊은', '마음넓은', '상냥한', '활기찬', '담백한', '기분좋은', '정겨운',
    '여유로운', '낭만적인', '순수한', '당당한', '빛나는', '사려깊은', '푸근한', '새로운'
  ];
  nouns text[] := array[
    '고양이', '여우', '토끼', '수달', '다람쥐', '펭귄', '돌고래', '고래',
    '참새', '부엉이', '알파카', '판다', '코알라', '사슴', '강아지', '라쿤',
    '하늘', '구름', '별빛', '달빛', '햇살', '노을', '바람', '파도',
    '숲길', '호수', '바다', '민들레', '라일락', '튤립', '장미', '소나무',
    '단풍', '오로라', '은하수', '유성', '여행자', '탐험가', '사진가', '이야기꾼'
  ];
  adjective text;
  noun text;
begin
  -- Gender is intentionally not encoded in the name itself. The app continues
  -- to distinguish it with the existing blue/red anonymous-name color.
  perform profile_gender;
  adjective := adjectives[1 + floor(random() * array_length(adjectives, 1))::int];
  noun := nouns[1 + floor(random() * array_length(nouns, 1))::int];
  return adjective || noun;
end;
$$;

revoke all on function public.generate_board_alias(text) from public;

notify pgrst, 'reload schema';

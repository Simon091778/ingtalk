-- Expand the allowed purposes shown in the card writer.
alter table public.conversation_cards
  drop constraint if exists conversation_cards_purpose_check;

alter table public.conversation_cards
  add constraint conversation_cards_purpose_check
  check (purpose in (
    '수다',
    '취미 친구',
    '동네 친구',
    '연애',
    '고민 상담',
    '만남',
    '식사',
    '산책'
  ));

notify pgrst, 'reload schema';

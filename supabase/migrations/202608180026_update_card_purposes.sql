-- Simplify and split conversation-card purpose labels.

alter table public.conversation_cards
  drop constraint if exists conversation_cards_purpose_check;

update public.conversation_cards
set purpose = case purpose
  when '취미 친구' then '취미'
  when '동네 친구' then '친구'
  when '고민 상담' then '고민상담'
  else purpose
end
where purpose in ('취미 친구', '동네 친구', '고민 상담');

alter table public.conversation_cards
  add constraint conversation_cards_purpose_check
  check (purpose in ('수다', '취미', '친구', '연애', '고민상담', '만남', '식사', '산책'));

notify pgrst, 'reload schema';

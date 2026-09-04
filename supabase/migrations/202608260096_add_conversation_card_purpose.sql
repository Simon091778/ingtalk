-- Add "대화" as a conversation-card purpose.

alter table public.conversation_cards
  drop constraint if exists conversation_cards_purpose_check;

alter table public.conversation_cards
  add constraint conversation_cards_purpose_check
  check (purpose in ('수다', '대화', '취미', '친구', '연애', '고민상담', '만남', '식사', '산책'))
  not valid;

notify pgrst, 'reload schema';

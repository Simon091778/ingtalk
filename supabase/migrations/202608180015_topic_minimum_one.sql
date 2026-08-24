-- Allow short conversation topics while still rejecting empty text.
alter table public.conversation_cards
  drop constraint if exists conversation_cards_topic_check;

alter table public.conversation_cards
  add constraint conversation_cards_topic_check
  check (char_length(trim(topic)) between 1 and 120);

notify pgrst, 'reload schema';

-- Notify discovery feeds when a conversation card is created or changed.
do $$
begin
  alter publication supabase_realtime add table public.conversation_cards;
exception when duplicate_object then null;
end $$;


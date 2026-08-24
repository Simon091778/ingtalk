-- Active talk posts stay visible until their owner replaces or deletes them.
alter table public.conversation_cards
alter column expires_at set default 'infinity'::timestamptz;

update public.conversation_cards
set expires_at = 'infinity'::timestamptz
where is_active;

create or replace function public.keep_active_conversation_card_visible()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active then
    new.expires_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

drop trigger if exists keep_active_conversation_card_visible on public.conversation_cards;
create trigger keep_active_conversation_card_visible
before insert or update of is_active, expires_at on public.conversation_cards
for each row execute function public.keep_active_conversation_card_visible();

notify pgrst, 'reload schema';

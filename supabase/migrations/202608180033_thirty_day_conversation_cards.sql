-- Talk posts remain discoverable for 30 days from their latest write/edit time.
alter table public.conversation_cards
alter column expires_at set default now() + interval '30 days';

create or replace function public.keep_active_conversation_card_visible()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active then
    new.expires_at := new.created_at + interval '30 days';
  end if;
  return new;
end;
$$;

update public.conversation_cards
set expires_at = created_at + interval '30 days'
where is_active;

update public.conversation_cards
set is_active = false
where is_active and expires_at <= now();

notify pgrst, 'reload schema';

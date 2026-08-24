-- A user may expose only one active discovery card at a time.
-- Old rows are retained so accepted chat/request history is not broken.
with ranked_cards as (
  select
    id,
    row_number() over (
      partition by author_id
      order by created_at desc, id desc
    ) as position
  from public.conversation_cards
  where is_active
)
update public.conversation_cards c
set is_active = false
from ranked_cards r
where c.id = r.id
  and r.position > 1;

create unique index if not exists conversation_cards_one_active_per_author_idx
  on public.conversation_cards(author_id)
  where is_active;

create or replace function public.publish_conversation_card(
  card_purpose text,
  card_topic text,
  card_interests text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_card_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  ) then
    raise exception 'active_profile_required';
  end if;

  -- Serialize simultaneous submissions from the same anonymous user.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  update public.conversation_cards
  set is_active = false
  where author_id = auth.uid()
    and is_active;

  insert into public.conversation_cards (
    author_id,
    purpose,
    topic,
    interests,
    is_active,
    created_at,
    expires_at
  ) values (
    auth.uid(),
    card_purpose,
    card_topic,
    coalesce(card_interests, '{}'),
    true,
    now(),
    now() + interval '24 hours'
  )
  returning id into new_card_id;

  return new_card_id;
end;
$$;

revoke all on function public.publish_conversation_card(text, text, text[]) from public;
grant execute on function public.publish_conversation_card(text, text, text[]) to authenticated;

notify pgrst, 'reload schema';

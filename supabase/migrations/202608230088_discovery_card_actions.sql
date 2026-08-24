-- A user may dismiss another user's discovery card without deleting its source.
create table if not exists public.hidden_discovery_cards (
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id uuid not null references public.conversation_cards(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, card_id)
);
alter table public.hidden_discovery_cards enable row level security;
revoke all on public.hidden_discovery_cards from public, anon, authenticated;

create or replace function public.hide_discovery_card(card_uuid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.conversation_cards where id = card_uuid and author_id <> auth.uid()) then
    raise exception 'card_not_available';
  end if;
  insert into public.hidden_discovery_cards(user_id, card_id)
  values (auth.uid(), card_uuid) on conflict do nothing;
end;
$$;

create or replace function public.block_discovery_user(blocked_user_uuid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if blocked_user_uuid is null or blocked_user_uuid = auth.uid() then raise exception 'invalid_block_target'; end if;
  if not exists (select 1 from public.profiles where id = blocked_user_uuid) then raise exception 'profile_not_found'; end if;
  insert into public.blocks(blocker_id, blocked_id) values (auth.uid(), blocked_user_uuid)
  on conflict do nothing;
  update public.chat_requests set status = 'cancelled', responded_at = now()
  where status = 'pending'
    and ((sender_id = auth.uid() and receiver_id = blocked_user_uuid)
      or (sender_id = blocked_user_uuid and receiver_id = auth.uid()));
end;
$$;

drop function if exists public.discover_conversation_cards(boolean, integer, integer, text);
create function public.discover_conversation_cards(
  include_distance boolean default true,
  max_distance_meters integer default 50000,
  result_limit integer default 30,
  country_filter text default null
)
returns table (
  id uuid, author_id uuid, nickname text, birth_year integer, region_code text,
  avatar_url text, gender text, purpose text, topic text, interests text[],
  trust_score integer, created_at timestamptz, distance_meters integer
)
language sql stable security definer set search_path = public, extensions as $$
  select c.id, c.author_id, p.nickname, p.birth_year, p.region_code, p.avatar_url,
    case when p.gender = 'private' then null else p.gender end,
    c.purpose, c.topic, c.interests, p.trust_score, c.created_at,
    case when include_distance and me.position is not null and other_location.position is not null
      and other_location.updated_at > now() - interval '24 hours'
      then (round(extensions.st_distance(me.position, other_location.position) / 100.0) * 100)::integer else null end
  from public.conversation_cards c
  join public.profiles p on p.id = c.author_id and p.status = 'active'
  left join public.user_locations other_location on other_location.user_id = c.author_id
  left join public.user_locations me on me.user_id = auth.uid()
  where c.is_active and c.expires_at > now() and c.author_id <> auth.uid()
    and (country_filter is null or c.country_group = country_filter)
    and not exists (select 1 from public.hidden_discovery_cards hidden where hidden.user_id = auth.uid() and hidden.card_id = c.id)
    and (not include_distance or max_distance_meters is null or me.position is null or other_location.position is null
      or extensions.st_distance(me.position, other_location.position) <= max_distance_meters)
    and not exists (select 1 from public.blocks b where
      (b.blocker_id = auth.uid() and b.blocked_id = c.author_id) or
      (b.blocker_id = c.author_id and b.blocked_id = auth.uid()))
  order by c.created_at desc, c.id desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.hide_discovery_card(uuid) from public, anon;
revoke all on function public.block_discovery_user(uuid) from public, anon;
revoke all on function public.discover_conversation_cards(boolean, integer, integer, text) from public, anon;
grant execute on function public.hide_discovery_card(uuid) to authenticated;
grant execute on function public.block_discovery_user(uuid) to authenticated;
grant execute on function public.discover_conversation_cards(boolean, integer, integer, text) to authenticated;
notify pgrst, 'reload schema';

-- Allow the discovery feed to load additional 100-card pages while preserving
-- the same distance, country, hidden-card, and block filters.
drop function if exists public.discover_conversation_cards(boolean, integer, integer, text);
drop function if exists public.discover_conversation_cards(boolean, integer, integer, text, integer);

create function public.discover_conversation_cards(
  include_distance boolean default true,
  max_distance_meters integer default 50000,
  result_limit integer default 30,
  country_filter text default null,
  result_offset integer default 0
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
    case when include_distance and me.position is not null and card_location.position is not null
      then (round(extensions.st_distance(me.position, card_location.position) / 100.0) * 100)::integer
      else null end
  from public.conversation_cards c
  join public.profiles p on p.id = c.author_id and p.status = 'active'
  left join public.conversation_card_locations card_location on card_location.card_id = c.id
  left join public.user_locations me on me.user_id = auth.uid()
  where c.is_active and c.expires_at > now() and c.author_id <> auth.uid()
    and (country_filter is null or c.country_group = country_filter)
    and not exists (
      select 1 from public.hidden_discovery_cards hidden
      where hidden.user_id = auth.uid() and hidden.card_id = c.id
        and hidden.hidden_at >= c.created_at
    )
    and (not include_distance or max_distance_meters is null or me.position is null or card_location.position is null
      or extensions.st_distance(me.position, card_location.position) <= max_distance_meters)
    and not exists (select 1 from public.blocks b where
      (b.blocker_id = auth.uid() and b.blocked_id = c.author_id) or
      (b.blocker_id = c.author_id and b.blocked_id = auth.uid()))
  order by c.created_at desc, c.id desc
  limit least(greatest(result_limit, 1), 100)
  offset greatest(result_offset, 0);
$$;

revoke all on function public.discover_conversation_cards(boolean, integer, integer, text, integer) from public, anon;
grant execute on function public.discover_conversation_cards(boolean, integer, integer, text, integer) to authenticated;
notify pgrst, 'reload schema';

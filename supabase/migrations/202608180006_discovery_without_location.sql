-- Discovery remains available when a user declines location access.
-- Exact coordinates stay private; distance is returned only when requested and available.
create or replace function public.discover_conversation_cards(
  include_distance boolean default true,
  max_distance_meters integer default 50000,
  result_limit integer default 30
)
returns table (
  id uuid,
  author_id uuid,
  nickname text,
  birth_year integer,
  region_code text,
  purpose text,
  topic text,
  interests text[],
  trust_score integer,
  created_at timestamptz,
  distance_meters integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    c.id,
    c.author_id,
    p.nickname,
    p.birth_year,
    p.region_code,
    c.purpose,
    c.topic,
    c.interests,
    p.trust_score,
    c.created_at,
    case
      when include_distance
        and me.position is not null
        and other_location.position is not null
        and other_location.updated_at > now() - interval '24 hours'
      then (round(extensions.st_distance(me.position, other_location.position) / 100.0) * 100)::integer
      else null
    end as distance_meters
  from public.conversation_cards c
  join public.profiles p on p.id = c.author_id and p.status = 'active'
  left join public.user_locations other_location on other_location.user_id = c.author_id
  left join public.user_locations me on me.user_id = auth.uid()
  where c.is_active
    and c.expires_at > now()
    and c.author_id <> auth.uid()
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = c.author_id)
         or (b.blocker_id = c.author_id and b.blocked_id = auth.uid())
    )
    and (
      not include_distance
      or me.position is null
      or other_location.position is null
      or other_location.updated_at <= now() - interval '24 hours'
      or extensions.st_dwithin(
        me.position,
        other_location.position,
        least(greatest(max_distance_meters, 1000), 100000)
      )
    )
  order by
    case
      when include_distance and me.position is not null and other_location.position is not null
      then extensions.st_distance(me.position, other_location.position)
      else null
    end nulls last,
    c.created_at desc
  limit least(greatest(result_limit, 1), 50);
$$;

revoke all on function public.discover_conversation_cards(boolean, integer, integer) from public;
grant execute on function public.discover_conversation_cards(boolean, integer, integer) to authenticated;

-- Keep exact coordinates private and expose only rounded distances through an RPC.
create extension if not exists postgis with schema extensions;

create table if not exists public.user_locations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  position extensions.geography(point, 4326) not null,
  accuracy_meters real,
  updated_at timestamptz not null default now()
);

create index if not exists user_locations_position_idx
  on public.user_locations using gist (position);

alter table public.user_locations enable row level security;

drop policy if exists "users read own location" on public.user_locations;
create policy "users read own location"
on public.user_locations for select to authenticated
using (user_id = auth.uid());

drop policy if exists "users insert own location" on public.user_locations;
create policy "users insert own location"
on public.user_locations for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists "users update own location" on public.user_locations;
create policy "users update own location"
on public.user_locations for update to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.user_locations from anon;
grant select, insert, update on public.user_locations to authenticated;

create or replace function public.update_my_location(
  latitude double precision,
  longitude double precision,
  accuracy_meters real default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if latitude < -90 or latitude > 90 or longitude < -180 or longitude > 180 then
    raise exception 'invalid_coordinates';
  end if;

  insert into public.user_locations(user_id, position, accuracy_meters, updated_at)
  values (
    auth.uid(),
    extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography,
    accuracy_meters,
    now()
  )
  on conflict (user_id) do update set
    position = excluded.position,
    accuracy_meters = excluded.accuracy_meters,
    updated_at = now();
end;
$$;

revoke all on function public.update_my_location(double precision, double precision, real) from public;
grant execute on function public.update_my_location(double precision, double precision, real) to authenticated;

create or replace function public.nearby_conversation_cards(
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
    (round(extensions.st_distance(me.position, other_location.position) / 100.0) * 100)::integer
  from public.conversation_cards c
  join public.profiles p on p.id = c.author_id and p.status = 'active'
  join public.user_locations other_location on other_location.user_id = c.author_id
  join public.user_locations me on me.user_id = auth.uid()
  where c.is_active
    and c.expires_at > now()
    and c.author_id <> auth.uid()
    and other_location.updated_at > now() - interval '24 hours'
    and extensions.st_dwithin(me.position, other_location.position, least(greatest(max_distance_meters, 1000), 100000))
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = c.author_id)
         or (b.blocker_id = c.author_id and b.blocked_id = auth.uid())
    )
  order by me.position operator(extensions.<->) other_location.position
  limit least(greatest(result_limit, 1), 50);
$$;

revoke all on function public.nearby_conversation_cards(integer, integer) from public;
grant execute on function public.nearby_conversation_cards(integer, integer) to authenticated;


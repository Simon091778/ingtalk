-- Freeze each discovery card's location at publish/edit time. Exact coordinates
-- live in a locked table and are exposed only as a rounded distance.
create table public.conversation_card_locations (
  card_id uuid primary key references public.conversation_cards(id) on delete cascade,
  position extensions.geography(point, 4326) not null,
  accuracy_meters real,
  captured_at timestamptz not null default now()
);

create index conversation_card_locations_position_idx
  on public.conversation_card_locations using gist (position);

alter table public.conversation_card_locations enable row level security;
revoke all on public.conversation_card_locations from public, anon, authenticated;

-- Give already-published cards a best-effort snapshot from the author's last
-- known location. New and edited cards always use coordinates captured by the app.
insert into public.conversation_card_locations(card_id, position, accuracy_meters, captured_at)
select card.id, location.position, location.accuracy_meters, card.created_at
from public.conversation_cards card
join public.user_locations location on location.user_id = card.author_id
where card.is_active and card.expires_at > now()
on conflict (card_id) do nothing;

create function public.publish_conversation_card(
  card_purpose text,
  card_topic text,
  card_latitude double precision,
  card_longitude double precision,
  card_accuracy_meters real default null
)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare new_card_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'active') then
    raise exception 'active_profile_required';
  end if;
  if (card_latitude is null) <> (card_longitude is null) then raise exception 'invalid_location'; end if;
  if card_latitude is not null and (card_latitude < -90 or card_latitude > 90 or card_longitude < -180 or card_longitude > 180) then
    raise exception 'invalid_location';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  update public.conversation_cards set is_active = false where author_id = auth.uid() and is_active;
  insert into public.conversation_cards(author_id, purpose, topic, interests, is_active, created_at, expires_at)
  values (auth.uid(), card_purpose, trim(card_topic), '{}', true, now(), now() + interval '30 days')
  returning id into new_card_id;

  if card_latitude is not null then
    insert into public.conversation_card_locations(card_id, position, accuracy_meters)
    values (
      new_card_id,
      extensions.st_setsrid(extensions.st_makepoint(card_longitude, card_latitude), 4326)::extensions.geography,
      card_accuracy_meters
    );
  end if;

  perform public.award_daily_action('talk_write', new_card_id);
  return new_card_id;
end;
$$;

create function public.update_my_conversation_card(
  card_uuid uuid,
  card_purpose text,
  card_topic text,
  card_latitude double precision,
  card_longitude double precision,
  card_accuracy_meters real default null
)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare updated_card_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if (card_latitude is null) <> (card_longitude is null) then raise exception 'invalid_location'; end if;
  if card_latitude is not null and (card_latitude < -90 or card_latitude > 90 or card_longitude < -180 or card_longitude > 180) then
    raise exception 'invalid_location';
  end if;

  update public.conversation_cards
  set purpose = card_purpose, topic = trim(card_topic), interests = '{}',
    created_at = now(), expires_at = now() + interval '30 days'
  where id = card_uuid and author_id = auth.uid() and is_active
  returning id into updated_card_id;
  if updated_card_id is null then raise exception 'card_not_available'; end if;

  delete from public.conversation_card_locations where card_id = updated_card_id;
  if card_latitude is not null then
    insert into public.conversation_card_locations(card_id, position, accuracy_meters)
    values (
      updated_card_id,
      extensions.st_setsrid(extensions.st_makepoint(card_longitude, card_latitude), 4326)::extensions.geography,
      card_accuracy_meters
    );
  end if;
  return updated_card_id;
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
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.publish_conversation_card(text, text, double precision, double precision, real) from public, anon;
revoke all on function public.update_my_conversation_card(uuid, text, text, double precision, double precision, real) from public, anon;
revoke all on function public.discover_conversation_cards(boolean, integer, integer, text) from public, anon;
grant execute on function public.publish_conversation_card(text, text, double precision, double precision, real) to authenticated;
grant execute on function public.update_my_conversation_card(uuid, text, text, double precision, double precision, real) to authenticated;
grant execute on function public.discover_conversation_cards(boolean, integer, integer, text) to authenticated;
notify pgrst, 'reload schema';

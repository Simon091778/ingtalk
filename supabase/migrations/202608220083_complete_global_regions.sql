-- Preserve actual ISO country preferences while grouping public feeds into
-- Korea, United States, and other regions.
alter table public.profiles drop constraint if exists profiles_country_code_check;
alter table public.profiles add constraint profiles_country_code_check
  check (country_code = 'OTHER' or country_code ~ '^[A-Z]{2}$');

create or replace function public.update_my_regional_preferences(next_language text, next_country text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if next_language not in ('ko', 'en')
     or not (next_country = 'OTHER' or next_country ~ '^[A-Z]{2}$') then
    raise exception 'invalid_regional_preferences';
  end if;
  update public.profiles
  set language_code = next_language, country_code = next_country, updated_at = now()
  where id = auth.uid();
  if not found then raise exception 'profile_not_found'; end if;
end;
$$;

alter table public.conversation_cards add column if not exists country_group text;
update public.conversation_cards card
set country_group = case when profile.country_code in ('KR', 'US') then profile.country_code else 'OTHER' end
from public.profiles profile
where profile.id = card.author_id and card.country_group is null;
update public.conversation_cards set country_group = 'KR' where country_group is null;
alter table public.conversation_cards alter column country_group set not null;
alter table public.conversation_cards alter column country_group set default 'KR';
alter table public.conversation_cards drop constraint if exists conversation_cards_country_group_check;
alter table public.conversation_cards add constraint conversation_cards_country_group_check check (country_group in ('KR', 'US', 'OTHER'));
create index if not exists conversation_cards_country_created_idx on public.conversation_cards(country_group, created_at desc);

create or replace function public.snapshot_public_content_country()
returns trigger language plpgsql security definer set search_path = public as $$
declare actual_country text;
begin
  select country_code into actual_country from public.profiles where id = new.author_id;
  if tg_table_name = 'conversation_cards' then
    new.country_group := case when actual_country in ('KR', 'US') then actual_country else 'OTHER' end;
  else
    new.country_code := case when actual_country in ('KR', 'US') then actual_country else 'OTHER' end;
  end if;
  return new;
end;
$$;

drop trigger if exists snapshot_conversation_card_country on public.conversation_cards;
create trigger snapshot_conversation_card_country before insert on public.conversation_cards
for each row execute function public.snapshot_public_content_country();
drop trigger if exists snapshot_board_post_country on public.board_posts;
create trigger snapshot_board_post_country before insert on public.board_posts
for each row execute function public.snapshot_public_content_country();

drop function if exists public.discover_conversation_cards(boolean, integer, integer);
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
    and (not include_distance or max_distance_meters is null or me.position is null or other_location.position is null
      or extensions.st_distance(me.position, other_location.position) <= max_distance_meters)
    and not exists (select 1 from public.blocks b where
      (b.blocker_id = auth.uid() and b.blocked_id = c.author_id) or
      (b.blocker_id = c.author_id and b.blocked_id = auth.uid()))
  order by c.created_at desc, c.id desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.discover_conversation_cards(boolean, integer, integer, text) from public, anon;
grant execute on function public.discover_conversation_cards(boolean, integer, integer, text) to authenticated;
revoke all on function public.snapshot_public_content_country() from public, anon, authenticated;
grant execute on function public.update_my_regional_preferences(text, text) to authenticated;
notify pgrst, 'reload schema';

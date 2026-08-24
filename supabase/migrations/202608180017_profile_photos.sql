alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "public reads avatars" on storage.objects;
create policy "public reads avatars" on storage.objects for select to public using (bucket_id = 'avatars');
drop policy if exists "users upload own avatar" on storage.objects;
create policy "users upload own avatar" on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users update own avatar" on storage.objects;
create policy "users update own avatar" on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users delete own avatar" on storage.objects;
create policy "users delete own avatar" on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop function if exists public.discover_conversation_cards(boolean, integer, integer);
create function public.discover_conversation_cards(
  include_distance boolean default true,
  max_distance_meters integer default 50000,
  result_limit integer default 30
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
      then (round(extensions.st_distance(me.position, other_location.position) / 100.0) * 100)::integer
      else null end
  from public.conversation_cards c
  join public.profiles p on p.id = c.author_id and p.status = 'active'
  left join public.user_locations other_location on other_location.user_id = c.author_id
  left join public.user_locations me on me.user_id = auth.uid()
  where c.is_active and c.expires_at > now() and c.author_id <> auth.uid()
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = c.author_id)
         or (b.blocker_id = c.author_id and b.blocked_id = auth.uid())
    )
  order by case when include_distance and me.position is not null and other_location.position is not null
    then extensions.st_distance(me.position, other_location.position) else null end nulls last,
    c.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.discover_conversation_cards(boolean, integer, integer) from public;
grant execute on function public.discover_conversation_cards(boolean, integer, integer) to authenticated;
notify pgrst, 'reload schema';

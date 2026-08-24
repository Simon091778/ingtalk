-- Add an optional image to anonymous board posts.

alter table public.board_posts add column if not exists image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('board-images', 'board-images', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public reads board images" on storage.objects;
create policy "public reads board images" on storage.objects for select to public
using (bucket_id = 'board-images');

drop policy if exists "users upload own board images" on storage.objects;
create policy "users upload own board images" on storage.objects for insert to authenticated
with check (bucket_id = 'board-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users delete own board images" on storage.objects;
create policy "users delete own board images" on storage.objects for delete to authenticated
using (bucket_id = 'board-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop function if exists public.create_board_post(text, text);
drop function if exists public.create_board_post(text, text, text);
create function public.create_board_post(post_title text, post_body text, post_image_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare profile_gender text; post_uuid uuid; previous_alias text; new_alias text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(post_title)) not between 1 and 60 then raise exception 'invalid_post_title'; end if;
  if char_length(trim(post_body)) not between 1 and 500 then raise exception 'invalid_post_length'; end if;
  select gender into profile_gender from public.profiles where id = auth.uid() and status = 'active';
  if not found then raise exception 'active_profile_required'; end if;
  select anonymous_name into previous_alias from public.board_posts where author_id = auth.uid() order by created_at desc limit 1;
  loop
    new_alias := public.generate_board_alias(profile_gender);
    exit when previous_alias is null or new_alias <> previous_alias;
  end loop;
  insert into public.board_posts(author_id, title, body, image_url, anonymous_name, anonymous_gender)
  values (auth.uid(), trim(post_title), trim(post_body), nullif(trim(post_image_url), ''), new_alias,
    case when profile_gender in ('male','female') then profile_gender else 'neutral' end)
  returning id into post_uuid;
  return post_uuid;
end;
$$;

drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (
  id uuid, author_id uuid, nickname text, gender text, title text, body text, image_url text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean
)
language sql stable security definer set search_path = public as $$
  select
    post.id, post.author_id, post.anonymous_name, post.anonymous_gender, post.title, post.body, post.image_url, post.created_at,
    (select count(*) from public.board_comments comment where comment.post_id = post.id),
    post.view_count,
    (select count(*) from public.board_post_likes liked where liked.post_id = post.id),
    exists (select 1 from public.board_post_likes mine where mine.post_id = post.id and mine.user_id = auth.uid())
  from public.board_posts post order by post.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.create_board_post(text, text, text) from public;
grant execute on function public.create_board_post(text, text, text) to authenticated;
revoke all on function public.list_board_posts(integer) from public;
grant execute on function public.list_board_posts(integer) to authenticated;
notify pgrst, 'reload schema';

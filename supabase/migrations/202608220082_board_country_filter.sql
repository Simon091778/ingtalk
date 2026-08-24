-- Snapshot each post's service country and support country-scoped board reads.
alter table public.board_posts add column if not exists country_code text;

update public.board_posts post
set country_code = coalesce(profile.country_code, 'KR')
from public.profiles profile
where profile.id = post.author_id and post.country_code is null;

update public.board_posts set country_code = 'KR' where country_code is null;
alter table public.board_posts alter column country_code set default 'KR';
alter table public.board_posts alter column country_code set not null;
alter table public.board_posts drop constraint if exists board_posts_country_code_check;
alter table public.board_posts add constraint board_posts_country_code_check check (country_code in ('KR', 'US', 'OTHER'));
create index if not exists board_posts_country_created_idx on public.board_posts(country_code, created_at desc);

create or replace function public.create_board_post(post_title text, post_body text, post_image_url text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare profile_gender text; profile_country text; post_uuid uuid; previous_alias text; new_alias text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(post_title)) not between 1 and 60 then raise exception 'invalid_post_title'; end if;
  if char_length(trim(post_body)) not between 1 and 500 then raise exception 'invalid_post_length'; end if;
  select gender, country_code into profile_gender, profile_country from public.profiles where id = auth.uid() and status = 'active';
  if not found then raise exception 'active_profile_required'; end if;
  select anonymous_name into previous_alias from public.board_posts where author_id = auth.uid() order by created_at desc limit 1;
  loop new_alias := public.generate_board_alias(profile_gender); exit when previous_alias is null or new_alias <> previous_alias; end loop;
  insert into public.board_posts(author_id, title, body, image_url, anonymous_name, anonymous_gender, country_code)
  values (auth.uid(), trim(post_title), trim(post_body), nullif(trim(post_image_url), ''), new_alias, case when profile_gender in ('male','female') then profile_gender else 'neutral' end, coalesce(profile_country, 'KR'))
  returning id into post_uuid;
  perform public.award_daily_action('board_post', post_uuid);
  return post_uuid;
end;
$$;

drop function if exists public.list_board_posts(integer);
drop function if exists public.list_board_posts(integer, text);
create function public.list_board_posts(result_limit integer default 100, country_filter text default null)
returns table (
  id uuid, author_id uuid, nickname text, gender text, country_code text, title text, body text, image_url text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean,
  dislike_count bigint, disliked_by_me boolean
)
language sql stable security definer set search_path = public as $$
  select
    post.id, post.author_id, post.anonymous_name, post.anonymous_gender, post.country_code, post.title, post.body, post.image_url, post.created_at,
    (select count(*) from public.board_comments comment where comment.post_id = post.id),
    post.view_count,
    (select count(*) from public.board_post_likes liked where liked.post_id = post.id),
    exists (select 1 from public.board_post_likes mine where mine.post_id = post.id and mine.user_id = auth.uid()),
    (select count(*) from public.board_post_dislikes disliked where disliked.post_id = post.id),
    exists (select 1 from public.board_post_dislikes mine where mine.post_id = post.id and mine.user_id = auth.uid())
  from public.board_posts post
  where country_filter is null or post.country_code = country_filter
  order by post.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.create_board_post(text, text, text) from public, anon;
grant execute on function public.create_board_post(text, text, text) to authenticated;
revoke all on function public.list_board_posts(integer, text) from public, anon;
grant execute on function public.list_board_posts(integer, text) to authenticated;

notify pgrst, 'reload schema';

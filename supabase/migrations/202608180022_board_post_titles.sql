-- Separate board post titles from bodies and return compact list data.

alter table public.board_posts add column if not exists title text;
update public.board_posts
set title = left(regexp_replace(trim(body), E'[\n\r]+', ' ', 'g'), 60)
where title is null;
alter table public.board_posts alter column title set not null;
alter table public.board_posts drop constraint if exists board_posts_title_check;
alter table public.board_posts add constraint board_posts_title_check check (char_length(trim(title)) between 1 and 60);

drop function if exists public.create_board_post(text);
create function public.create_board_post(post_title text, post_body text)
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
  insert into public.board_posts(author_id, title, body, anonymous_name, anonymous_gender)
  values (auth.uid(), trim(post_title), trim(post_body), new_alias,
    case when profile_gender in ('male','female') then profile_gender else 'neutral' end)
  returning id into post_uuid;
  return post_uuid;
end;
$$;

drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (
  id uuid, author_id uuid, nickname text, gender text, title text, body text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean
)
language sql stable security definer set search_path = public as $$
  select
    post.id, post.author_id, post.anonymous_name, post.anonymous_gender, post.title, post.body, post.created_at,
    (select count(*) from public.board_comments comment where comment.post_id = post.id),
    post.view_count,
    (select count(*) from public.board_post_likes liked where liked.post_id = post.id),
    exists (select 1 from public.board_post_likes mine where mine.post_id = post.id and mine.user_id = auth.uid())
  from public.board_posts post order by post.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.create_board_post(text, text) from public;
grant execute on function public.create_board_post(text, text) to authenticated;
revoke all on function public.list_board_posts(integer) from public;
grant execute on function public.list_board_posts(integer) to authenticated;
notify pgrst, 'reload schema';

create table if not exists public.board_post_dislikes (
  post_id uuid not null references public.board_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.board_post_dislikes enable row level security;
revoke all on public.board_post_dislikes from anon, authenticated;

create or replace function public.toggle_board_post_like(post_uuid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.board_posts where id = post_uuid) then raise exception 'post_not_found'; end if;
  if exists (select 1 from public.board_post_likes where post_id = post_uuid and user_id = auth.uid()) then
    delete from public.board_post_likes where post_id = post_uuid and user_id = auth.uid();
    return false;
  end if;
  delete from public.board_post_dislikes where post_id = post_uuid and user_id = auth.uid();
  insert into public.board_post_likes(post_id, user_id) values (post_uuid, auth.uid());
  return true;
end;
$$;

create or replace function public.toggle_board_post_dislike(post_uuid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.board_posts where id = post_uuid) then raise exception 'post_not_found'; end if;
  if exists (select 1 from public.board_post_dislikes where post_id = post_uuid and user_id = auth.uid()) then
    delete from public.board_post_dislikes where post_id = post_uuid and user_id = auth.uid();
    return false;
  end if;
  delete from public.board_post_likes where post_id = post_uuid and user_id = auth.uid();
  insert into public.board_post_dislikes(post_id, user_id) values (post_uuid, auth.uid());
  return true;
end;
$$;

drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (
  id uuid, author_id uuid, nickname text, gender text, title text, body text, image_url text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean,
  dislike_count bigint, disliked_by_me boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    post.id, post.author_id, post.anonymous_name, post.anonymous_gender, post.title, post.body, post.image_url, post.created_at,
    (select count(*) from public.board_comments comment where comment.post_id = post.id),
    post.view_count,
    (select count(*) from public.board_post_likes liked where liked.post_id = post.id),
    exists (select 1 from public.board_post_likes mine where mine.post_id = post.id and mine.user_id = auth.uid()),
    (select count(*) from public.board_post_dislikes disliked where disliked.post_id = post.id),
    exists (select 1 from public.board_post_dislikes mine where mine.post_id = post.id and mine.user_id = auth.uid())
  from public.board_posts post
  order by post.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.toggle_board_post_dislike(uuid) from public, anon;
grant execute on function public.toggle_board_post_dislike(uuid) to authenticated;
revoke all on function public.list_board_posts(integer) from public, anon;
grant execute on function public.list_board_posts(integer) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.board_post_dislikes;
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

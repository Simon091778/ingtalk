-- Board views and per-user likes.

alter table public.board_posts add column if not exists view_count bigint not null default 0 check (view_count >= 0);

create table if not exists public.board_post_likes (
  post_id uuid not null references public.board_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.board_post_likes enable row level security;
revoke all on public.board_post_likes from anon, authenticated;

create or replace function public.increment_board_post_view(post_uuid uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare next_count bigint;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  update public.board_posts set view_count = view_count + 1 where id = post_uuid returning view_count into next_count;
  if next_count is null then raise exception 'post_not_found'; end if;
  return next_count;
end;
$$;

create or replace function public.toggle_board_post_like(post_uuid uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.board_posts where id = post_uuid) then raise exception 'post_not_found'; end if;
  if exists (select 1 from public.board_post_likes where post_id = post_uuid and user_id = auth.uid()) then
    delete from public.board_post_likes where post_id = post_uuid and user_id = auth.uid();
    return false;
  end if;
  insert into public.board_post_likes(post_id, user_id) values (post_uuid, auth.uid());
  return true;
end;
$$;

drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (
  id uuid, author_id uuid, nickname text, gender text, body text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean
)
language sql stable security definer set search_path = public as $$
  select
    post.id, post.author_id, post.anonymous_name, post.anonymous_gender, post.body, post.created_at,
    (select count(*) from public.board_comments comment where comment.post_id = post.id),
    post.view_count,
    (select count(*) from public.board_post_likes liked where liked.post_id = post.id),
    exists (select 1 from public.board_post_likes mine where mine.post_id = post.id and mine.user_id = auth.uid())
  from public.board_posts post
  order by post.created_at desc
  limit least(greatest(result_limit, 1), 100);
$$;

revoke all on function public.increment_board_post_view(uuid) from public;
grant execute on function public.increment_board_post_view(uuid) to authenticated;
revoke all on function public.toggle_board_post_like(uuid) from public;
grant execute on function public.toggle_board_post_like(uuid) to authenticated;
revoke all on function public.list_board_posts(integer) from public;
grant execute on function public.list_board_posts(integer) to authenticated;

do $$ begin alter publication supabase_realtime add table public.board_post_likes; exception when duplicate_object then null; end $$;
notify pgrst, 'reload schema';

-- Per-user likes for anonymous board comments.

create table if not exists public.board_comment_likes (
  comment_id uuid not null references public.board_comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table public.board_comment_likes enable row level security;
revoke all on public.board_comment_likes from anon, authenticated;

create or replace function public.toggle_board_comment_like(comment_uuid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists (select 1 from public.board_comments where id = comment_uuid) then
    raise exception 'comment_not_found';
  end if;

  if exists (
    select 1 from public.board_comment_likes
    where comment_id = comment_uuid and user_id = auth.uid()
  ) then
    delete from public.board_comment_likes
    where comment_id = comment_uuid and user_id = auth.uid();
    return false;
  end if;

  insert into public.board_comment_likes(comment_id, user_id)
  values (comment_uuid, auth.uid());
  return true;
end;
$$;

drop function if exists public.list_board_comments(uuid);
create function public.list_board_comments(post_uuid uuid)
returns table (
  id uuid,
  author_id uuid,
  nickname text,
  gender text,
  body text,
  created_at timestamptz,
  like_count bigint,
  liked_by_me boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    comment.id,
    comment.author_id,
    comment.anonymous_name,
    comment.anonymous_gender,
    comment.body,
    comment.created_at,
    (select count(*) from public.board_comment_likes liked where liked.comment_id = comment.id),
    exists (
      select 1 from public.board_comment_likes mine
      where mine.comment_id = comment.id and mine.user_id = auth.uid()
    )
  from public.board_comments comment
  where comment.post_id = post_uuid
  order by comment.created_at asc;
$$;

revoke all on function public.toggle_board_comment_like(uuid) from public;
grant execute on function public.toggle_board_comment_like(uuid) to authenticated;
revoke all on function public.list_board_comments(uuid) from public;
grant execute on function public.list_board_comments(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.board_comment_likes;
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

alter table public.board_comments
  add column if not exists parent_id uuid references public.board_comments(id) on delete cascade;

create index if not exists board_comments_parent_created_idx
  on public.board_comments(parent_id, created_at);

create or replace function public.create_board_reply(
  post_uuid uuid,
  parent_comment_uuid uuid,
  comment_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  root_comment public.board_comments;
  new_comment_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  select * into root_comment
  from public.board_comments
  where id = parent_comment_uuid and post_id = post_uuid;

  if root_comment.id is null then raise exception 'parent_comment_not_found'; end if;
  if root_comment.parent_id is not null then
    select * into root_comment
    from public.board_comments
    where id = root_comment.parent_id and post_id = post_uuid and parent_id is null;
    if root_comment.id is null then raise exception 'parent_comment_not_found'; end if;
  end if;

  new_comment_id := public.create_board_comment(post_uuid, comment_body);
  update public.board_comments set parent_id = root_comment.id where id = new_comment_id;
  return new_comment_id;
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
  liked_by_me boolean,
  parent_id uuid,
  parent_nickname text
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
    ),
    comment.parent_id,
    parent.anonymous_name
  from public.board_comments comment
  left join public.board_comments parent on parent.id = comment.parent_id
  where comment.post_id = post_uuid
  order by coalesce(parent.created_at, comment.created_at),
           case when comment.parent_id is null then 0 else 1 end,
           comment.created_at;
$$;

revoke all on function public.create_board_reply(uuid, uuid, text) from public, anon;
grant execute on function public.create_board_reply(uuid, uuid, text) to authenticated;
revoke all on function public.list_board_comments(uuid) from public, anon;
grant execute on function public.list_board_comments(uuid) to authenticated;

notify pgrst, 'reload schema';

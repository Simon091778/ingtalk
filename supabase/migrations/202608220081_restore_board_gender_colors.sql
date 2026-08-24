-- Restore anonymous gender solely for nickname color presentation. The app no
-- longer offers male/female board filters.
drop function if exists public.list_board_posts(integer);
create function public.list_board_posts(result_limit integer default 100)
returns table (
  id uuid, author_id uuid, nickname text, gender text, title text, body text, image_url text, created_at timestamptz,
  comment_count bigint, view_count bigint, like_count bigint, liked_by_me boolean,
  dislike_count bigint, disliked_by_me boolean
)
language sql stable security definer set search_path = public as $$
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

drop function if exists public.list_board_comments(uuid);
create function public.list_board_comments(post_uuid uuid)
returns table (
  id uuid, author_id uuid, nickname text, gender text, body text, created_at timestamptz,
  like_count bigint, liked_by_me boolean, parent_id uuid, parent_nickname text,
  reply_to_id uuid, reply_to_nickname text
)
language sql stable security definer set search_path = public as $$
  select
    comment.id, comment.author_id, comment.anonymous_name, comment.anonymous_gender, comment.body, comment.created_at,
    (select count(*) from public.board_comment_likes liked where liked.comment_id = comment.id),
    exists (
      select 1 from public.board_comment_likes mine
      where mine.comment_id = comment.id and mine.user_id = auth.uid()
    ),
    comment.parent_id, thread_root.anonymous_name,
    comment.reply_to_id, reply_target.anonymous_name
  from public.board_comments comment
  left join public.board_comments thread_root on thread_root.id = comment.parent_id
  left join public.board_comments reply_target on reply_target.id = comment.reply_to_id
  where comment.post_id = post_uuid
  order by coalesce(thread_root.created_at, comment.created_at),
           case when comment.parent_id is null then 0 else 1 end,
           comment.created_at;
$$;

revoke all on function public.list_board_posts(integer) from public, anon;
grant execute on function public.list_board_posts(integer) to authenticated;
revoke all on function public.list_board_comments(uuid) from public, anon;
grant execute on function public.list_board_comments(uuid) to authenticated;

notify pgrst, 'reload schema';

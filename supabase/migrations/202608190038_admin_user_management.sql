-- Searchable user management and complete operator-facing user history.

create index if not exists conversation_cards_author_created_idx
  on public.conversation_cards(author_id, created_at desc);
create index if not exists board_posts_author_created_idx
  on public.board_posts(author_id, created_at desc);
create index if not exists board_comments_author_created_idx
  on public.board_comments(author_id, created_at desc);
create index if not exists reports_reported_user_created_idx
  on public.reports(reported_user_id, created_at desc);

create or replace function public.admin_search_users(
  search_text text default '',
  status_filter text default null,
  result_limit integer default 100
)
returns table (
  user_id uuid,
  nickname text,
  gender text,
  birth_year integer,
  status text,
  suspended_until timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  point_balance bigint,
  talk_count bigint,
  post_count bigint,
  comment_count bigint,
  report_count bigint,
  action_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare normalized_search text := left(trim(coalesce(search_text, '')), 80);
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if status_filter is not null and status_filter not in ('active', 'paused', 'suspended', 'deleted') then
    raise exception 'invalid_status_filter';
  end if;

  return query
  select
    profile.id,
    profile.nickname,
    profile.gender,
    profile.birth_year,
    profile.status::text,
    profile.suspended_until,
    profile.created_at,
    profile.updated_at,
    coalesce(wallet.balance, 0),
    (select count(*) from public.conversation_cards card where card.author_id = profile.id),
    (select count(*) from public.board_posts post where post.author_id = profile.id),
    (select count(*) from public.board_comments comment where comment.author_id = profile.id),
    (select count(*) from public.reports report where report.reported_user_id = profile.id),
    (select count(*) from public.moderation_actions action where action.target_user_id = profile.id)
  from public.profiles profile
  left join public.point_wallets wallet on wallet.user_id = profile.id
  where (status_filter is null or profile.status::text = status_filter)
    and (
      normalized_search = ''
      or profile.nickname ilike '%' || normalized_search || '%'
      or profile.id::text ilike '%' || normalized_search || '%'
    )
  order by profile.created_at desc
  limit least(greatest(result_limit, 1), 200);
end;
$$;

create or replace function public.admin_get_user_detail(target_user_uuid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if not exists (select 1 from public.profiles where id = target_user_uuid) then raise exception 'user_not_found'; end if;

  select jsonb_build_object(
    'profile', (
      select to_jsonb(profile_row)
      from (
        select profile.id, profile.nickname, profile.gender, profile.birth_year, profile.region_code,
               profile.introduction, profile.interests, profile.avatar_url, profile.status::text as status,
               profile.trust_score, profile.is_verified, profile.suspended_until, profile.suspension_reason,
               profile.created_at, profile.updated_at, coalesce(wallet.balance, 0) as point_balance
        from public.profiles profile
        left join public.point_wallets wallet on wallet.user_id = profile.id
        where profile.id = target_user_uuid
      ) profile_row
    ),
    'talks', coalesce((
      select jsonb_agg(to_jsonb(talk_row) order by talk_row.created_at desc)
      from (
        select card.id, card.purpose, card.topic, card.is_active, card.created_at, card.expires_at
        from public.conversation_cards card where card.author_id = target_user_uuid
        order by card.created_at desc limit 30
      ) talk_row
    ), '[]'::jsonb),
    'posts', coalesce((
      select jsonb_agg(to_jsonb(post_row) order by post_row.created_at desc)
      from (
        select post.id, post.title, post.body, post.image_url, post.view_count, post.created_at
        from public.board_posts post where post.author_id = target_user_uuid
        order by post.created_at desc limit 30
      ) post_row
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(to_jsonb(comment_row) order by comment_row.created_at desc)
      from (
        select comment.id, comment.body, comment.created_at, comment.post_id, post.title as post_title
        from public.board_comments comment
        join public.board_posts post on post.id = comment.post_id
        where comment.author_id = target_user_uuid
        order by comment.created_at desc limit 50
      ) comment_row
    ), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(to_jsonb(report_row) order by report_row.created_at desc)
      from (
        select report.id, report.reason, report.priority, report.status::text as status,
               report.details, report.created_at, report.reviewed_at, report.review_note
        from public.reports report where report.reported_user_id = target_user_uuid
        order by report.created_at desc limit 50
      ) report_row
    ), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(to_jsonb(action_row) order by action_row.created_at desc)
      from (
        select action.id, action.action, action.note, action.before_state, action.after_state,
               action.created_at, auth_user.email::text as admin_email
        from public.moderation_actions action
        left join auth.users auth_user on auth_user.id = action.admin_user_id
        where action.target_user_id = target_user_uuid
        order by action.created_at desc limit 50
      ) action_row
    ), '[]'::jsonb),
    'point_transactions', coalesce((
      select jsonb_agg(to_jsonb(point_row) order by point_row.created_at desc)
      from (
        select transaction.id, transaction.amount, transaction.reason, transaction.created_at
        from public.point_transactions transaction where transaction.user_id = target_user_uuid
        order by transaction.created_at desc limit 50
      ) point_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.admin_manage_user(
  target_user_uuid uuid,
  management_action text,
  admin_note text,
  suspension_days integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare previous_profile public.profiles; required_role text := 'moderator';
begin
  if management_action not in ('suspend', 'ban', 'restore') then raise exception 'invalid_management_action'; end if;
  if management_action = 'ban' then required_role := 'owner'; end if;
  if not public.admin_has_role(required_role) then raise exception 'admin_role_required'; end if;
  if target_user_uuid = auth.uid() then raise exception 'cannot_manage_self'; end if;
  if char_length(trim(coalesce(admin_note, ''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;

  select * into previous_profile from public.profiles where id = target_user_uuid for update;
  if previous_profile.id is null then raise exception 'user_not_found'; end if;

  if management_action = 'suspend' then
    if suspension_days is null or suspension_days not between 1 and 365 then raise exception 'invalid_suspension_days'; end if;
    update public.profiles set status = 'suspended', suspended_until = now() + make_interval(days => suspension_days),
      suspension_reason = left(trim(admin_note), 500), updated_at = now() where id = target_user_uuid;
  elsif management_action = 'ban' then
    update public.profiles set status = 'suspended', suspended_until = null,
      suspension_reason = left(trim(admin_note), 500), updated_at = now() where id = target_user_uuid;
  else
    update public.profiles set status = 'active', suspended_until = null,
      suspension_reason = null, updated_at = now() where id = target_user_uuid;
  end if;

  if management_action in ('suspend', 'ban') then
    update public.conversation_cards set is_active = false where author_id = target_user_uuid;
    update public.chat_requests set status = 'cancelled', responded_at = now()
    where status = 'pending' and target_user_uuid in (sender_id, receiver_id);
  end if;

  insert into public.moderation_actions(admin_user_id, target_user_id, action, note, before_state, after_state)
  values (
    auth.uid(), target_user_uuid, management_action, trim(admin_note),
    jsonb_build_object('status', previous_profile.status::text, 'suspended_until', previous_profile.suspended_until),
    jsonb_build_object('status', (select status::text from public.profiles where id = target_user_uuid), 'suspended_until', (select suspended_until from public.profiles where id = target_user_uuid))
  );
end;
$$;

-- A timed suspension is released when the affected user next opens the app.
-- SECURITY DEFINER is required because suspended profiles are hidden by RLS.
create or replace function public.refresh_my_suspension()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare current_status text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  update public.profiles
  set status = 'active', suspended_until = null, suspension_reason = null, updated_at = now()
  where id = auth.uid()
    and status = 'suspended'
    and suspended_until is not null
    and suspended_until <= now();

  select status::text into current_status from public.profiles where id = auth.uid();
  return current_status;
end;
$$;

revoke all on function public.admin_search_users(text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_get_user_detail(uuid) from public, anon, authenticated;
revoke all on function public.admin_manage_user(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.refresh_my_suspension() from public, anon, authenticated;
grant execute on function public.admin_search_users(text, text, integer) to authenticated;
grant execute on function public.admin_get_user_detail(uuid) to authenticated;
grant execute on function public.admin_manage_user(uuid, text, text, integer) to authenticated;
grant execute on function public.refresh_my_suspension() to authenticated;

notify pgrst, 'reload schema';

-- Admin console roles, moderation actions, and guarded operator RPCs.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('reviewer', 'moderator', 'owner')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.moderation_actions (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  report_id uuid references public.reports(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  note text not null default '',
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists moderation_actions_report_idx
  on public.moderation_actions(report_id, created_at desc);
create index if not exists moderation_actions_target_idx
  on public.moderation_actions(target_user_id, created_at desc);

alter table public.profiles
  add column if not exists suspended_until timestamptz,
  add column if not exists suspension_reason text;

alter table public.admin_users enable row level security;
alter table public.moderation_actions enable row level security;
revoke all on public.admin_users, public.moderation_actions from anon, authenticated;

create or replace function public.admin_has_role(required_role text default 'reviewer')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users admin_user
    where admin_user.user_id = auth.uid()
      and admin_user.is_active
      and case required_role
        when 'reviewer' then admin_user.role in ('reviewer', 'moderator', 'owner')
        when 'moderator' then admin_user.role in ('moderator', 'owner')
        when 'owner' then admin_user.role = 'owner'
        else false
      end
  );
$$;

create or replace function public.admin_me()
returns table (user_id uuid, email text, role text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select admin_user.user_id, auth_user.email::text, admin_user.role
  from public.admin_users admin_user
  join auth.users auth_user on auth_user.id = admin_user.user_id
  where admin_user.user_id = auth.uid() and admin_user.is_active;
$$;

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  return jsonb_build_object(
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'reviewing_reports', (select count(*) from public.reports where status = 'reviewing'),
    'urgent_reports', (select count(*) from public.reports where status in ('open', 'reviewing') and priority = 'urgent'),
    'suspended_users', (select count(*) from public.profiles where status = 'suspended'),
    'actions_today', (select count(*) from public.moderation_actions where created_at >= date_trunc('day', now()))
  );
end;
$$;

create or replace function public.admin_list_reports(
  status_filter text default null,
  result_limit integer default 100
)
returns table (
  id uuid,
  target_type text,
  reason text,
  details text,
  priority text,
  status text,
  created_at timestamptz,
  reviewed_at timestamptz,
  review_note text,
  room_id uuid,
  reported_user_id uuid,
  reported_nickname text,
  reported_status text,
  suspended_until timestamptz,
  reporter_nickname text,
  content_snapshot jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  return query
  select
    report.id,
    report.target_type,
    report.reason,
    report.details,
    report.priority,
    report.status::text,
    report.created_at,
    report.reviewed_at,
    report.review_note,
    report.room_id,
    report.reported_user_id,
    reported.nickname,
    reported.status::text,
    reported.suspended_until,
    reporter.nickname,
    report.content_snapshot
  from public.reports report
  join public.profiles reported on reported.id = report.reported_user_id
  join public.profiles reporter on reporter.id = report.reporter_id
  where status_filter is null or report.status::text = status_filter
  order by
    case report.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
    report.created_at desc
  limit least(greatest(result_limit, 1), 200);
end;
$$;

create or replace function public.admin_mark_report_reviewing(report_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare previous_status text;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  select status::text into previous_status from public.reports where id = report_uuid for update;
  if previous_status is null then raise exception 'report_not_found'; end if;
  if previous_status = 'open' then
    update public.reports set status = 'reviewing' where id = report_uuid;
    insert into public.moderation_actions(admin_user_id, report_id, action, before_state, after_state)
    values (auth.uid(), report_uuid, 'start_review', jsonb_build_object('status', previous_status), jsonb_build_object('status', 'reviewing'));
  end if;
end;
$$;

create or replace function public.admin_resolve_report(
  report_uuid uuid,
  resolution text,
  admin_note text default '',
  suspension_days integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_report public.reports;
  previous_profile public.profiles;
  required_role text := 'reviewer';
  next_report_status public.report_status := 'resolved';
begin
  if resolution not in ('dismiss', 'resolve', 'suspend', 'ban', 'restore') then raise exception 'invalid_resolution'; end if;
  if char_length(trim(coalesce(admin_note, ''))) > 1000 then raise exception 'admin_note_too_long'; end if;
  if resolution in ('suspend', 'restore') then required_role := 'moderator'; end if;
  if resolution = 'ban' then required_role := 'owner'; end if;
  if not public.admin_has_role(required_role) then raise exception 'admin_role_required'; end if;

  select * into target_report from public.reports where id = report_uuid for update;
  if target_report.id is null then raise exception 'report_not_found'; end if;
  select * into previous_profile from public.profiles where id = target_report.reported_user_id for update;

  if resolution = 'dismiss' then
    next_report_status := 'dismissed';
  elsif resolution = 'suspend' then
    if suspension_days is null or suspension_days not between 1 and 365 then raise exception 'invalid_suspension_days'; end if;
    update public.profiles
    set status = 'suspended', suspended_until = now() + make_interval(days => suspension_days),
        suspension_reason = left(trim(coalesce(admin_note, '')), 500), updated_at = now()
    where id = target_report.reported_user_id;
    update public.conversation_cards set is_active = false where author_id = target_report.reported_user_id;
    update public.chat_requests set status = 'cancelled', responded_at = now()
    where status = 'pending' and target_report.reported_user_id in (sender_id, receiver_id);
  elsif resolution = 'ban' then
    update public.profiles
    set status = 'suspended', suspended_until = null,
        suspension_reason = left(trim(coalesce(admin_note, '')), 500), updated_at = now()
    where id = target_report.reported_user_id;
    update public.conversation_cards set is_active = false where author_id = target_report.reported_user_id;
    update public.chat_requests set status = 'cancelled', responded_at = now()
    where status = 'pending' and target_report.reported_user_id in (sender_id, receiver_id);
  elsif resolution = 'restore' then
    update public.profiles
    set status = 'active', suspended_until = null, suspension_reason = null, updated_at = now()
    where id = target_report.reported_user_id;
  end if;

  update public.reports
  set status = next_report_status, reviewed_at = now(), review_note = trim(coalesce(admin_note, ''))
  where id = report_uuid;

  insert into public.moderation_actions(
    admin_user_id, report_id, target_user_id, action, note, before_state, after_state
  ) values (
    auth.uid(), report_uuid, target_report.reported_user_id, resolution,
    trim(coalesce(admin_note, '')),
    jsonb_build_object('report_status', target_report.status::text, 'profile_status', previous_profile.status::text, 'suspended_until', previous_profile.suspended_until),
    jsonb_build_object('report_status', next_report_status::text, 'profile_status', (select status::text from public.profiles where id = target_report.reported_user_id), 'suspended_until', (select suspended_until from public.profiles where id = target_report.reported_user_id))
  );
end;
$$;

create or replace function public.admin_adjust_points(
  target_user_uuid uuid,
  point_amount bigint,
  adjustment_reason text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare adjustment_reference uuid := gen_random_uuid(); next_balance bigint;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if point_amount = 0 or abs(point_amount) > 100000 then raise exception 'invalid_point_amount'; end if;
  if char_length(trim(adjustment_reason)) not between 2 and 300 then raise exception 'adjustment_reason_required'; end if;

  update public.point_wallets
  set balance = balance + point_amount, updated_at = now()
  where user_id = target_user_uuid and balance + point_amount >= 0
  returning balance into next_balance;
  if next_balance is null then raise exception 'wallet_not_found_or_insufficient_balance'; end if;

  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (target_user_uuid, point_amount, 'admin_adjustment', adjustment_reference);
  insert into public.moderation_actions(admin_user_id, target_user_id, action, note, after_state)
  values (auth.uid(), target_user_uuid, 'adjust_points', trim(adjustment_reason), jsonb_build_object('amount', point_amount, 'balance', next_balance));
  return next_balance;
end;
$$;

-- Direct access stays closed; only guarded RPCs are exposed to signed-in operators.
revoke all on function public.admin_has_role(text) from public, anon, authenticated;
revoke all on function public.admin_me() from public, anon, authenticated;
revoke all on function public.admin_dashboard_stats() from public, anon, authenticated;
revoke all on function public.admin_list_reports(text, integer) from public, anon, authenticated;
revoke all on function public.admin_mark_report_reviewing(uuid) from public, anon, authenticated;
revoke all on function public.admin_resolve_report(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_adjust_points(uuid, bigint, text) from public, anon, authenticated;

grant execute on function public.admin_has_role(text) to authenticated;
grant execute on function public.admin_me() to authenticated;
grant execute on function public.admin_dashboard_stats() to authenticated;
grant execute on function public.admin_list_reports(text, integer) to authenticated;
grant execute on function public.admin_mark_report_reviewing(uuid) to authenticated;
grant execute on function public.admin_resolve_report(uuid, text, text, integer) to authenticated;
grant execute on function public.admin_adjust_points(uuid, bigint, text) to authenticated;

notify pgrst, 'reload schema';

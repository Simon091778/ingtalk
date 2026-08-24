-- Filterable, read-only audit history for the operator console.

create index if not exists moderation_actions_admin_created_idx
  on public.moderation_actions(admin_user_id, created_at desc);
create index if not exists moderation_actions_action_created_idx
  on public.moderation_actions(action, created_at desc);

create or replace function public.admin_list_operators()
returns table (user_id uuid, email text, role text, is_active boolean)
language plpgsql stable security definer
set search_path = public, auth
as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  return query
  select au.user_id, u.email::text, au.role, au.is_active
  from public.admin_users au join auth.users u on u.id = au.user_id
  order by u.email;
end;
$$;

create or replace function public.admin_list_audit_events(
  started_at timestamptz default null, ended_at timestamptz default null,
  operator_uuid uuid default null, action_filter text default null,
  result_limit integer default 200
)
returns table (
  id bigint, admin_user_id uuid, admin_email text, admin_role text,
  action text, note text, target_user_id uuid, target_nickname text,
  report_id uuid, before_state jsonb, after_state jsonb,
  point_amount bigint, created_at timestamptz
)
language plpgsql stable security definer
set search_path = public, auth
as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if started_at is not null and ended_at is not null and started_at > ended_at then raise exception 'invalid_date_range'; end if;
  return query
  select a.id, a.admin_user_id, u.email::text, au.role, a.action, a.note,
    a.target_user_id, p.nickname, a.report_id, a.before_state, a.after_state,
    case when a.action = 'adjust_points' then nullif(a.after_state ->> 'amount', '')::bigint else null end,
    a.created_at
  from public.moderation_actions a
  join auth.users u on u.id = a.admin_user_id
  left join public.admin_users au on au.user_id = a.admin_user_id
  left join public.profiles p on p.id = a.target_user_id
  where (started_at is null or a.created_at >= started_at)
    and (ended_at is null or a.created_at <= ended_at)
    and (operator_uuid is null or a.admin_user_id = operator_uuid)
    and (action_filter is null or a.action = action_filter)
  order by a.created_at desc
  limit least(greatest(result_limit, 1), 500);
end;
$$;

-- Preserve both balances for all new point adjustments.
create or replace function public.admin_adjust_points(target_user_uuid uuid, point_amount bigint, adjustment_reason text)
returns bigint language plpgsql security definer set search_path = public
as $$
declare adjustment_reference uuid := gen_random_uuid(); previous_balance bigint; next_balance bigint;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if point_amount = 0 or abs(point_amount) > 100000 then raise exception 'invalid_point_amount'; end if;
  if char_length(trim(adjustment_reason)) not between 2 and 300 then raise exception 'adjustment_reason_required'; end if;
  select balance into previous_balance from public.point_wallets where user_id = target_user_uuid for update;
  if previous_balance is null then raise exception 'wallet_not_found'; end if;
  if previous_balance + point_amount < 0 then raise exception 'insufficient_balance'; end if;
  update public.point_wallets set balance = balance + point_amount, updated_at = now()
  where user_id = target_user_uuid returning balance into next_balance;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (target_user_uuid, point_amount, 'admin_adjustment', adjustment_reference);
  insert into public.moderation_actions(admin_user_id, target_user_id, action, note, before_state, after_state)
  values (auth.uid(), target_user_uuid, 'adjust_points', trim(adjustment_reason),
    jsonb_build_object('balance', previous_balance), jsonb_build_object('amount', point_amount, 'balance', next_balance));
  return next_balance;
end;
$$;

revoke all on function public.admin_list_operators() from public, anon, authenticated;
revoke all on function public.admin_list_audit_events(timestamptz, timestamptz, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.admin_adjust_points(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_list_operators() to authenticated;
grant execute on function public.admin_list_audit_events(timestamptz, timestamptz, uuid, text, integer) to authenticated;
grant execute on function public.admin_adjust_points(uuid, bigint, text) to authenticated;

notify pgrst, 'reload schema';

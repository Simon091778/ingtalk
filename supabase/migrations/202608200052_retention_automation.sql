-- Automated retention enforcement.
-- User-visible chat: 30 days. Support/error logs: 90 days.
-- Safety backups, completed reports/audits, and inactive device recovery data: 1 year.

create extension if not exists pg_cron with schema pg_catalog;

alter table public.message_backups
  add column if not exists retention_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists legal_hold_reason text;

update public.message_backups
set retention_until = message_created_at + interval '1 year'
where retention_until is null;

alter table public.message_backups
  alter column retention_until set default (now() + interval '1 year'),
  alter column retention_until set not null;

alter table public.message_backups drop constraint if exists message_backups_legal_hold_reason_check;
alter table public.message_backups add constraint message_backups_legal_hold_reason_check
  check (legal_hold_reason is null or char_length(trim(legal_hold_reason)) between 2 and 500);

create index if not exists message_backups_retention_idx
  on public.message_backups(retention_until)
  where legal_hold_until is null;

create or replace function public.backup_chat_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.message_backups(
    original_message_id, room_id, sender_id, body, moderation_state,
    message_created_at, retention_until
  ) values (
    new.id, new.room_id, new.sender_id, new.body, new.moderation_state,
    new.created_at, new.created_at + interval '1 year'
  )
  on conflict (original_message_id) do nothing;
  return new;
end;
$$;

alter table public.support_threads add column if not exists closed_at timestamptz;
update public.support_threads set closed_at = updated_at
where status = 'closed' and closed_at is null;
create index if not exists support_threads_closed_retention_idx
  on public.support_threads(closed_at) where status = 'closed';

create or replace function public.send_support_message(message_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare thread_uuid uuid; normalized_body text := trim(coalesce(message_body, ''));
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(normalized_body) not between 1 and 2000 then raise exception 'invalid_message'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'profile_required'; end if;

  insert into public.support_threads(user_id, status, last_message_at, user_last_read_at, updated_at, closed_at)
  values (auth.uid(), 'open', now(), now(), now(), null)
  on conflict (user_id) do update
  set status = 'open', last_message_at = now(), user_last_read_at = now(), updated_at = now(), closed_at = null
  returning id into thread_uuid;

  insert into public.support_messages(thread_id, sender_type, sender_user_id, body)
  values (thread_uuid, 'user', auth.uid(), normalized_body);
  return thread_uuid;
end;
$$;

create or replace function public.admin_send_support_message(target_thread_uuid uuid, message_body text)
returns void language plpgsql security definer set search_path = public as $$
declare normalized_body text := trim(coalesce(message_body, ''));
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if char_length(normalized_body) not between 1 and 2000 then raise exception 'invalid_message'; end if;
  if not exists (select 1 from public.support_threads where id = target_thread_uuid) then raise exception 'thread_not_found'; end if;
  insert into public.support_messages(thread_id, sender_type, sender_user_id, body)
  values (target_thread_uuid, 'admin', auth.uid(), normalized_body);
  update public.support_threads
  set status = 'open', last_message_at = now(), admin_last_read_at = now(), updated_at = now(), closed_at = null
  where id = target_thread_uuid;
end;
$$;

create or replace function public.admin_set_support_status(target_thread_uuid uuid, next_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if next_status not in ('open', 'closed') then raise exception 'invalid_status'; end if;
  update public.support_threads
  set status = next_status,
      closed_at = case when next_status = 'closed' then coalesce(closed_at, now()) else null end,
      admin_last_read_at = now(), updated_at = now()
  where id = target_thread_uuid;
  if not found then raise exception 'thread_not_found'; end if;
end;
$$;

create table if not exists public.retention_cleanup_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  live_messages_deleted integer not null default 0,
  message_backups_deleted integer not null default 0,
  support_threads_deleted integer not null default 0,
  reports_deleted integer not null default 0,
  moderation_actions_deleted integer not null default 0,
  device_wallets_deleted integer not null default 0,
  device_grants_deleted integer not null default 0
);

alter table public.retention_cleanup_runs enable row level security;
revoke all on public.retention_cleanup_runs from public, anon, authenticated;

create or replace function public.run_retention_cleanup(batch_limit integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  started timestamptz := clock_timestamp();
  safe_limit integer := least(greatest(coalesce(batch_limit, 5000), 1), 20000);
  live_count integer := 0;
  backup_count integer := 0;
  support_count integer := 0;
  report_count integer := 0;
  action_count integer := 0;
  wallet_count integer := 0;
  grant_count integer := 0;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'service_role_required';
  end if;

  -- Ensure legacy live messages have a recoverable safety copy before pruning.
  insert into public.message_backups(
    original_message_id, room_id, sender_id, body, moderation_state,
    message_created_at, retention_until
  )
  select message.id, message.room_id, message.sender_id, message.body,
         message.moderation_state, message.created_at,
         message.created_at + interval '1 year'
  from public.messages message
  where message.created_at < now() - interval '30 days'
  order by message.created_at
  limit safe_limit
  on conflict (original_message_id) do nothing;

  with candidates as (
    select message.id
    from public.messages message
    where message.created_at < now() - interval '30 days'
      and exists (
        select 1 from public.message_backups backup
        where backup.original_message_id = message.id
      )
    order by message.created_at
    limit safe_limit
    for update skip locked
  )
  delete from public.messages message using candidates
  where message.id = candidates.id;
  get diagnostics live_count = row_count;

  with candidates as (
    select backup.original_message_id
    from public.message_backups backup
    where backup.retention_until <= now()
      and (backup.legal_hold_until is null or backup.legal_hold_until <= now())
    order by backup.retention_until
    limit safe_limit
    for update skip locked
  )
  delete from public.message_backups backup using candidates
  where backup.original_message_id = candidates.original_message_id;
  get diagnostics backup_count = row_count;

  with candidates as (
    select thread.id
    from public.support_threads thread
    where thread.status = 'closed'
      and thread.closed_at <= now() - interval '90 days'
    order by thread.closed_at
    limit safe_limit
    for update skip locked
  )
  delete from public.support_threads thread using candidates
  where thread.id = candidates.id;
  get diagnostics support_count = row_count;

  -- Open/reviewing reports remain until handled. Completed evidence expires after one year.
  with candidates as (
    select report.id
    from public.reports report
    where report.status in ('resolved', 'dismissed')
      and coalesce(report.reviewed_at, report.created_at) <= now() - interval '1 year'
    order by coalesce(report.reviewed_at, report.created_at)
    limit safe_limit
    for update skip locked
  )
  delete from public.reports report using candidates
  where report.id = candidates.id;
  get diagnostics report_count = row_count;

  with candidates as (
    select action.id
    from public.moderation_actions action
    where action.created_at <= now() - interval '1 year'
    order by action.created_at
    limit safe_limit
    for update skip locked
  )
  delete from public.moderation_actions action using candidates
  where action.id = candidates.id;
  get diagnostics action_count = row_count;

  with candidates as (
    select wallet.id
    from public.device_point_wallets wallet
    where wallet.last_seen_at <= now() - interval '1 year'
    order by wallet.last_seen_at
    limit safe_limit
    for update skip locked
  )
  delete from public.device_point_wallets wallet using candidates
  where wallet.id = candidates.id;
  get diagnostics wallet_count = row_count;

  with candidates as (
    select welcome_grant.device_hash
    from public.device_welcome_grants welcome_grant
    where welcome_grant.last_seen_at <= now() - interval '1 year'
      and not exists (
        select 1 from public.device_point_wallets wallet
        where wallet.device_hash = welcome_grant.device_hash
      )
    order by welcome_grant.last_seen_at
    limit safe_limit
    for update skip locked
  )
  delete from public.device_welcome_grants welcome_grant using candidates
  where welcome_grant.device_hash = candidates.device_hash;
  get diagnostics grant_count = row_count;

  insert into public.retention_cleanup_runs(
    started_at, live_messages_deleted, message_backups_deleted,
    support_threads_deleted, reports_deleted, moderation_actions_deleted,
    device_wallets_deleted, device_grants_deleted
  ) values (
    started, live_count, backup_count, support_count, report_count, action_count,
    wallet_count, grant_count
  );

  return jsonb_build_object(
    'live_messages_deleted', live_count,
    'message_backups_deleted', backup_count,
    'support_threads_deleted', support_count,
    'reports_deleted', report_count,
    'moderation_actions_deleted', action_count,
    'device_wallets_deleted', wallet_count,
    'device_grants_deleted', grant_count
  );
end;
$$;

create or replace function public.admin_set_message_backup_legal_hold(
  message_ids bigint[], hold_until timestamptz, hold_reason text
)
returns integer language plpgsql security definer set search_path = public as $$
declare changed_count integer;
begin
  if not public.admin_has_role('owner') then raise exception 'owner_required'; end if;
  if coalesce(array_length(message_ids, 1), 0) not between 1 and 500 then raise exception 'invalid_message_ids'; end if;
  if hold_until is not null and (hold_until <= now() or hold_until > now() + interval '5 years') then
    raise exception 'invalid_hold_until';
  end if;
  if hold_until is not null and char_length(trim(coalesce(hold_reason, ''))) not between 2 and 500 then
    raise exception 'hold_reason_required';
  end if;

  update public.message_backups
  set legal_hold_until = hold_until,
      legal_hold_reason = case when hold_until is null then null else trim(hold_reason) end
  where original_message_id = any(message_ids);
  get diagnostics changed_count = row_count;

  insert into public.moderation_actions(admin_user_id, action, note, before_state, after_state)
  values (
    auth.uid(),
    case when hold_until is null then 'release_message_backup_hold' else 'set_message_backup_hold' end,
    coalesce(trim(hold_reason), ''),
    jsonb_build_object('message_ids', message_ids),
    jsonb_build_object('hold_until', hold_until, 'changed_count', changed_count)
  );
  return changed_count;
end;
$$;

revoke all on function public.run_retention_cleanup(integer) from public, anon, authenticated;
revoke all on function public.admin_set_message_backup_legal_hold(bigint[], timestamptz, text) from public, anon, authenticated;
revoke all on function public.backup_chat_message() from public, anon, authenticated;
grant execute on function public.run_retention_cleanup(integer) to service_role;
grant execute on function public.admin_set_message_backup_legal_hold(bigint[], timestamptz, text) to authenticated;

select cron.schedule(
  'ingtalk-retention-daily',
  '30 18 * * *',
  $cron$select public.run_retention_cleanup(5000);$cron$
);

notify pgrst, 'reload schema';

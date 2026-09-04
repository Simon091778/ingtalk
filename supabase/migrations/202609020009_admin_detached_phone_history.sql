begin;

-- Existing rows are intentionally not backfilled: auth.users.phone_confirmed_at
-- may reflect a later OTP and is not equivalent to the account link timestamp.
alter table account_private.phone_identity_history
  add column verified_at timestamptz;

-- Preserve the exact account-identity linked_at for future detach operations.
-- This changes audit detail only; active ownership and authorization logic are
-- unchanged.
create or replace function account_private.retire_phone_identity(
  target_account uuid,expected_hash text,reason text)
returns void language plpgsql security definer set search_path='' as $$
declare old_identity account_private.account_identities;
  current_auth_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
begin
  select * into old_identity
  from account_private.account_identities
  where account_id=target_account and provider='phone' and identity_hash=expected_hash
  for update;
  if old_identity.account_id is null then return; end if;

  insert into account_private.phone_identity_history(
    account_id,auth_user_id,identity_hash,retired_reason,verified_at)
  values(old_identity.account_id,old_identity.auth_user_id,
    old_identity.identity_hash,reason,old_identity.linked_at);
  delete from public.push_tokens p using account_private.sessions old_session
    where p.auth_session_id=old_session.session_id
      and old_session.account_id=target_account
      and old_session.user_id=old_identity.auth_user_id;
  delete from account_private.account_link_requests
    where account_id=target_account and source_user=old_identity.auth_user_id;
  delete from account_private.sessions
    where account_id=target_account and user_id=old_identity.auth_user_id;
  delete from account_private.account_identities
    where account_id=target_account and provider='phone' and identity_hash=expected_hash;
  delete from auth.sessions
    where user_id=old_identity.auth_user_id and id is distinct from current_auth_session;
end; $$;

revoke all on function account_private.retire_phone_identity(uuid,text,text)
  from public,anon,authenticated;
grant execute on function account_private.retire_phone_identity(uuid,text,text)
  to service_role;

-- Active identity remains authoritative. Only when there is no active phone do
-- we consider the latest private history row, and only when its Auth phone
-- still exactly matches the recorded HMAC and has not entered deletion.
create or replace function account_private.admin_account_phone(target_account uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with active_phone as (
    select u.phone,identity_row.linked_at
    from account_private.account_identities identity_row
    join auth.users u on u.id=identity_row.auth_user_id
    where identity_row.account_id=target_account
      and identity_row.provider='phone'
      and u.phone_confirmed_at is not null
      and nullif(u.phone,'') is not null
      and identity_row.identity_hash=account_private.hash_phone(u.phone)
      and account_private.identity_active(identity_row)
  ), active_resolved as (
    select count(*)::integer as candidate_count,min(phone) as phone,
      min(linked_at) as verified_at
    from active_phone
  ), latest_history as (
    select history_row.id,history_row.auth_user_id,history_row.identity_hash,
      history_row.verified_at,history_row.retired_at,history_row.retired_reason
    from account_private.phone_identity_history history_row
    where history_row.account_id=target_account
    order by history_row.retired_at desc,history_row.id desc
    limit 1
  ), detached_phone as (
    select history_row.id,u.phone,history_row.verified_at,
      history_row.retired_at,history_row.retired_reason
    from latest_history history_row
    join auth.users u on u.id=history_row.auth_user_id
      and u.phone_confirmed_at is not null
      and nullif(u.phone,'') is not null
      and history_row.identity_hash=account_private.hash_phone(u.phone)
    where not exists(select 1 from account_private.identity_deletions deletion
      where deletion.auth_user_id=history_row.auth_user_id)
  )
  select jsonb_build_object(
    'status',case
      when active_resolved.candidate_count=1 then 'active'
      when active_resolved.candidate_count>1 then 'unavailable'
      when detached_phone.id is not null then 'detached'
      when exists(select 1 from latest_history) or exists(
        select 1 from account_private.account_identities identity_row
        where identity_row.account_id=target_account and identity_row.provider='phone'
      ) then 'unavailable'
      else 'none'
    end,
    'phone',case
      when active_resolved.candidate_count=1 then active_resolved.phone
      when active_resolved.candidate_count=0 then detached_phone.phone
      else null end,
    'verified_at',case
      when active_resolved.candidate_count=1 then active_resolved.verified_at
      when active_resolved.candidate_count=0 then detached_phone.verified_at
      else null end,
    'detached_at',case when active_resolved.candidate_count=0
      then detached_phone.retired_at else null end,
    'detach_reason',case when active_resolved.candidate_count=0
      then detached_phone.retired_reason else null end
  )
  from active_resolved
  left join detached_phone on true;
$$;

revoke all on function account_private.admin_account_phone(uuid)
  from public,anon,authenticated;
grant execute on function account_private.admin_account_phone(uuid) to service_role;

notify pgrst,'reload schema';
commit;

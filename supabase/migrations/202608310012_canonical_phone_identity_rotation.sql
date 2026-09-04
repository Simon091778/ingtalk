begin;

-- Active phone ownership lives in account_identities.  Retired mappings are
-- retained separately so a recycled number never makes us copy or merge data.
create table account_private.phone_identity_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  auth_user_id uuid not null,
  identity_hash text not null check(identity_hash~'^[a-f0-9]{64}$'),
  retired_reason text not null,
  retired_at timestamptz not null default now()
);
create index phone_identity_history_hash on account_private.phone_identity_history(identity_hash,retired_at desc);
revoke all on account_private.phone_identity_history from public,anon,authenticated;
grant select on account_private.phone_identity_history to service_role;

create table account_private.phone_identity_conflicts (
  identity_hash text primary key check(identity_hash~'^[a-f0-9]{64}$'),
  candidate_count integer not null check(candidate_count>1),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);
revoke all on account_private.phone_identity_conflicts from public,anon,authenticated;
grant select,update on account_private.phone_identity_conflicts to service_role;

-- Legacy duplicate rows are not assigned an arbitrary winner.  Preserve every
-- candidate, retire only the conflicting login mappings, and require an
-- explicit support resolution.  Account rows and all user assets remain.
insert into account_private.phone_identity_conflicts(identity_hash,candidate_count)
select identity_hash,count(distinct account_id)::integer
from account_private.account_identities
where provider='phone'
group by identity_hash
having count(distinct account_id)>1;

insert into account_private.phone_identity_history(account_id,auth_user_id,identity_hash,retired_reason,retired_at)
select b.account_id,b.auth_user_id,b.identity_hash,'legacy_multiple_active_owners',now()
from account_private.account_identities b
join account_private.phone_identity_conflicts c on c.identity_hash=b.identity_hash
where b.provider='phone';

delete from account_private.account_identities b
using account_private.phone_identity_conflicts c
where b.provider='phone' and b.identity_hash=c.identity_hash;

create unique index account_identities_one_active_phone_owner
  on account_private.account_identities(identity_hash) where provider='phone';

create function account_private.retire_phone_identity(target_account uuid,expected_hash text,reason text)
returns void language plpgsql security definer set search_path='' as $$
declare old_identity account_private.account_identities;
begin
  select * into old_identity
  from account_private.account_identities
  where account_id=target_account and provider='phone' and identity_hash=expected_hash
  for update;
  if old_identity.account_id is null then return; end if;

  insert into account_private.phone_identity_history(account_id,auth_user_id,identity_hash,retired_reason)
  values(old_identity.account_id,old_identity.auth_user_id,old_identity.identity_hash,reason);
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
end; $$;
revoke all on function account_private.retire_phone_identity(uuid,text,text) from public,anon,authenticated;
grant execute on function account_private.retire_phone_identity(uuid,text,text) to service_role;

create or replace function account_private.authorize_identity(device_secret text,device_platform text,reinstall_identifier text,provider_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; dh text; scope text; aid uuid; recovered_id uuid; previous_id uuid; previous_device uuid;
  d account_private.account_devices; created boolean:=false; restored boolean:=false; attempts integer; matches integer;
  scope_account uuid; scope_matches integer:=0; phone_owner uuid; old_phone_hash text; phone_rotated boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  perform 1 from auth.users u join auth.sessions s on s.user_id=u.id
    where u.id=uid and s.id=sid and (u.banned_until is null or u.banned_until<now()) for update of u;
  ih:=account_private.identity_hash(uid,provider_name);
  if not found or ih is null or (provider_name in ('google','kakao') and not coalesce(auth.jwt()->'amr' @> '[{"method":"oauth"}]'::jsonb,false)) then
    raise exception 'verified_%_required',provider_name using errcode='42501'; end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then return jsonb_build_object('error','account_deletion_pending'); end if;

  if provider_name='phone' then
    select b.account_id into phone_owner from account_private.account_identities b
      where b.provider='phone' and b.identity_hash=ih;
    if phone_owner is null and exists(select 1 from account_private.phone_identity_conflicts c
        where c.identity_hash=ih and c.resolved_at is null) then
      return jsonb_build_object('error','phone_identity_conflict');
    end if;
  end if;

  select v.* into d from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
    where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_hash=dh;
  if device_platform<>'web' then
    select v.id into recovered_id from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_scope_hash=scope;
  end if;
  if d.id is not null and ((d.platform<>'web' and (device_platform<>d.platform or d.device_scope_hash<>scope))
    or (recovered_id is not null and recovered_id<>d.id)) then return jsonb_build_object('error','device_binding_mismatch'); end if;
  if (select count(distinct v.account_id) from account_private.account_devices v
      join account_private.account_identities b on b.account_id=v.account_id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih
        and (v.device_hash=dh or (device_platform<>'web' and v.device_scope_hash=scope)))>1 then
    return jsonb_build_object('error','account_resolution_required'); end if;

  if d.id is null or (device_platform<>'web' and d.platform='web') then
    if not account_private.fresh_identity(provider_name) then return jsonb_build_object('error','fresh_'||provider_name||'_verification_required'); end if;
    if d.id is null then
      insert into account_private.reinstall_attempts(auth_user_id,attempts) values(uid,1)
      on conflict(auth_user_id) do update set
        attempts=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour' then 1 else account_private.reinstall_attempts.attempts+1 end,
        window_started=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour' then now() else account_private.reinstall_attempts.window_started end
      returning account_private.reinstall_attempts.attempts into attempts;
      if attempts>10 then return jsonb_build_object('error','recovery_rate_limited'); end if;
      if recovered_id is not null then
        select * into d from account_private.account_devices where id=recovered_id;
        restored:=true;
      end if;
    end if;
  end if;
  aid:=d.account_id;

  -- A fresh phone OTP on one stable native scope rotates the login identity
  -- only when that scope has exactly one canonical account.  The account UUID
  -- and every row owned by it remain unchanged.
  if aid is null and provider_name='phone' and device_platform<>'web' then
    select count(distinct v.account_id),(array_agg(distinct v.account_id order by v.account_id))[1]
      into scope_matches,scope_account
    from account_private.account_devices v
    left join public.profiles p on p.id=v.account_id
    where v.device_scope_hash=scope
      and not coalesce(p.status::text='suspended' and (p.suspended_until is null or p.suspended_until>now()),false);
    if scope_matches>1 then return jsonb_build_object('error','account_resolution_required'); end if;
    if scope_matches=1 then
      if phone_owner is not null and phone_owner<>scope_account then
        return jsonb_build_object('error','phone_identity_conflict');
      end if;
      aid:=scope_account;
      select * into d from account_private.account_devices
        where account_id=aid and device_scope_hash=scope for update;
      if not exists(select 1 from account_private.account_identities b
          where b.account_id=aid and b.provider='phone' and b.identity_hash=ih) then
        select b.identity_hash into old_phone_hash from account_private.account_identities b
          where b.account_id=aid and b.provider='phone' for update;
        if old_phone_hash is not null then
          perform account_private.retire_phone_identity(aid,old_phone_hash,'same_device_phone_rotation');
        end if;
        if exists(select 1 from account_private.account_identities b
            where b.account_id=aid and b.auth_user_id=uid) then
          return jsonb_build_object('error','account_link_conflict');
        end if;
        insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
          values(aid,uid,'phone',ih);
        update account_private.device_accounts set auth_user_id=uid,phone_hash=ih
          where id=aid and auth_provider='phone';
        phone_rotated:=true;
      end if;
      restored:=true;
    end if;
  end if;

  -- Social subjects are portable identities.  Exactly one Google/Kakao
  -- mapping restores its canonical account on another device.
  if aid is null and provider_name in ('google','kakao') then
    select count(*),(array_agg(account_id))[1] into matches,aid from account_private.account_identities
      where provider=provider_name and auth_user_id=uid and identity_hash=ih;
    if matches>1 then return jsonb_build_object('error','account_resolution_required'); end if;
    restored:=aid is not null;
  end if;

  select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
  if previous_id is not null and (previous_id is distinct from aid or previous_device is distinct from d.id) then
    return jsonb_build_object('error','reauthenticate_required'); end if;
  if exists(select 1 from account_private.account_devices v where v.account_id=aid
      and (v.device_scope_hash=scope or v.device_hash=dh) and v.id is distinct from d.id) then
    return jsonb_build_object('error','device_binding_mismatch'); end if;
  if device_platform='web' and exists(select 1 from account_private.account_devices
      where device_hash=dh and platform<>'web') then return jsonb_build_object('error','device_binding_mismatch'); end if;
  if aid is not null and (not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.auth_user_id=uid and account_private.identity_active(b))
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now()))) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  if previous_id is null and (select count(*) from account_private.device_login_events
      where scope_hash=scope and created_at>now()-interval '1 hour')>=20 then
    return jsonb_build_object('error','account_switch_rate_limited'); end if;

  if d.id is null then
    if exists(select 1 from account_private.device_enrollment_history where scope_hash=scope and blocked_until>now()) then
      return jsonb_build_object('error','device_enrollment_cooldown'); end if;
    if (select count(*) from account_private.device_registrations where phone_hash=ih and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited'); end if;
    if aid is null and (select count(*) from account_private.device_registrations
        where scope_hash=scope and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited'); end if;
    if aid is null then
      -- A verified phone used on a genuinely new device gets a new canonical
      -- account.  Retire the old login mapping, but never delete/move its data.
      if provider_name='phone' and phone_owner is not null then
        perform account_private.retire_phone_identity(phone_owner,ih,'new_device_phone_reassignment');
      end if;
      insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
        values(uid,ih,dh,provider_name,scope) returning id into aid;
      insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
        values(aid,uid,provider_name,ih);
      created:=true;
    end if;
    insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
      values(aid,dh,scope,device_platform,created) returning * into d;
    insert into account_private.device_registrations(phone_hash,scope_hash) values(ih,case when created then scope end);
  end if;
  if d.device_hash<>dh then delete from account_private.sessions where device_id=d.id and session_id<>sid; end if;
  insert into account_private.device_enrollment_history(scope_hash,welcome_used)
    select scope,coalesce((select welcome_used from account_private.device_enrollment_history where scope_hash=dh),false)
      or coalesce((select welcome_points_claimed from public.profiles where id=aid),false)
    on conflict(scope_hash) do update set welcome_used=account_private.device_enrollment_history.welcome_used or excluded.welcome_used,
      retain_until=now()+interval '1 year';
  update account_private.account_devices set device_hash=dh,device_scope_hash=scope,platform=device_platform where id=d.id;
  if d.is_primary then
    update account_private.device_accounts set device_hash=dh,device_scope_hash=scope,
      reinstall_platform=case when device_platform='web' then null else device_platform end,
      reinstall_hash=case when device_platform='web' then null else scope end where id=aid;
  end if;
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year' where phone_hash=ih;
  insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
    values(sid,uid,aid,d.id,now()+interval '30 days')
    on conflict(session_id) do update set user_id=excluded.user_id,account_id=excluded.account_id,
      device_id=excluded.device_id,expires_at=excluded.expires_at;
  if previous_id is null then insert into account_private.device_login_events(scope_hash) values(scope); end if;
  return jsonb_build_object('ok',true,'account_id',aid,'created',created,'restored',restored,'phone_rotated',phone_rotated);
end; $$;

revoke all on function account_private.authorize_identity(text,text,text,text) from public,anon,authenticated;

commit;

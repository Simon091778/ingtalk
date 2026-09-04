begin;

-- Phone recovery is intentionally device scoped. A phone subject by itself is
-- not a portable account identity; only a previously verified exact pair is.
create table account_private.phone_device_bindings (
  device_scope_hash text not null check (device_scope_hash ~ '^[a-f0-9]{64}$'),
  phone_identity_hash text not null check (phone_identity_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid not null references account_private.device_accounts(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  primary key (device_scope_hash, phone_identity_hash)
);
create index phone_device_bindings_account on account_private.phone_device_bindings(account_id);
revoke all on account_private.phone_device_bindings from public,anon,authenticated;
grant select on account_private.phone_device_bindings to service_role;

-- Existing unique rows are safe to backfill: migration 012 already quarantined
-- ambiguous global phone mappings instead of choosing a winner.
insert into account_private.phone_device_bindings(
  device_scope_hash,phone_identity_hash,account_id,auth_user_id,created_at,last_verified_at)
select v.device_scope_hash,b.identity_hash,b.account_id,b.auth_user_id,
       least(v.created_at,b.linked_at),greatest(v.created_at,b.linked_at)
from account_private.account_identities b
join account_private.account_devices v on v.account_id=b.account_id
where b.provider='phone'
on conflict(device_scope_hash,phone_identity_hash) do nothing;

-- A phone may legitimately have one account per physical device. Google and
-- Kakao remain globally portable and are still resolved by the social resolver.
drop index if exists account_private.account_identities_one_active_phone_owner;
create index account_identities_phone_lookup
  on account_private.account_identities(identity_hash,account_id) where provider='phone';

-- Preserve the proven social resolver unchanged and put phone login behind a
-- purpose-built exact-pair resolver. This prevents later social fixes from
-- accidentally reintroducing device-only or phone-only phone recovery.
alter function account_private.authorize_identity(text,text,text,text)
  rename to authorize_social_identity_202608310020;

create function account_private.authorize_phone_device_pair(
  device_secret text,device_platform text,reinstall_identifier text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid();
  sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text;
  dh text;
  scope text;
  aid uuid;
  previous_id uuid;
  previous_device uuid;
  d account_private.account_devices;
  created boolean:=false;
  restored boolean:=false;
  attempts integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  perform 1 from auth.users u join auth.sessions s on s.user_id=u.id
    where u.id=uid and s.id=sid and (u.banned_until is null or u.banned_until<now())
    for update of u;
  ih:=account_private.identity_hash(uid,'phone');
  if not found or ih is null then
    raise exception 'verified_phone_required' using errcode='42501';
  end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then
    return jsonb_build_object('error','account_deletion_pending');
  end if;

  select p.account_id into aid
  from account_private.phone_device_bindings p
  where p.device_scope_hash=scope and p.phone_identity_hash=ih
  for update;

  if aid is not null then
    select * into d from account_private.account_devices
      where account_id=aid and device_scope_hash=scope for update;
    if d.id is null then
      return jsonb_build_object('error','account_resolution_required');
    end if;
    if not exists(select 1 from account_private.account_identities b
        where b.account_id=aid and b.provider='phone' and b.identity_hash=ih
          and account_private.identity_active(b)) then
      return jsonb_build_object('error','account_link_unavailable');
    end if;
    restored:=d.device_hash<>dh;
  end if;

  select account_id,device_id into previous_id,previous_device
  from account_private.sessions where session_id=sid;
  if previous_id is not null and
      (previous_id is distinct from aid or (aid is not null and previous_device is distinct from d.id)) then
    return jsonb_build_object('error','reauthenticate_required');
  end if;

  if aid is null then
    if not account_private.fresh_identity('phone') then
      return jsonb_build_object('error','fresh_phone_verification_required');
    end if;
    insert into account_private.reinstall_attempts(auth_user_id,attempts) values(uid,1)
    on conflict(auth_user_id) do update set
      attempts=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour'
        then 1 else account_private.reinstall_attempts.attempts+1 end,
      window_started=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour'
        then now() else account_private.reinstall_attempts.window_started end
    returning account_private.reinstall_attempts.attempts into attempts;
    if attempts>10 then return jsonb_build_object('error','recovery_rate_limited'); end if;
    if exists(select 1 from account_private.device_enrollment_history
        where scope_hash=scope and blocked_until>now()) then
      return jsonb_build_object('error','device_enrollment_cooldown');
    end if;
    if (select count(*) from account_private.device_registrations
        where phone_hash=ih and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited');
    end if;
    if (select count(*) from account_private.device_registrations
        where scope_hash=scope and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited');
    end if;

    insert into account_private.device_accounts(
      auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash,
      reinstall_platform,reinstall_hash)
    values(uid,ih,dh,'phone',scope,
      case when device_platform='web' then null else device_platform end,
      case when device_platform='web' then null else scope end)
    returning id into aid;
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
      values(aid,uid,'phone',ih);
    insert into account_private.account_devices(
      account_id,device_hash,device_scope_hash,platform,is_primary)
      values(aid,dh,scope,device_platform,true) returning * into d;
    insert into account_private.phone_device_bindings(
      device_scope_hash,phone_identity_hash,account_id,auth_user_id)
      values(scope,ih,aid,uid);
    insert into account_private.device_registrations(phone_hash,scope_hash)
      values(ih,scope);
    created:=true;
  else
    if d.device_hash<>dh then
      delete from public.push_tokens p using account_private.sessions old_session
        where p.auth_session_id=old_session.session_id and old_session.device_id=d.id
          and old_session.session_id<>sid;
      delete from account_private.sessions where device_id=d.id and session_id<>sid;
    end if;
    update account_private.account_devices
      set device_hash=dh,platform=device_platform where id=d.id;
    update account_private.device_accounts
      set auth_user_id=uid,phone_hash=ih,device_hash=dh,device_scope_hash=scope,
          reinstall_platform=case when device_platform='web' then null else device_platform end,
          reinstall_hash=case when device_platform='web' then null else scope end
      where id=aid;
    update account_private.phone_device_bindings
      set auth_user_id=uid,last_verified_at=now()
      where device_scope_hash=scope and phone_identity_hash=ih;
  end if;

  insert into account_private.device_enrollment_history(scope_hash,welcome_used)
    values(scope,coalesce((select welcome_points_claimed from public.profiles where id=aid),false))
    on conflict(scope_hash) do update set
      welcome_used=account_private.device_enrollment_history.welcome_used or excluded.welcome_used,
      retain_until=now()+interval '1 year';
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year'
    where phone_hash=ih;
  insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
    values(sid,uid,aid,d.id,now()+interval '30 days')
    on conflict(session_id) do update set user_id=excluded.user_id,account_id=excluded.account_id,
      device_id=excluded.device_id,expires_at=excluded.expires_at;
  if previous_id is null then
    insert into account_private.device_login_events(scope_hash) values(scope);
  end if;
  return jsonb_build_object('ok',true,'account_id',aid,'created',created,'restored',restored,
    'recovery_basis','exact_phone_device_pair');
end $$;

create function account_private.authorize_identity(
  device_secret text,device_platform text,reinstall_identifier text,provider_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if provider_name='phone' then
    return account_private.authorize_phone_device_pair(
      device_secret,device_platform,reinstall_identifier);
  end if;
  return account_private.authorize_social_identity_202608310020(
    device_secret,device_platform,reinstall_identifier,provider_name);
end $$;

revoke all on function account_private.authorize_phone_device_pair(text,text,text),
  account_private.authorize_social_identity_202608310020(text,text,text,text),
  account_private.authorize_identity(text,text,text,text) from public,anon,authenticated;
grant execute on function account_private.authorize_phone_device_pair(text,text,text),
  account_private.authorize_social_identity_202608310020(text,text,text,text),
  account_private.authorize_identity(text,text,text,text) to service_role;

notify pgrst,'reload schema';
commit;

-- Phone Auth proves number possession; the invisible installation secret selects
-- an independent app principal. Auth UID is never an app account identifier.
create table account_private.device_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  phone_hash text,
  device_hash text,
  created_at timestamptz not null default now(),
  unique(auth_user_id, phone_hash, device_hash)
);
create table account_private.phone_hash_key (
  singleton boolean primary key default true check(singleton),
  secret bytea not null default extensions.gen_random_bytes(32)
);
insert into account_private.phone_hash_key default values;
create table account_private.phone_welcome_grants (
  phone_hash text primary key,
  created_at timestamptz not null default now(),
  retain_until timestamptz not null default now()+interval '1 year'
);
create table account_private.device_registrations (
  phone_hash text not null,
  created_at timestamptz not null default now()
);
create index device_registrations_phone_time on account_private.device_registrations(phone_hash,created_at);
create table account_private.identity_deletions (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
revoke all on all tables in schema account_private from public,anon,authenticated;

create function account_private.hash_phone(phone_value text) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.hmac(phone_value,encode(secret,'hex'),'sha256'),'hex')
  from account_private.phone_hash_key where singleton;
$$;

-- Preserve old test rows, but no device can claim them. New principals get new UUIDs.
insert into account_private.device_accounts(id,auth_user_id)
select id,id from public.profiles;
alter table public.profiles drop constraint profiles_id_fkey;
alter table public.profiles add constraint profiles_id_fkey foreign key(id)
  references account_private.device_accounts(id) on delete cascade;

truncate account_private.sessions;
alter table account_private.sessions add column account_id uuid not null
  references account_private.device_accounts(id) on delete cascade;

create function public.current_account_id() returns uuid
language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.admin_users a where a.user_id=auth.uid() and a.is_active
    and auth.jwt()->'amr' @> '[{"method":"password"}]'::jsonb) then auth.uid()
  else (
    select g.account_id from account_private.sessions g
    join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
    join auth.users u on u.id=g.user_id
    join account_private.device_accounts a on a.id=g.account_id and a.auth_user_id=u.id
    where g.user_id=auth.uid() and g.session_id::text=auth.jwt()->>'session_id'
      and g.expires_at>now() and a.device_hash is not null
      and a.phone_hash=account_private.hash_phone(u.phone) and u.phone_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<now())
      and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=u.id)
  ) end;
$$;
create or replace function public.account_access_allowed() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(auth.jwt()->>'role'='service_role',false) or public.current_account_id() is not null;
$$;

create function public.authorize_device_account(device_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_private.verified_user(); sid uuid:=(auth.jwt()->>'session_id')::uuid;
  phone_value text; ph text; dh text; aid uuid; previous uuid; fresh boolean:=false;
begin
  if device_secret is null or device_secret !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_device_secret' using errcode='22023';
  end if;
  select phone into phone_value from auth.users where id=uid for update;
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then
    return jsonb_build_object('error','account_deletion_pending');
  end if;
  ph:=account_private.hash_phone(phone_value);
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year' where phone_hash=ph;
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  select id into aid from account_private.device_accounts
    where auth_user_id=uid and phone_hash=ph and device_hash=dh;
  select account_id into previous from account_private.sessions where session_id=sid;
  -- A JWT never changes principal while subscriptions/requests using it exist.
  if previous is not null and previous is distinct from aid then
    return jsonb_build_object('error','reauthenticate_required');
  end if;
  if aid is null then
    if (select count(*) from account_private.device_registrations where phone_hash=ph
      and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited');
    end if;
    insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash)
      values(uid,ph,dh) returning id into aid;
    insert into account_private.device_registrations(phone_hash) values(ph);
    fresh:=true;
  end if;
  insert into account_private.sessions(session_id,user_id,account_id,expires_at)
    values(sid,uid,aid,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'account_id',aid,'created',fresh);
end $$;

-- Replace business identity references, including function defaults and RLS.
-- Keep the Auth/session helpers on real auth.uid(); the principal resolver must
-- never resolve itself recursively. Admin sessions resolve to their Auth UUID.
do $$ declare f record; definition text; policy_row record; begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prokind='f' and (n.nspname='public' or (n.nspname='account_private' and p.proname like 'legacy_%'))
      and p.proname not in ('current_account_id','account_access_allowed','require_account_access',
        'account_security_status','authorize_device_account','lock_account_session',
        'enroll_account_password','unlock_account','reset_account_password','prepare_phone_change','change_account_password')
  loop
    definition:=pg_get_functiondef(f.oid);
    if position('auth.uid()' in definition)>0 then
      execute replace(definition,'auth.uid()','public.current_account_id()');
    end if;
  end loop;
  for policy_row in select schemaname,tablename,policyname,qual,with_check from pg_policies
    where schemaname in ('public','storage') and (qual like '%auth.uid()%' or with_check like '%auth.uid()%')
  loop
    execute format('alter policy %I on %I.%I%s%s',policy_row.policyname,policy_row.schemaname,policy_row.tablename,
      case when policy_row.qual is null then '' else ' using ('||replace(policy_row.qual,'auth.uid()','public.current_account_id()')||')' end,
      case when policy_row.with_check is null then '' else ' with check ('||replace(policy_row.with_check,'auth.uid()','public.current_account_id()')||')' end);
  end loop;
end $$;

create or replace function public.claim_account_welcome_points() returns bigint
language plpgsql security definer set search_path='' as $$
declare aid uuid:=public.current_account_id(); ph text; claimed boolean:=false; points bigint;
begin
  perform public.require_account_access();
  if aid is null then raise exception 'device_account_required'; end if;
  select phone_hash into ph from account_private.device_accounts where id=aid;
  update public.profiles set welcome_points_claimed=true where id=aid and not welcome_points_claimed;
  if found and ph is not null then
    insert into account_private.phone_welcome_grants(phone_hash) values(ph) on conflict do nothing;
    claimed:=found;
  end if;
  if claimed then
    update public.point_wallets set balance=balance+100,updated_at=now() where user_id=aid;
    if not found then raise exception 'wallet_missing'; end if;
    insert into public.point_transactions(user_id,amount,reason) values(aid,100,'welcome_account');
  end if;
  select balance into points from public.point_wallets where user_id=aid;
  return points;
end $$;

-- Accept both token prefixes emitted by Expo; keep table and RPC validation aligned.
alter table public.push_tokens drop constraint push_tokens_token_check;
alter table public.push_tokens add constraint push_tokens_token_check
  check(token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$') not valid;
create or replace function public.register_account_push_token(push_token text,device_platform text) returns void
language plpgsql security definer set search_path='' as $$
declare aid uuid:=public.current_account_id();
begin
  perform public.require_account_access();
  if aid is null or push_token is null or push_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
    or device_platform is null or device_platform not in ('android','ios') then raise exception 'invalid_push_token'; end if;
  perform pg_advisory_xact_lock(hashtextextended(push_token,0));
  delete from public.push_tokens where token=push_token;
  insert into public.push_tokens(user_id,token,platform,auth_session_id,updated_at)
    values(aid,push_token,device_platform,(auth.jwt()->>'session_id')::uuid,now());
end $$;
create or replace function public.active_account_push_tokens(target_user uuid) returns table(token text,platform text)
language sql stable security definer set search_path='' as $$
  select p.token,p.platform from public.push_tokens p
  join account_private.sessions g on g.session_id=p.auth_session_id and g.account_id=p.user_id and g.expires_at>now()
  join account_private.device_accounts a on a.id=g.account_id and a.auth_user_id=g.user_id
  join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
  join auth.users u on u.id=g.user_id
  where p.user_id=target_user and a.phone_hash=account_private.hash_phone(u.phone)
    and u.phone_confirmed_at is not null and (u.banned_until is null or u.banned_until<now());
$$;

-- No phone/email/password change can turn one device account into another.
create or replace function account_private.protect_phone_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from account_private.device_accounts where auth_user_id=old.id and device_hash is not null) then return new; end if;
  if new.phone is distinct from old.phone or new.email is distinct from old.email
    or new.encrypted_password is distinct from old.encrypted_password
    or (new.phone_change is distinct from old.phone_change and nullif(new.phone_change,'') is not null) then
    raise exception 'phone_identity_change_not_supported';
  end if;
  return new;
end $$;

create or replace function public.check_account_request() returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if current_setting('request.path',true)=any(array['/rpc/current_account_id','/rpc/authorize_device_account',
    '/rpc/account_access_allowed','/rpc/lock_account_session']) then return; end if;
  perform public.require_account_access();
end $$;

-- Delete only this app principal, not other devices sharing the SMS identity.
create function public.delete_device_account_data(target_account uuid,identity_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; remaining integer;
begin
  perform 1 from auth.users where id=identity_user for update;
  if not exists(select 1 from account_private.device_accounts where id=target_account and auth_user_id=identity_user and device_hash is not null) then
    raise exception 'account_identity_mismatch';
  end if;
  result:=public.delete_account_data(target_account);
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year'
    where phone_hash=(select phone_hash from account_private.device_accounts where id=target_account);
  delete from account_private.device_accounts where id=target_account;
  select count(*) into remaining from account_private.device_accounts where auth_user_id=identity_user and device_hash is not null;
  if remaining=0 then insert into account_private.identity_deletions(auth_user_id) values(identity_user) on conflict do nothing; end if;
  return result||jsonb_build_object('delete_auth_identity',remaining=0);
end $$;
create function public.pending_phone_identity_deletion(identity_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from account_private.identity_deletions where auth_user_id=identity_user);
$$;
revoke all on function public.delete_device_account_data(uuid,uuid),public.pending_phone_identity_deletion(uuid) from public,anon,authenticated;
grant execute on function public.delete_device_account_data(uuid,uuid),public.pending_phone_identity_deletion(uuid) to service_role;

-- Extend the existing daily retention job; no indefinite detached phone hashes.
do $$ begin
  execute replace(pg_get_functiondef('public.run_retention_cleanup(integer)'::regprocedure),
    'FUNCTION public.run_retention_cleanup(', 'FUNCTION account_private.base_retention_cleanup(');
end $$;
create or replace function public.run_retention_cleanup(batch_limit integer default 5000) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=account_private.base_retention_cleanup(batch_limit);
  delete from account_private.device_registrations where created_at<=now()-interval '24 hours';
  delete from account_private.phone_welcome_grants g where g.retain_until<=now()
    and not exists(select 1 from account_private.device_accounts a where a.phone_hash=g.phone_hash);
  return result;
end $$;

-- Remove all human-password/recovery paths and their stored hashes. No CASCADE.
drop function public.account_security_status();
drop function public.enroll_account_password(text);
drop function public.unlock_account(text);
drop function public.reset_account_password(text,text);
drop function public.prepare_phone_change(text,text);
drop function public.change_account_password(text,text);
drop function account_private.legacy_change_account_password(text,text);
drop function account_private.legacy_register_account_push_token(text,text);
drop function account_private.check_secret(uuid,text,boolean);
drop function account_private.check_password_format(text);
drop function account_private.grant_session(uuid);
drop table account_private.credentials;
revoke all on all functions in schema account_private from public,anon,authenticated;
revoke all on function public.current_account_id(),public.authorize_device_account(text) from public,anon;
grant execute on function public.current_account_id(),public.authorize_device_account(text) to authenticated,service_role;
notify pgrst,'reload schema';
notify pgrst,'reload config';

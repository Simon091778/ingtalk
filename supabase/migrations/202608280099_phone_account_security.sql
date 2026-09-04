-- SMS proves current possession of a number, not ownership of its old account.
-- A separate account password/recovery code unlocks each Auth session.
-- This migration deliberately does NOT delete existing users or their data.
create schema if not exists account_private;
revoke all on schema account_private from public, anon, authenticated;
create extension if not exists pgcrypto with schema extensions;

create table account_private.credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text not null unique,
  password_hash text not null,
  recovery_hash text not null,
  failures integer not null default 0,
  blocked_until timestamptz,
  pending_phone text unique,
  pending_until timestamptz,
  created_at timestamptz not null default now()
);
create table account_private.sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '30 days'
);
revoke all on all tables in schema account_private from public, anon, authenticated;

create function account_private.verified_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
begin
  if uid is null or sid is null or not exists (
    select 1 from auth.users u join auth.sessions s on s.user_id = u.id
    where u.id = uid and s.id = sid and u.phone_confirmed_at is not null
      and coalesce(u.is_anonymous, false) = false and u.phone is not null
      and (u.banned_until is null or u.banned_until < now())
  ) then raise exception 'verified_phone_required' using errcode = '42501'; end if;
  return uid;
end $$;

create function public.account_access_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt()->>'role' = 'service_role', false)
    or exists (select 1 from public.admin_users a where a.user_id = auth.uid() and a.is_active
      and auth.jwt()->'amr' @> '[{"method":"password"}]'::jsonb)
    or exists (
      select 1 from account_private.sessions g
      join auth.sessions s on s.id = g.session_id and s.user_id = g.user_id
      join auth.users u on u.id = g.user_id
      join account_private.credentials c on c.user_id = u.id and c.phone = u.phone
      where g.user_id = auth.uid() and g.session_id::text = auth.jwt()->>'session_id'
        and g.expires_at > now() and u.phone_confirmed_at is not null
        and (u.banned_until is null or u.banned_until < now())
    );
$$;

create function public.require_account_access() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Preserve trusted SQL-console/cron maintenance. SECURITY DEFINER's
  -- current_user is NOT suitable here: it would bypass every app request.
  if session_user in ('postgres','supabase_admin')
    and current_setting('role',true) in ('none','postgres','supabase_admin') then return; end if;
  if not public.account_access_allowed() then
    raise exception 'account_unlock_required' using errcode = '42501';
  end if;
end $$;

create function public.account_security_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user();
begin
  return jsonb_build_object('enrolled', exists(select 1 from account_private.credentials where user_id = uid),
    'unlocked', public.account_access_allowed());
end $$;

create function account_private.check_password_format(value text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if value is null or char_length(value) < 12 or octet_length(value) > 72 then
    raise exception 'password_length_12_to_72_bytes';
  end if;
end $$;

create function account_private.grant_session(uid uuid) returns void
language sql security definer set search_path = '' as $$
  insert into account_private.sessions(session_id, user_id)
  values ((auth.jwt()->>'session_id')::uuid, uid)
  on conflict(session_id) do update set expires_at = now() + interval '30 days';
$$;

create function public.enroll_account_password(new_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user(); recovery text; phone_value text;
begin
  perform account_private.check_password_format(new_password);
  -- Serialize enrollment, including the no-credential-yet case.
  select phone into phone_value from auth.users where id = uid for update;
  if exists(select 1 from account_private.credentials where user_id = uid) then
    return jsonb_build_object('error', 'already_enrolled');
  end if;
  -- Never turn a legacy/test profile into a reclaimable SMS-only account.
  if exists(select 1 from public.profiles where id = uid) then
    return jsonb_build_object('error', 'legacy_account_requires_reset');
  end if;
  recovery := encode(extensions.gen_random_bytes(24), 'hex');
  insert into account_private.credentials(user_id, phone, password_hash, recovery_hash)
  values(uid, phone_value, extensions.crypt(new_password, extensions.gen_salt('bf', 12)),
    encode(extensions.digest(recovery, 'sha256'), 'hex'));
  perform account_private.grant_session(uid);
  return jsonb_build_object('ok', true, 'recovery_code', recovery);
end $$;

-- Returning errors (rather than raising) commits the failed-attempt counter.
create function account_private.check_secret(uid uuid, value text, recovery boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c account_private.credentials; matched boolean;
begin
  select * into c from account_private.credentials where user_id = uid for update;
  if c.user_id is null or c.blocked_until > now() then return false; end if;
  if value is null or octet_length(value) > 256 then return false; end if;
  if recovery then
    matched := c.recovery_hash = encode(extensions.digest(lower(trim(value)), 'sha256'), 'hex');
  else
    matched := octet_length(value) <= 72 and c.password_hash = extensions.crypt(value, c.password_hash);
  end if;
  if not matched then
    update account_private.credentials set failures = case when failures >= 4 then 0 else failures + 1 end,
      blocked_until = case when failures >= 4 then now() + interval '15 minutes' else null end
    where user_id = uid;
    return false;
  end if;
  update account_private.credentials set failures = 0, blocked_until = null where user_id = uid;
  return true;
end $$;

create function public.unlock_account(account_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user();
begin
  if not account_private.check_secret(uid, account_password) then
    return jsonb_build_object('error', 'invalid_credentials_or_rate_limited');
  end if;
  perform account_private.grant_session(uid);
  return jsonb_build_object('ok', true);
end $$;

create function public.reset_account_password(recovery_code text, new_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user(); next_recovery text;
begin
  perform account_private.check_password_format(new_password);
  if not account_private.check_secret(uid, recovery_code, true) then
    return jsonb_build_object('error', 'invalid_credentials_or_rate_limited');
  end if;
  next_recovery := encode(extensions.gen_random_bytes(24), 'hex');
  update account_private.credentials set password_hash = extensions.crypt(new_password, extensions.gen_salt('bf', 12)),
    recovery_hash = encode(extensions.digest(next_recovery, 'sha256'), 'hex'), pending_phone = null, pending_until = null
  where user_id = uid;
  delete from account_private.sessions where user_id = uid;
  perform account_private.grant_session(uid);
  return jsonb_build_object('ok', true, 'recovery_code', next_recovery);
end $$;

create function public.prepare_phone_change(account_password text, new_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user();
begin
  perform public.require_account_access();
  if new_phone is null or new_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid_phone'; end if;
  if not account_private.check_secret(uid, account_password) then
    return jsonb_build_object('error', 'invalid_credentials_or_rate_limited');
  end if;
  -- Supabase stores E.164 digits without the leading plus.
  new_phone := ltrim(new_phone, '+');
  if exists(select 1 from auth.users where id <> uid and (phone = new_phone or phone_change = new_phone)) then
    return jsonb_build_object('error', 'phone_unavailable');
  end if;
  update account_private.credentials set pending_phone = new_phone, pending_until = now() + interval '10 minutes'
  where user_id = uid;
  return jsonb_build_object('ok', true);
exception when unique_violation then return jsonb_build_object('error', 'phone_unavailable');
end $$;

create function public.change_account_password(current_password text, new_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user(); recovery text;
begin
  perform public.require_account_access();
  perform account_private.check_password_format(new_password);
  if not account_private.check_secret(uid,current_password) then
    return jsonb_build_object('error','invalid_credentials_or_rate_limited');
  end if;
  recovery := encode(extensions.gen_random_bytes(24),'hex');
  update account_private.credentials set password_hash=extensions.crypt(new_password,extensions.gen_salt('bf',12)),
    recovery_hash=encode(extensions.digest(recovery,'sha256'),'hex'),pending_phone=null,pending_until=null where user_id=uid;
  delete from account_private.sessions where user_id=uid;
  perform account_private.grant_session(uid);
  return jsonb_build_object('ok',true,'recovery_code',recovery);
end $$;
revoke all on function public.change_account_password(text,text) from public,anon;
grant execute on function public.change_account_password(text,text) to authenticated;

-- An OTP-only session can call Auth directly. Protect the identity there too,
-- not only in the app UI / Data API. Never use user-editable metadata as proof.
create function account_private.protect_phone_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c account_private.credentials;
begin
  select * into c from account_private.credentials where user_id = old.id for update;
  if c.user_id is null then return new; end if;
  if new.email is distinct from old.email or new.encrypted_password is distinct from old.encrypted_password then
    raise exception 'auth_credentials_managed_by_account_security';
  end if;
  if new.phone_change is distinct from old.phone_change and nullif(new.phone_change, '') is not null then
    if new.phone_change is distinct from c.pending_phone or c.pending_until <= now() or c.pending_until is null then
      raise exception 'phone_change_not_authorized';
    end if;
  end if;
  if new.phone is distinct from old.phone then
    if new.phone is distinct from c.pending_phone or c.pending_until <= now() or c.pending_until is null then
      raise exception 'phone_change_not_authorized';
    end if;
    update account_private.credentials set phone = new.phone, pending_phone = null, pending_until = null where user_id = old.id;
    delete from account_private.sessions where user_id = old.id;
  end if;
  return new;
end $$;
create trigger protect_phone_account_identity before update on auth.users
for each row execute function account_private.protect_phone_identity();

-- Device fingerprints no longer authorize accounts or own balances.
revoke all on function public.restore_device_account(text) from public, anon, authenticated;
revoke all on function public.claim_device_welcome_points(text) from public, anon, authenticated;
drop trigger if exists sync_active_device_wallet_after_balance on public.point_wallets;

create function public.claim_account_welcome_points() returns bigint
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user(); points bigint;
begin
  perform public.require_account_access();
  update public.profiles set welcome_points_claimed = true where id = uid and not welcome_points_claimed;
  if found then
    update public.point_wallets set balance = balance + 100, updated_at = now() where user_id = uid;
    if not found then raise exception 'wallet_missing'; end if;
    insert into public.point_transactions(user_id, amount, reason) values(uid, 100, 'welcome_account');
  end if;
  select balance into points from public.point_wallets where user_id = uid;
  return points;
end $$;

alter table public.push_tokens add column auth_session_id uuid references auth.sessions(id) on delete cascade;
create function public.register_account_push_token(push_token text, device_platform text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := account_private.verified_user();
begin
  perform public.require_account_access();
  if push_token is null or push_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
    or device_platform is null or device_platform not in ('android','ios') then raise exception 'invalid_push_token'; end if;
  perform pg_advisory_xact_lock(hashtextextended(push_token, 0));
  delete from public.push_tokens where token = push_token;
  insert into public.push_tokens(user_id,token,platform,auth_session_id,updated_at)
  values(uid,push_token,device_platform,(auth.jwt()->>'session_id')::uuid,now());
end $$;

create function public.active_account_push_tokens(target_user uuid) returns table(token text,platform text)
language sql stable security definer set search_path = '' as $$
  select p.token,p.platform from public.push_tokens p
  join account_private.sessions g on g.session_id=p.auth_session_id and g.user_id=p.user_id and g.expires_at>now()
  join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
  join auth.users u on u.id=p.user_id
  join account_private.credentials c on c.user_id=u.id and c.phone=u.phone
  where p.user_id=target_user and (u.banned_until is null or u.banned_until<now());
$$;
revoke all on function public.active_account_push_tokens(uuid) from public,anon,authenticated;
grant execute on function public.active_account_push_tokens(uuid) to service_role;

create function public.lock_account_session() returns void
language sql security definer set search_path = '' as $$
  delete from account_private.sessions where user_id=auth.uid() and session_id::text=auth.jwt()->>'session_id';
$$;
revoke all on function public.register_account_push_token(text,text), public.lock_account_session() from public,anon;
grant execute on function public.register_account_push_token(text,text), public.lock_account_session() to authenticated;

-- PostgREST pre-request protects legacy SECURITY DEFINER RPCs as well as views.
-- RLS separately covers Storage and Realtime, which do not run this hook.
create function public.check_account_request() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if current_setting('request.path', true) = any(array[
    '/rpc/account_security_status', '/rpc/enroll_account_password', '/rpc/unlock_account',
    '/rpc/reset_account_password', '/rpc/account_access_allowed', '/rpc/lock_account_session'
  ]) then return; end if;
  perform public.require_account_access();
end $$;
alter role authenticator set pgrst.db_pre_request = 'public.check_account_request';

-- Guard every existing app-callable SECURITY DEFINER entry point as well.
-- Copy the implementation into the unexposed schema, retaining the original
-- public function OID/signature/grants so policies and callers keep working.
do $$
declare f record; definition text; args text; invocation text; statement text;
begin
  for f in select p.*, pg_get_function_arguments(p.oid) as arguments,
      pg_get_function_result(p.oid) as result_type
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.prosecdef and l.lanname in ('sql', 'plpgsql')
      and p.prorettype <> 'trigger'::regtype and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname not in ('account_access_allowed', 'require_account_access', 'account_security_status',
        'enroll_account_password', 'unlock_account', 'reset_account_password', 'prepare_phone_change',
        'claim_account_welcome_points', 'check_account_request', 'lock_account_session')
  loop
    definition := pg_get_functiondef(f.oid);
    definition := replace(definition, format('FUNCTION public.%I(', f.proname),
      format('FUNCTION account_private.%I(', 'legacy_' || f.proname));
    execute definition;
    select string_agg('$' || i, ', ' order by i) into args from generate_series(1, f.pronargs) i;
    invocation := format('account_private.%I(%s)', 'legacy_' || f.proname, coalesce(args, ''));
    statement := case when f.proretset then 'RETURN QUERY SELECT * FROM ' || invocation || ';'
      when f.prorettype = 'void'::regtype then 'PERFORM ' || invocation || '; RETURN;'
      else 'RETURN ' || invocation || ';' end;
    execute format('CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $guard$ BEGIN PERFORM public.require_account_access(); %s END $guard$',
      f.proname, f.arguments, f.result_type, statement);
  end loop;
end $$;

do $$ declare t record; begin
  for t in select schemaname, tablename from pg_tables
    where schemaname = 'public' and rowsecurity or schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('create policy phone_account_gate on %I.%I as restrictive for all to authenticated using ((select public.account_access_allowed())) with check ((select public.account_access_allowed()))', t.schemaname, t.tablename);
  end loop;
end $$;

revoke all on all functions in schema account_private from public, anon, authenticated;
revoke all on function public.account_access_allowed(), public.require_account_access(), public.account_security_status(),
  public.enroll_account_password(text), public.unlock_account(text), public.reset_account_password(text,text),
  public.prepare_phone_change(text,text), public.claim_account_welcome_points(), public.check_account_request() from public, anon;
grant execute on function public.account_access_allowed(), public.require_account_access(), public.account_security_status(),
  public.enroll_account_password(text), public.unlock_account(text), public.reset_account_password(text,text),
  public.prepare_phone_change(text,text), public.claim_account_welcome_points(), public.check_account_request() to authenticated, service_role;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

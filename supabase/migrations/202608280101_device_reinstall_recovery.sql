-- Add same-phone, same-device reinstall recovery without exposing phone mappings.
-- Android's app-scoped ID is not hardware attestation; a fresh SMS is mandatory
-- for binding and key rotation. Existing random-key sessions keep working.
alter table account_private.device_accounts
  add column reinstall_platform text,
  add column reinstall_hash text,
  add constraint device_reinstall_pair check (
    (reinstall_platform is null and reinstall_hash is null)
    or (reinstall_platform in ('android','ios') and reinstall_platform is not null
      and reinstall_hash is not null and reinstall_hash ~ '^[a-f0-9]{64}$')),
  add constraint device_reinstall_unique unique(auth_user_id,phone_hash,reinstall_platform,reinstall_hash);

create table account_private.reinstall_attempts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  window_started timestamptz not null default now(),
  attempts integer not null default 0
);
revoke all on account_private.reinstall_attempts from public,anon,authenticated;

create function account_private.recent_phone_otp(uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  -- OTP AMR alone can also represent email OTP. Recovery accepts phone-only
  -- identities and a matching signed JWT phone claim, never user_metadata.
  select exists(select 1 from auth.users u where u.id=uid and nullif(u.email,'') is null
    and ltrim(coalesce(auth.jwt()->>'phone',''),'+')=u.phone)
    and exists(select 1 from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) m
      where m->>'method'='otp' and
        case when m->>'timestamp' ~ '^[0-9]{1,12}$' then (m->>'timestamp')::numeric else 0 end
        between extract(epoch from now()-interval '10 minutes') and extract(epoch from now()+interval '1 minute'));
$$;

create function public.authorize_device_account_v2(device_secret text,device_platform text,reinstall_identifier text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=account_private.verified_user(); sid uuid:=(auth.jwt()->>'session_id')::uuid;
  ph text; dh text; rh text; aid uuid; recovered_id uuid; previous_id uuid;
  bound_platform text; bound_hash text; attempt_count integer; result jsonb; restored boolean:=false;
begin
  if device_secret is null or device_secret !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_device_secret' using errcode='22023';
  end if;
  if device_platform is null or device_platform not in ('android','ios','web')
    or (device_platform='web' and reinstall_identifier is not null)
    or (device_platform<>'web' and (reinstall_identifier is null or reinstall_identifier !~ '^[a-f0-9]{64}$')) then
    raise exception 'invalid_reinstall_identity' using errcode='22023';
  end if;
  -- Same lock as enrollment/deletion; concurrent restores never make two wallets.
  select account_private.hash_phone(phone) into ph from auth.users where id=uid for update;
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then
    return jsonb_build_object('error','account_deletion_pending');
  end if;
  if device_platform='web' then
    return public.authorize_device_account(device_secret)||jsonb_build_object('restored',false);
  end if;
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  rh:=account_private.hash_phone('reinstall-v1:'||device_platform||':'||reinstall_identifier);
  select id,reinstall_platform,reinstall_hash into aid,bound_platform,bound_hash
    from account_private.device_accounts where auth_user_id=uid and phone_hash=ph and device_hash=dh;
  select id into recovered_id from account_private.device_accounts
    where auth_user_id=uid and phone_hash=ph and reinstall_platform=device_platform and reinstall_hash=rh;
  select account_id into previous_id from account_private.sessions where session_id=sid;

  if previous_id is not null and previous_id is distinct from coalesce(aid,recovered_id) then
    return jsonb_build_object('error','reauthenticate_required');
  end if;
  if aid is not null and ((bound_hash is not null and (bound_hash<>rh or bound_platform<>device_platform))
    or (recovered_id is not null and recovered_id<>aid)) then
    return jsonb_build_object('error','device_binding_mismatch');
  end if;

  if aid is null or bound_hash is null then
    if not account_private.recent_phone_otp(uid) then
      return jsonb_build_object('error','fresh_phone_verification_required');
    end if;
    if aid is null then
      insert into account_private.reinstall_attempts(auth_user_id,attempts) values(uid,1)
      on conflict(auth_user_id) do update set
        attempts=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour'
          then 1 else account_private.reinstall_attempts.attempts+1 end,
        window_started=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour'
          then now() else account_private.reinstall_attempts.window_started end
      returning attempts into attempt_count;
      if attempt_count>10 then return jsonb_build_object('error','recovery_rate_limited'); end if;
    end if;
    if aid is null and recovered_id is not null then
      -- Reuse the existing principal, never copy or re-award a wallet.
      update account_private.device_accounts set device_hash=dh where id=recovered_id;
      delete from account_private.sessions where account_id=recovered_id and session_id<>sid;
      aid:=recovered_id; restored:=true;
    end if;
  end if;
  result:=public.authorize_device_account(device_secret);
  if result->>'ok'='true' then
    aid:=(result->>'account_id')::uuid;
    update account_private.device_accounts set reinstall_platform=device_platform,reinstall_hash=rh where id=aid;
  end if;
  return result||jsonb_build_object('restored',restored);
end $$;

create or replace function public.check_account_request() returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if current_setting('request.path',true)=any(array['/rpc/current_account_id','/rpc/authorize_device_account',
    '/rpc/authorize_device_account_v2','/rpc/account_access_allowed','/rpc/lock_account_session']) then return; end if;
  perform public.require_account_access();
end $$;

create or replace function public.run_retention_cleanup(batch_limit integer default 5000) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=account_private.base_retention_cleanup(batch_limit);
  delete from account_private.device_registrations where created_at<=now()-interval '24 hours';
  delete from account_private.phone_welcome_grants g where g.retain_until<=now()
    and not exists(select 1 from account_private.device_accounts a where a.phone_hash=g.phone_hash);
  delete from account_private.reinstall_attempts where window_started<=now()-interval '1 hour';
  return result;
end $$;
revoke all on function account_private.recent_phone_otp(uuid) from public,anon,authenticated;
revoke all on function public.authorize_device_account_v2(text,text,text) from public,anon;
grant execute on function public.authorize_device_account_v2(text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';

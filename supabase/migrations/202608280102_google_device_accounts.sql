-- Keep transport identities separate from app principals. Never match by email.
-- phone_hash remains the private HMAC ledger key; Google keys are domain separated.
alter table account_private.device_accounts add column auth_provider text not null default 'phone'
  check(auth_provider in ('phone','google'));

create function account_private.google_identity_hash(uid uuid) returns text
language sql stable security definer set search_path='' as $$
  select account_private.hash_phone('google-sub-v1:'||i.provider_id)
  from auth.identities i join auth.users u on u.id=i.user_id
  where i.user_id=uid and i.provider='google' and nullif(i.provider_id,'') is not null
    and i.identity_data->>'sub'=i.provider_id and i.identity_data->>'email_verified'='true'
    and u.email_confirmed_at is not null and nullif(u.phone,'') is null
    and not coalesce(u.is_anonymous,false)
    and not exists(select 1 from auth.identities other where other.user_id=uid and other.provider<>'google')
    and (select count(*) from auth.identities other where other.user_id=uid and other.provider='google')=1
    and not exists(select 1 from public.admin_users a where a.user_id=uid and a.is_active);
$$;

create function account_private.device_identity_matches(a account_private.device_accounts) returns boolean
language sql stable security definer set search_path='' as $$
  select case when a.auth_provider='google' then a.phone_hash=account_private.google_identity_hash(a.auth_user_id)
    else exists(select 1 from auth.users u where u.id=a.auth_user_id and u.phone_confirmed_at is not null
      and a.phone_hash=account_private.hash_phone(u.phone)
      and not exists(select 1 from auth.identities i where i.user_id=u.id and i.provider<>'phone')) end;
$$;

create or replace function public.current_account_id() returns uuid
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
      and account_private.device_identity_matches(a)
      and (u.banned_until is null or u.banned_until<now())
      and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=u.id)
  ) end;
$$;

create function public.authorize_google_device_account(device_secret text,device_platform text,reinstall_identifier text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ph text; dh text; rh text; aid uuid; recovered_id uuid; previous_id uuid;
  bound_platform text; bound_hash text; attempt_count integer; fresh boolean:=false; restored boolean:=false;
begin
  -- Auth (not user_metadata or a client-supplied email) must prove Google OAuth.
  perform 1 from auth.users u join auth.sessions s on s.user_id=u.id
    where u.id=uid and s.id=sid and (u.banned_until is null or u.banned_until<now()) for update of u;
  if not found then raise exception 'verified_google_required' using errcode='42501'; end if;
  ph:=account_private.google_identity_hash(uid);
  if ph is null or not coalesce(auth.jwt()->'amr' @> '[{"method":"oauth"}]'::jsonb,false) then
    raise exception 'verified_google_required' using errcode='42501';
  end if;
  if device_secret is null or device_secret !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_device_secret' using errcode='22023';
  end if;
  if device_platform is null or device_platform not in ('android','ios','web')
    or (device_platform='web' and reinstall_identifier is not null)
    or (device_platform<>'web' and (reinstall_identifier is null or reinstall_identifier !~ '^[a-f0-9]{64}$')) then
    raise exception 'invalid_reinstall_identity' using errcode='22023';
  end if;
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then
    return jsonb_build_object('error','account_deletion_pending');
  end if;
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  rh:=case when device_platform='web' then null else account_private.hash_phone('reinstall-v1:'||device_platform||':'||reinstall_identifier) end;
  select id,reinstall_platform,reinstall_hash into aid,bound_platform,bound_hash
    from account_private.device_accounts where auth_user_id=uid and auth_provider='google' and phone_hash=ph and device_hash=dh;
  select id into recovered_id from account_private.device_accounts
    where auth_user_id=uid and auth_provider='google' and phone_hash=ph and reinstall_platform=device_platform and reinstall_hash=rh;
  select account_id into previous_id from account_private.sessions where session_id=sid;
  if previous_id is not null and previous_id is distinct from coalesce(aid,recovered_id) then
    return jsonb_build_object('error','reauthenticate_required');
  end if;
  if aid is not null and ((bound_hash is not null and (rh is null or bound_hash<>rh or bound_platform<>device_platform))
    or (recovered_id is not null and recovered_id<>aid)) then
    return jsonb_build_object('error','device_binding_mismatch');
  end if;
  if aid is null or (rh is not null and bound_hash is null) then
    if not exists(select 1 from jsonb_array_elements(
      case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) m
      where m->>'method'='oauth' and
        case when m->>'timestamp' ~ '^[0-9]{1,12}$' then (m->>'timestamp')::numeric else 0 end
        between extract(epoch from now()-interval '10 minutes') and extract(epoch from now()+interval '1 minute')) then
      return jsonb_build_object('error','fresh_google_verification_required');
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
      if recovered_id is not null then
        update account_private.device_accounts set device_hash=dh where id=recovered_id;
        delete from account_private.sessions where account_id=recovered_id and session_id<>sid;
        aid:=recovered_id; restored:=true;
      end if;
    end if;
  end if;
  if aid is null then
    if (select count(*) from account_private.device_registrations where phone_hash=ph and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited');
    end if;
    insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider)
      values(uid,ph,dh,'google') returning id into aid;
    insert into account_private.device_registrations(phone_hash) values(ph);
    fresh:=true;
  end if;
  update account_private.device_accounts set reinstall_platform=case when rh is null then null else device_platform end,reinstall_hash=rh where id=aid;
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year' where phone_hash=ph;
  insert into account_private.sessions(session_id,user_id,account_id,expires_at) values(sid,uid,aid,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'account_id',aid,'created',fresh,'restored',restored);
end $$;

create or replace function public.active_account_push_tokens(target_user uuid) returns table(token text,platform text)
language sql stable security definer set search_path='' as $$
  select p.token,p.platform from public.push_tokens p
  join account_private.sessions g on g.session_id=p.auth_session_id and g.account_id=p.user_id and g.expires_at>now()
  join account_private.device_accounts a on a.id=g.account_id and a.auth_user_id=g.user_id
  join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
  join auth.users u on u.id=g.user_id
  where p.user_id=target_user and account_private.device_identity_matches(a)
    and (u.banned_until is null or u.banned_until<now())
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=u.id);
$$;

create or replace function account_private.protect_phone_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from account_private.device_accounts where auth_user_id=old.id and device_hash is not null) then return new; end if;
  if new.phone is distinct from old.phone or new.encrypted_password is distinct from old.encrypted_password
    or (new.phone_change is distinct from old.phone_change and nullif(new.phone_change,'') is not null)
    or (new.email is distinct from old.email and exists(select 1 from account_private.device_accounts
      where auth_user_id=old.id and auth_provider='phone' and device_hash is not null)) then
    raise exception 'phone_identity_change_not_supported';
  end if;
  return new;
end $$;

create or replace function public.check_account_request() returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if current_setting('request.path',true)=any(array['/rpc/current_account_id','/rpc/authorize_device_account',
    '/rpc/authorize_device_account_v2','/rpc/authorize_google_device_account','/rpc/account_access_allowed','/rpc/lock_account_session']) then return; end if;
  perform public.require_account_access();
end $$;
revoke all on function account_private.google_identity_hash(uuid),account_private.device_identity_matches(account_private.device_accounts) from public,anon,authenticated;
revoke all on function public.authorize_google_device_account(text,text,text) from public,anon;
grant execute on function public.authorize_google_device_account(text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';

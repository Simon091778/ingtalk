-- App-level linking: two independently verified Auth identities, one app UUID.
-- Do not enable Supabase automatic/manual identity merging for this protocol.
create table account_private.account_identities (
  account_id uuid not null references account_private.device_accounts(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null check(provider in ('phone','google')),
  identity_hash text not null,
  linked_at timestamptz not null default now(),
  primary key(account_id,provider), unique(account_id,auth_user_id)
);
create index account_identities_user on account_private.account_identities(auth_user_id,identity_hash);
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
  select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where device_hash is not null;

alter table account_private.device_accounts add column device_scope_hash text;
update account_private.device_accounts set device_scope_hash=coalesce(reinstall_hash,device_hash) where device_hash is not null;
create index device_accounts_scope on account_private.device_accounts(device_scope_hash);
create index device_accounts_key on account_private.device_accounts(device_hash);
create table account_private.device_enrollment_history (
  scope_hash text primary key,
  welcome_used boolean not null default false,
  blocked_until timestamptz,
  retain_until timestamptz not null default now()+interval '1 year'
);
insert into account_private.device_enrollment_history(scope_hash,welcome_used)
  select a.device_scope_hash,bool_or(coalesce(p.welcome_points_claimed,false))
  from account_private.device_accounts a left join public.profiles p on p.id=a.id
  where a.device_scope_hash is not null group by a.device_scope_hash;
create table account_private.account_link_requests (
  token_hash text primary key,
  account_id uuid not null references account_private.device_accounts(id) on delete cascade,
  source_user uuid not null references auth.users(id) on delete cascade,
  source_session uuid not null references auth.sessions(id) on delete cascade,
  source_provider text not null,
  device_hash text not null,
  scope_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '5 minutes',
  used_at timestamptz
);
create index account_link_requests_account_time on account_private.account_link_requests(account_id,created_at);
-- Retry metadata survives app-data deletion; it cannot be written/read by clients.
create table account_private.identity_deletion_jobs (
  account_id uuid primary key,
  caller_id uuid not null,
  identity_ids uuid[] not null,
  created_at timestamptz not null default now()
);
revoke all on all tables in schema account_private from public,anon,authenticated;

create function account_private.identity_hash(uid uuid,provider_name text) returns text
language sql stable security definer set search_path='' as $$
  select case when provider_name='google' then account_private.google_identity_hash(uid)
    when provider_name='phone' then (select account_private.hash_phone(u.phone) from auth.users u
      where u.id=uid and u.phone_confirmed_at is not null and nullif(u.phone,'') is not null
        and nullif(u.email,'') is null and not coalesce(u.is_anonymous,false)
        and not exists(select 1 from auth.identities i where i.user_id=uid and i.provider<>'phone')) end;
$$;
create function account_private.identity_active(b account_private.account_identities) returns boolean
language sql stable security definer set search_path='' as $$
  select b.identity_hash=account_private.identity_hash(b.auth_user_id,b.provider)
    and exists(select 1 from auth.users u where u.id=b.auth_user_id and (u.banned_until is null or u.banned_until<now()))
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=b.auth_user_id)
    -- A banned login method must not be bypassed through its linked method.
    and not exists(select 1 from account_private.account_identities other join auth.users u on u.id=other.auth_user_id
      where other.account_id=b.account_id and u.banned_until>now());
$$;
create function account_private.fresh_identity(provider_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select case when provider_name='phone' then account_private.recent_phone_otp(auth.uid())
    else exists(select 1 from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr')='array'
      then auth.jwt()->'amr' else '[]'::jsonb end) m where m->>'method'='oauth' and
      case when m->>'timestamp' ~ '^[0-9]{1,12}$' then (m->>'timestamp')::numeric else 0 end
        between extract(epoch from now()-interval '10 minutes') and extract(epoch from now()+interval '1 minute')) end;
$$;
create function account_private.device_scope(device_secret text,device_platform text,reinstall_identifier text) returns text
language plpgsql stable security definer set search_path='' as $$
begin
  if device_secret is null or device_secret !~ '^[a-f0-9]{64}$' then raise exception 'invalid_device_secret' using errcode='22023'; end if;
  if device_platform is null or device_platform not in ('android','ios','web')
    or (device_platform='web' and reinstall_identifier is not null)
    or (device_platform<>'web' and (reinstall_identifier is null or reinstall_identifier !~ '^[a-f0-9]{64}$')) then
    raise exception 'invalid_reinstall_identity' using errcode='22023'; end if;
  return case when device_platform='web' then encode(extensions.digest(device_secret,'sha256'),'hex')
    else account_private.hash_phone('reinstall-v1:'||device_platform||':'||reinstall_identifier) end;
end $$;

create or replace function public.current_account_id() returns uuid
language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.admin_users a where a.user_id=auth.uid() and a.is_active
    and auth.jwt()->'amr' @> '[{"method":"password"}]'::jsonb) then auth.uid()
  else (select g.account_id from account_private.sessions g
    join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
    join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
    where g.user_id=auth.uid() and g.session_id::text=auth.jwt()->>'session_id'
      and g.expires_at>now() and account_private.identity_active(b)) end;
$$;

-- Serialize enrollment/link/deletion/reward mutations in a single short DB
-- transaction. In particular, two providers cannot race to create two wallets.
create function account_private.authorize_identity(device_secret text,device_platform text,reinstall_identifier text,provider_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; dh text; scope text; aid uuid; recovered_id uuid; previous_id uuid;
  a account_private.device_accounts; created boolean:=false; restored boolean:=false; attempts integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  perform 1 from auth.users u join auth.sessions s on s.user_id=u.id
    where u.id=uid and s.id=sid and (u.banned_until is null or u.banned_until<now()) for update of u;
  ih:=account_private.identity_hash(uid,provider_name);
  if not found or ih is null or (provider_name='google' and not coalesce(auth.jwt()->'amr' @> '[{"method":"oauth"}]'::jsonb,false)) then
    raise exception 'verified_%_required',provider_name using errcode='42501'; end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then return jsonb_build_object('error','account_deletion_pending'); end if;
  select d.* into a from account_private.device_accounts d join account_private.account_identities b on b.account_id=d.id
    where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and d.device_hash=dh;
  aid:=a.id;
  if device_platform<>'web' then
    select d.id into recovered_id from account_private.device_accounts d join account_private.account_identities b on b.account_id=d.id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and d.device_scope_hash=scope;
  end if;
  select account_id into previous_id from account_private.sessions where session_id=sid;
  if previous_id is not null and previous_id is distinct from coalesce(aid,recovered_id) then return jsonb_build_object('error','reauthenticate_required'); end if;
  if aid is not null and ((a.reinstall_hash is not null and (device_platform='web' or a.device_scope_hash<>scope))
    or (recovered_id is not null and recovered_id<>aid)) then return jsonb_build_object('error','device_binding_mismatch'); end if;
  if aid is null or (device_platform<>'web' and a.reinstall_hash is null) then
    if not account_private.fresh_identity(provider_name) then return jsonb_build_object('error','fresh_'||provider_name||'_verification_required'); end if;
    if aid is null then
      insert into account_private.reinstall_attempts(auth_user_id,attempts) values(uid,1)
      on conflict(auth_user_id) do update set
        attempts=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour' then 1 else account_private.reinstall_attempts.attempts+1 end,
        window_started=case when account_private.reinstall_attempts.window_started<=now()-interval '1 hour' then now() else account_private.reinstall_attempts.window_started end
      returning account_private.reinstall_attempts.attempts into attempts;
      if attempts>10 then return jsonb_build_object('error','recovery_rate_limited'); end if;
      if recovered_id is not null then
        update account_private.device_accounts set device_hash=dh where id=recovered_id;
        delete from account_private.sessions where account_id=recovered_id and session_id<>sid;
        aid:=recovered_id; restored:=true;
      end if;
    end if;
  end if;
  if aid is null then
    if exists(select 1 from account_private.device_accounts where device_scope_hash=scope or device_hash=dh) then
      return jsonb_build_object('error','account_link_required'); end if;
    if exists(select 1 from account_private.device_enrollment_history where scope_hash=scope and blocked_until>now()) then
      return jsonb_build_object('error','device_enrollment_cooldown'); end if;
    if (select count(*) from account_private.device_registrations where phone_hash=ih and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited'); end if;
    insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
      values(uid,ih,dh,provider_name,scope) returning id into aid;
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(aid,uid,provider_name,ih);
    insert into account_private.device_registrations(phone_hash) values(ih);
    created:=true;
  end if;
  if not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.auth_user_id=uid and account_private.identity_active(b)) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  -- A key-only legacy account may upgrade, but must not occupy another account's native scope.
  if device_platform<>'web' and exists(select 1 from account_private.device_accounts where device_scope_hash=scope and id<>aid)
    and not exists(select 1 from account_private.device_accounts where id=aid and device_scope_hash=scope) then
    return jsonb_build_object('error','account_link_required'); end if;
  insert into account_private.device_enrollment_history(scope_hash,welcome_used)
    select scope,coalesce((select welcome_used from account_private.device_enrollment_history where scope_hash=dh),false)
    on conflict(scope_hash) do update set retain_until=now()+interval '1 year';
  update account_private.device_accounts set device_scope_hash=scope,
    reinstall_platform=case when device_platform='web' then null else device_platform end,
    reinstall_hash=case when device_platform='web' then null else scope end where id=aid;
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year' where phone_hash=ih;
  insert into account_private.sessions(session_id,user_id,account_id,expires_at) values(sid,uid,aid,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'account_id',aid,'created',created,'restored',restored);
end $$;
create or replace function public.authorize_device_account(device_secret text) returns jsonb
language sql security definer set search_path='' as $$ select account_private.authorize_identity(device_secret,'web',null,'phone'); $$;
create or replace function public.authorize_device_account_v2(device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language sql security definer set search_path='' as $$ select account_private.authorize_identity(device_secret,device_platform,reinstall_identifier,'phone'); $$;
create or replace function public.authorize_google_device_account(device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language sql security definer set search_path='' as $$ select account_private.authorize_identity(device_secret,device_platform,reinstall_identifier,'google'); $$;

create function public.account_login_methods() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('account_id',public.current_account_id(),'providers',coalesce(jsonb_agg(provider order by provider),'[]'::jsonb))
    from account_private.account_identities where account_id=public.current_account_id();
$$;
create function public.begin_account_link(device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; source account_private.account_identities; secret text; dh text; scope text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  aid:=public.current_account_id();
  if aid is null then return jsonb_build_object('error','account_link_unavailable'); end if;
  select * into source from account_private.account_identities where account_id=aid and auth_user_id=auth.uid();
  if not account_private.fresh_identity(source.provider) then return jsonb_build_object('error','link_reauthentication_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if not exists(select 1 from account_private.device_accounts where id=aid and device_hash=dh and device_scope_hash=scope)
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  if (select count(*) from account_private.account_identities where account_id=aid)>=2 then return jsonb_build_object('error','account_already_linked'); end if;
  if (select count(*) from account_private.account_link_requests where account_id=aid and created_at>now()-interval '1 hour')>=10 then
    return jsonb_build_object('error','link_rate_limited'); end if;
  update account_private.account_link_requests set used_at=now() where account_id=aid and used_at is null;
  secret:=encode(extensions.gen_random_bytes(32),'hex');
  insert into account_private.account_link_requests(token_hash,account_id,source_user,source_session,source_provider,device_hash,scope_hash)
    values(encode(extensions.digest(secret,'sha256'),'hex'),aid,auth.uid(),(auth.jwt()->>'session_id')::uuid,source.provider,dh,scope);
  return jsonb_build_object('ok',true,'ticket',secret,'account_id',aid,'provider',case when source.provider='phone' then 'google' else 'phone' end);
end $$;

create function public.finish_account_link(link_ticket text,device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r account_private.account_link_requests; uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; provider_name text; scope text; dh text; previous_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  if link_ticket is null or link_ticket !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error','invalid_link_ticket'); end if;
  select * into r from account_private.account_link_requests where token_hash=encode(extensions.digest(link_ticket,'sha256'),'hex');
  if r.account_id is null or r.used_at is not null or r.expires_at<=now() then return jsonb_build_object('error','invalid_link_ticket'); end if;
  provider_name:=case when r.source_provider='phone' then 'google' else 'phone' end;
  ih:=account_private.identity_hash(uid,provider_name);
  if ih is null or not account_private.fresh_identity(provider_name)
    or not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id where s.id=sid and s.user_id=uid and (u.banned_until is null or u.banned_until<now()))
    or exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then return jsonb_build_object('error','link_verification_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if dh<>r.device_hash or scope<>r.scope_hash or not exists(select 1 from account_private.device_accounts
    where id=r.account_id and device_hash=dh and device_scope_hash=scope)
    or not exists(select 1 from account_private.sessions g join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
      join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
      where g.account_id=r.account_id and g.user_id=r.source_user and g.session_id=r.source_session and g.expires_at>now() and account_private.identity_active(b))
    or exists(select 1 from public.profiles where id=r.account_id and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  -- An established target identity is never merged, emptied, or reassigned.
  if exists(select 1 from account_private.account_identities where (auth_user_id=uid or (provider=provider_name and identity_hash=ih)) and account_id<>r.account_id)
    or exists(select 1 from account_private.account_identities where account_id=r.account_id and provider=provider_name) then
    return jsonb_build_object('error','account_link_conflict'); end if;
  select account_id into previous_id from account_private.sessions where session_id=sid;
  if previous_id is not null and previous_id<>r.account_id then return jsonb_build_object('error','account_link_conflict'); end if;
  insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(r.account_id,uid,provider_name,ih);
  -- Linking does not award points; it also consumes the new method's signup bonus.
  insert into account_private.phone_welcome_grants(phone_hash) values(ih) on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
  insert into account_private.sessions(session_id,user_id,account_id,expires_at) values(sid,uid,r.account_id,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
  return jsonb_build_object('ok',true,'account_id',r.account_id);
end $$;

create or replace function public.claim_account_welcome_points() returns bigint
language plpgsql security definer set search_path='' as $$
declare aid uuid; scope text; eligible boolean; points bigint;
begin
  perform public.require_account_access();
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  aid:=public.current_account_id();
  select device_scope_hash into scope from account_private.device_accounts where id=aid;
  if scope is null then raise exception 'device_account_required'; end if;
  update public.profiles set welcome_points_claimed=true where id=aid and not welcome_points_claimed;
  if found then
    eligible:=not exists(select 1 from account_private.phone_welcome_grants g join account_private.account_identities b on b.identity_hash=g.phone_hash where b.account_id=aid)
      and not exists(select 1 from account_private.device_enrollment_history where scope_hash=scope and welcome_used);
    insert into account_private.phone_welcome_grants(phone_hash) select identity_hash from account_private.account_identities where account_id=aid
      on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
    insert into account_private.device_enrollment_history(scope_hash,welcome_used) values(scope,true)
      on conflict(scope_hash) do update set welcome_used=true,retain_until=now()+interval '1 year';
    if eligible then
      update public.point_wallets set balance=balance+100,updated_at=now() where user_id=aid;
      if not found then raise exception 'wallet_missing'; end if;
      insert into public.point_transactions(user_id,amount,reason) values(aid,100,'welcome_account');
    end if;
  end if;
  select balance into points from public.point_wallets where user_id=aid;
  return points;
end $$;

create or replace function public.active_account_push_tokens(target_user uuid) returns table(token text,platform text)
language sql stable security definer set search_path='' as $$
  select p.token,p.platform from public.push_tokens p
  join account_private.sessions g on g.session_id=p.auth_session_id and g.account_id=p.user_id and g.expires_at>now()
  join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
  join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
  where p.user_id=target_user and account_private.identity_active(b);
$$;
create or replace function account_private.protect_phone_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from account_private.account_identities where auth_user_id=old.id) then return new; end if;
  if new.phone is distinct from old.phone or new.encrypted_password is distinct from old.encrypted_password
    or (new.phone_change is distinct from old.phone_change and nullif(new.phone_change,'') is not null)
    or (new.email is distinct from old.email and exists(select 1 from account_private.account_identities where auth_user_id=old.id and provider='phone')) then
    raise exception 'phone_identity_change_not_supported'; end if;
  return new;
end $$;

create or replace function public.delete_device_account_data(target_account uuid,identity_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; candidates uuid[]; removable uuid[]; scope text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  if not exists(select 1 from account_private.account_identities where account_id=target_account and auth_user_id=identity_user) then raise exception 'account_identity_mismatch'; end if;
  select array_agg(auth_user_id order by auth_user_id) into candidates from account_private.account_identities where account_id=target_account;
  perform 1 from auth.users where id=any(candidates) order by id for update;
  select device_scope_hash into scope from account_private.device_accounts where id=target_account;
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year'
    where phone_hash in (select identity_hash from account_private.account_identities where account_id=target_account);
  insert into account_private.device_enrollment_history(scope_hash,blocked_until) values(scope,now()+interval '7 days')
    on conflict(scope_hash) do update set blocked_until=now()+interval '7 days',retain_until=now()+interval '1 year';
  result:=public.delete_account_data(target_account);
  delete from account_private.device_accounts where id=target_account;
  select coalesce(array_agg(u),'{}'::uuid[]) into removable from unnest(candidates) u
    where not exists(select 1 from account_private.account_identities where auth_user_id=u)
      and not exists(select 1 from account_private.device_accounts where auth_user_id=u);
  insert into account_private.identity_deletions(auth_user_id) select unnest(removable) on conflict do nothing;
  insert into account_private.identity_deletion_jobs(account_id,caller_id,identity_ids) values(target_account,identity_user,removable);
  return result||jsonb_build_object('delete_auth_identity',identity_user=any(removable),'delete_auth_identities',to_jsonb(removable));
end $$;
create function public.pending_account_identity_deletions(identity_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('pending',exists(select 1 from account_private.identity_deletion_jobs where caller_id=identity_user)
      or exists(select 1 from account_private.identity_deletions where auth_user_id=identity_user),
    'identities',coalesce(jsonb_agg(distinct d.auth_user_id),'[]'::jsonb)) from account_private.identity_deletions d
    where d.auth_user_id=identity_user or exists(select 1 from account_private.identity_deletion_jobs j
      where j.caller_id=identity_user and d.auth_user_id=any(j.identity_ids));
$$;

create or replace function public.run_retention_cleanup(batch_limit integer default 5000) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=account_private.base_retention_cleanup(batch_limit);
  delete from account_private.device_registrations where created_at<=now()-interval '24 hours';
  delete from account_private.phone_welcome_grants g where g.retain_until<=now()
    and not exists(select 1 from account_private.account_identities b where b.identity_hash=g.phone_hash);
  delete from account_private.reinstall_attempts where window_started<=now()-interval '1 hour';
  delete from account_private.account_link_requests where expires_at<=now()-interval '1 day';
  delete from account_private.identity_deletion_jobs j where created_at<=now()-interval '30 days'
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=any(j.identity_ids));
  delete from account_private.device_enrollment_history h where retain_until<=now()
    and not exists(select 1 from account_private.device_accounts a where a.device_scope_hash=h.scope_hash);
  return result;
end $$;
create or replace function public.check_account_request() returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if current_setting('request.path',true)=any(array['/rpc/current_account_id','/rpc/authorize_device_account',
    '/rpc/authorize_device_account_v2','/rpc/authorize_google_device_account','/rpc/finish_account_link',
    '/rpc/account_access_allowed','/rpc/lock_account_session']) then return; end if;
  perform public.require_account_access();
end $$;
revoke all on all functions in schema account_private from public,anon,authenticated;
revoke all on function public.account_login_methods(),public.begin_account_link(text,text,text),public.finish_account_link(text,text,text,text) from public,anon;
grant execute on function public.account_login_methods(),public.begin_account_link(text,text,text),public.finish_account_link(text,text,text,text) to authenticated,service_role;
revoke all on function public.pending_account_identity_deletions(uuid) from public,anon,authenticated;
grant execute on function public.pending_account_identity_deletions(uuid) to service_role;
notify pgrst,'reload schema';

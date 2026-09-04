-- The app account owns data. Device bindings only authorize sessions; Google
-- subjects can recover that same account on another device without moving data.
create table account_private.account_devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account_private.device_accounts(id) on delete cascade,
  device_hash text not null,
  device_scope_hash text not null,
  platform text not null check(platform in ('web','android','ios')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique(account_id,device_hash), unique(account_id,device_scope_hash)
);
create unique index account_devices_primary on account_private.account_devices(account_id) where is_primary;
create index account_devices_key on account_private.account_devices(device_hash);
create index account_devices_scope on account_private.account_devices(device_scope_hash);
revoke all on account_private.account_devices from public,anon,authenticated;
insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
  select id,device_hash,device_scope_hash,coalesce(reinstall_platform,'web'),true
  from account_private.device_accounts where device_hash is not null;
alter table account_private.sessions add column device_id uuid references account_private.account_devices(id) on delete cascade;
update account_private.sessions s set device_id=d.id from account_private.account_devices d where d.account_id=s.account_id and d.is_primary;
create index account_sessions_device on account_private.sessions(device_id);

create or replace function account_private.authorize_identity(device_secret text,device_platform text,reinstall_identifier text,provider_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; dh text; scope text; aid uuid; recovered_id uuid; previous_id uuid; previous_device uuid;
  d account_private.account_devices; created boolean:=false; restored boolean:=false; attempts integer; matches integer;
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
  select v.* into d from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
    where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_hash=dh;
  if device_platform<>'web' then
    select v.id into recovered_id from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_scope_hash=scope;
  end if;
  if d.id is not null and ((d.platform<>'web' and (device_platform<>d.platform or d.device_scope_hash<>scope))
    or (recovered_id is not null and recovered_id<>d.id)) then return jsonb_build_object('error','device_binding_mismatch'); end if;
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
  -- Do not guess which historical wallet to select if a Google identity already
  -- has multiple legacy accounts. Known devices continue using their own account.
  if aid is null and provider_name='google' then
    select count(*),(array_agg(account_id))[1] into matches,aid from account_private.account_identities
      where provider='google' and auth_user_id=uid and identity_hash=ih;
    if matches>1 then return jsonb_build_object('error','account_resolution_required'); end if;
    restored:=aid is not null;
  end if;
  select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
  if previous_id is not null and (previous_id is distinct from aid or previous_device is distinct from d.id) then
    return jsonb_build_object('error','reauthenticate_required'); end if;
  -- Reject occupying another account or collapsing two device bindings with a key.
  if exists(select 1 from account_private.account_devices v where (v.device_scope_hash=scope or v.device_hash=dh) and v.id is distinct from d.id) then
    return jsonb_build_object('error','account_link_required'); end if;
  if aid is not null and (not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.auth_user_id=uid and account_private.identity_active(b))
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now()))) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  if d.id is null then
    if exists(select 1 from account_private.device_enrollment_history where scope_hash=scope and blocked_until>now()) then
      return jsonb_build_object('error','device_enrollment_cooldown'); end if;
    if (select count(*) from account_private.device_registrations where phone_hash=ih and created_at>now()-interval '24 hours')>=3 then
      return jsonb_build_object('error','device_creation_rate_limited'); end if;
    if aid is null then
      insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
        values(uid,ih,dh,provider_name,scope) returning id into aid;
      insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(aid,uid,provider_name,ih);
      created:=true;
    end if;
    insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
      values(aid,dh,scope,device_platform,created) returning * into d;
    insert into account_private.device_registrations(phone_hash) values(ih);
  end if;
  if d.device_hash<>dh then
    -- Reinstall revokes this device's old grants, never another phone's grants.
    delete from account_private.sessions where device_id=d.id and session_id<>sid;
  end if;
  insert into account_private.device_enrollment_history(scope_hash,welcome_used)
    select scope,coalesce((select welcome_used from account_private.device_enrollment_history where scope_hash=dh),false)
      or coalesce((select welcome_points_claimed from public.profiles where id=aid),false)
    on conflict(scope_hash) do update set welcome_used=account_private.device_enrollment_history.welcome_used or excluded.welcome_used,
      retain_until=now()+interval '1 year';
  update account_private.account_devices set device_hash=dh,device_scope_hash=scope,platform=device_platform where id=d.id;
  -- Preserve legacy home-device metadata for older administrative tooling.
  if d.is_primary then
    update account_private.device_accounts set device_hash=dh,device_scope_hash=scope,
      reinstall_platform=case when device_platform='web' then null else device_platform end,
      reinstall_hash=case when device_platform='web' then null else scope end where id=aid;
  end if;
  update account_private.phone_welcome_grants set retain_until=now()+interval '1 year' where phone_hash=ih;
  insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at) values(sid,uid,aid,d.id,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'account_id',aid,'created',created,'restored',restored);
end $$;

create or replace function public.current_account_id() returns uuid
language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.admin_users a where a.user_id=auth.uid() and a.is_active
    and auth.jwt()->'amr' @> '[{"method":"password"}]'::jsonb) then auth.uid()
  else (select g.account_id from account_private.sessions g
    join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
    join account_private.account_devices v on v.id=g.device_id and v.account_id=g.account_id
    join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
    where g.user_id=auth.uid() and g.session_id::text=auth.jwt()->>'session_id'
      and g.expires_at>now() and account_private.identity_active(b)) end;
$$;

create or replace function public.active_account_push_tokens(target_user uuid) returns table(token text,platform text)
language sql stable security definer set search_path='' as $$
  select p.token,p.platform from public.push_tokens p
  join account_private.sessions g on g.session_id=p.auth_session_id and g.account_id=p.user_id and g.expires_at>now()
  join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
    join account_private.account_devices v on v.id=g.device_id and v.account_id=g.account_id
  join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
  where p.user_id=target_user and account_private.identity_active(b);
$$;

create or replace function public.begin_account_link_v2(device_secret text,device_platform text,reinstall_identifier text,target_provider text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; source account_private.account_identities; secret text; dh text; scope text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  aid:=public.current_account_id();
  if aid is null then return jsonb_build_object('error','account_link_unavailable'); end if;
  select * into source from account_private.account_identities where account_id=aid and auth_user_id=auth.uid();
  if target_provider is null or target_provider not in ('phone','google','kakao') then return jsonb_build_object('error','invalid_link_provider'); end if;
  if not account_private.fresh_identity(source.provider) then return jsonb_build_object('error','link_reauthentication_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  if not exists(select 1 from account_private.account_devices v join account_private.sessions g on g.device_id=v.id
    where v.account_id=aid and v.device_hash=dh and v.device_scope_hash=scope and g.session_id::text=auth.jwt()->>'session_id')
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  if exists(select 1 from account_private.account_identities b where b.account_id=aid and b.provider=target_provider) then
    return jsonb_build_object('error','account_already_linked'); end if;
  if (select count(*) from account_private.account_link_requests where account_id=aid and created_at>now()-interval '1 hour')>=10 then
    return jsonb_build_object('error','link_rate_limited'); end if;
  update account_private.account_link_requests set used_at=now() where account_id=aid and used_at is null;
  secret:=encode(extensions.gen_random_bytes(32),'hex');
  insert into account_private.account_link_requests(token_hash,account_id,source_user,source_session,source_provider,target_provider,device_hash,scope_hash)
    values(encode(extensions.digest(secret,'sha256'),'hex'),aid,auth.uid(),(auth.jwt()->>'session_id')::uuid,source.provider,target_provider,dh,scope);
  return jsonb_build_object('ok',true,'ticket',secret,'account_id',aid,'provider',target_provider);
end $$;

create or replace function public.finish_account_link(link_ticket text,device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r account_private.account_link_requests; uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; provider_name text; scope text; dh text; previous_id uuid; binding_id uuid; previous_device uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  if link_ticket is null or link_ticket !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error','invalid_link_ticket'); end if;
  select * into r from account_private.account_link_requests where token_hash=encode(extensions.digest(link_ticket,'sha256'),'hex');
  if r.account_id is null or r.used_at is not null or r.expires_at<=now() then return jsonb_build_object('error','invalid_link_ticket'); end if;
  provider_name:=r.target_provider;
  ih:=account_private.identity_hash(uid,provider_name);
  if ih is null or not account_private.fresh_identity(provider_name)
    or not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id where s.id=sid and s.user_id=uid and (u.banned_until is null or u.banned_until<now()))
    or exists(select 1 from account_private.identity_deletions where auth_user_id=uid) then return jsonb_build_object('error','link_verification_required'); end if;
  scope:=account_private.device_scope(device_secret,device_platform,reinstall_identifier);
  dh:=encode(extensions.digest(device_secret,'sha256'),'hex');
  select id into binding_id from account_private.account_devices where account_id=r.account_id and device_hash=dh and device_scope_hash=scope;
  if dh<>r.device_hash or scope<>r.scope_hash or binding_id is null
    or not exists(select 1 from account_private.sessions g join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
      join account_private.account_identities b on b.account_id=g.account_id and b.auth_user_id=g.user_id
      where g.device_id=binding_id and g.account_id=r.account_id and g.user_id=r.source_user and g.session_id=r.source_session and g.expires_at>now() and account_private.identity_active(b))
    or exists(select 1 from public.profiles where id=r.account_id and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  -- An established target identity is never merged, emptied, or reassigned.
  if exists(select 1 from account_private.account_identities where (auth_user_id=uid or (provider=provider_name and identity_hash=ih)) and account_id<>r.account_id)
    or exists(select 1 from account_private.account_identities where account_id=r.account_id and provider=provider_name) then
    return jsonb_build_object('error','account_link_conflict'); end if;
  select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
  if previous_id is not null and (previous_id<>r.account_id or previous_device is distinct from binding_id) then return jsonb_build_object('error','account_link_conflict'); end if;
  insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(r.account_id,uid,provider_name,ih);
  -- Linking does not award points; it also consumes the new method's signup bonus.
  insert into account_private.phone_welcome_grants(phone_hash) values(ih) on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
  insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at) values(sid,uid,r.account_id,binding_id,now()+interval '30 days')
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
      and not exists(select 1 from account_private.device_enrollment_history h join account_private.account_devices v on v.device_scope_hash=h.scope_hash where v.account_id=aid and h.welcome_used);
    insert into account_private.phone_welcome_grants(phone_hash) select identity_hash from account_private.account_identities where account_id=aid
      on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
    insert into account_private.device_enrollment_history(scope_hash,welcome_used) select device_scope_hash,true from account_private.account_devices where account_id=aid
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
  insert into account_private.device_enrollment_history(scope_hash,blocked_until) select device_scope_hash,now()+interval '7 days' from account_private.account_devices where account_id=target_account
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
    and not exists(select 1 from account_private.account_devices a where a.device_scope_hash=h.scope_hash);
  return result;
end $$;

revoke all on all functions in schema account_private from public,anon,authenticated;
notify pgrst,'reload schema';

-- If a reinstall creates a pre-profile phone shell, a fresh Google/Kakao
-- verification may recover the already-linked account and attach that phone.
-- Established accounts are still never merged.
create or replace function public.finish_account_link(link_ticket text,device_secret text,device_platform text,reinstall_identifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r account_private.account_link_requests; uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; provider_name text; scope text; dh text; previous_id uuid; binding_id uuid; previous_device uuid;
  other_id uuid; identity_count integer; device_count integer; recovery_device uuid; source_shell boolean:=false;
  source_identity account_private.account_identities;
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
  if exists(select 1 from account_private.account_identities where account_id=r.account_id and provider=provider_name) then
    return jsonb_build_object('error','account_link_conflict'); end if;
  select count(*),(array_agg(account_id))[1] into identity_count,other_id
    from account_private.account_identities
    where (auth_user_id=uid or (provider=provider_name and identity_hash=ih)) and account_id<>r.account_id;
  if identity_count>1 then return jsonb_build_object('error','account_link_conflict'); end if;

  -- Reverse recovery: the current account is a disposable phone-only shell and
  -- the freshly verified social identity already belongs to the old account.
  if other_id is not null and provider_name in ('google','kakao') then
    perform 1 from account_private.device_accounts where id in (r.account_id,other_id) order by id for update;
    select * into source_identity from account_private.account_identities
      where account_id=r.account_id and auth_user_id=r.source_user;
    select count(*) into device_count from account_private.account_devices where account_id=r.account_id;
    select id into recovery_device from account_private.account_devices
      where account_id=other_id and device_scope_hash=scope;
    source_shell:=source_identity.provider='phone'
      and account_private.identity_active(source_identity)
      and not exists(select 1 from account_private.identity_deletions where auth_user_id=r.source_user)
      and not exists(select 1 from public.profiles where id=r.account_id)
      and not exists(select 1 from public.point_wallets where user_id=r.account_id)
      and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
      and device_count=1
      and exists(select 1 from account_private.account_devices where id=binding_id and account_id=r.account_id);
    if source_shell then
      if recovery_device is null
        or exists(select 1 from account_private.account_devices where account_id=other_id and device_hash=dh and id<>recovery_device)
        or exists(select 1 from account_private.account_identities where account_id=other_id and provider='phone')
        or not exists(select 1 from account_private.account_identities b where b.account_id=other_id
          and b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and account_private.identity_active(b))
        or exists(select 1 from public.profiles where id=other_id and status::text='suspended' and (suspended_until is null or suspended_until>now())) then
        return jsonb_build_object('error','account_link_conflict'); end if;

    -- Move only the freshly verified phone login method. Deleting the empty
    -- shell cannot delete profile, points, chat or purchase data because the
    -- checks above and the account row locks exclude all such app data.
      update account_private.account_identities set account_id=other_id
        where account_id=r.account_id and auth_user_id=r.source_user and provider='phone';
      delete from account_private.sessions where device_id=recovery_device
        and session_id<>r.source_session and session_id<>sid;
      update account_private.account_devices set device_hash=dh,device_scope_hash=scope,platform=device_platform
        where id=recovery_device;
      if exists(select 1 from account_private.account_devices where id=recovery_device and is_primary) then
        update account_private.device_accounts set device_hash=dh,device_scope_hash=scope,
          reinstall_platform=case when device_platform='web' then null else device_platform end,
          reinstall_hash=case when device_platform='web' then null else scope end where id=other_id;
      end if;
      delete from account_private.device_accounts where id=r.account_id;
      insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
        values(r.source_session,r.source_user,other_id,recovery_device,now()+interval '30 days')
        on conflict(session_id) do update set user_id=excluded.user_id,account_id=excluded.account_id,
          device_id=excluded.device_id,expires_at=excluded.expires_at;
      insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
        values(sid,uid,other_id,recovery_device,now()+interval '30 days')
        on conflict(session_id) do update set user_id=excluded.user_id,account_id=excluded.account_id,
          device_id=excluded.device_id,expires_at=excluded.expires_at;
      insert into account_private.phone_welcome_grants(phone_hash) values(source_identity.identity_hash)
        on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
      return jsonb_build_object('ok',true,'account_id',other_id,'previous_account_id',r.account_id,
        'recovered_existing_account',true);
    end if;
  end if;

  -- Existing safe direction: the additional identity may have created its own
  -- empty shell on this device before the link was completed.
  if other_id is not null then
    perform 1 from account_private.device_accounts where id=other_id for update;
    select count(*) into device_count from account_private.account_devices where account_id=other_id;
    if exists(select 1 from public.profiles where id=other_id)
      or exists(select 1 from public.point_wallets where user_id=other_id)
      or (select count(*) from account_private.account_identities where account_id=other_id)<>1
      or device_count<>1
      or not exists(select 1 from account_private.account_devices where account_id=other_id
        and device_hash=dh and device_scope_hash=scope)
      or exists(select 1 from account_private.account_identities where account_id=other_id and not account_private.identity_active(account_identities)) then
      return jsonb_build_object('error','account_link_conflict'); end if;
  end if;
  select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
  if previous_id is not null and previous_id is distinct from other_id
    and (previous_id<>r.account_id or previous_device is distinct from binding_id) then return jsonb_build_object('error','account_link_conflict'); end if;
  if other_id is not null then delete from account_private.device_accounts where id=other_id; end if;
  insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(r.account_id,uid,provider_name,ih);
  insert into account_private.phone_welcome_grants(phone_hash) values(ih) on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
  insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at) values(sid,uid,r.account_id,binding_id,now()+interval '30 days')
    on conflict(session_id) do update set expires_at=excluded.expires_at;
  update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
  return jsonb_build_object('ok',true,'account_id',r.account_id,'recovered_existing_account',false);
end $$;

revoke all on function public.finish_account_link(text,text,text,text) from public,anon;
grant execute on function public.finish_account_link(text,text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';

begin;
create table account_private.phone_reassignment_archives (
 id uuid primary key default gen_random_uuid(), account_id uuid not null unique,
 former_auth_user_id uuid not null, phone_identity_hash text not null check(phone_identity_hash~'^[a-f0-9]{64}$'),
 recovery_disposition text not null, snapshot jsonb not null,
 archived_at timestamptz not null default now(), retain_until timestamptz not null default(now()+interval '7 years'));
comment on table account_private.phone_reassignment_archives is 'Server-only snapshots of phone-only accounts retired after verified number reassignment.';
revoke all on account_private.phone_reassignment_archives from public,anon,authenticated;
grant select on account_private.phone_reassignment_archives to service_role;
create or replace function account_private.archive_reassigned_phone_account(target_account uuid,former_auth_user uuid,expected_phone_hash text)
returns void language plpgsql security definer set search_path='' as $$
declare payload jsonb;
begin
 if current_user not in('postgres','supabase_admin','service_role') then raise exception 'service_role_required'; end if;
 if target_account is null or former_auth_user is null or expected_phone_hash is null then raise exception 'phone_reassignment_archive_arguments_required'; end if;
 if exists(select 1 from account_private.account_identities where account_id=target_account and provider in('google','kakao')) then raise exception 'social_account_must_not_be_archived'; end if;
 if not exists(select 1 from account_private.account_identities where account_id=target_account and auth_user_id=former_auth_user and provider='phone' and identity_hash=expected_phone_hash) then raise exception 'phone_reassignment_identity_mismatch'; end if;
 payload:=jsonb_build_object(
  'profile',(select to_jsonb(x) from public.profiles x where id=target_account),
  'point_wallet',(select to_jsonb(x) from public.point_wallets x where user_id=target_account),
  'point_transactions',coalesce((select jsonb_agg(to_jsonb(x)) from public.point_transactions x where user_id=target_account),'[]'),
  'purchase_receipts',coalesce((select jsonb_agg(to_jsonb(x)) from public.point_purchase_receipts x where user_id=target_account),'[]'),
  'point_reward_claims',coalesce((select jsonb_agg(to_jsonb(x)) from public.point_reward_claims x where user_id=target_account),'[]'),
  'conversation_cards',coalesce((select jsonb_agg(to_jsonb(x)) from public.conversation_cards x where author_id=target_account),'[]'),
  'chat_requests',coalesce((select jsonb_agg(to_jsonb(x)) from public.chat_requests x where target_account in(sender_id,receiver_id)),'[]'),
  'messages',coalesce((select jsonb_agg(to_jsonb(x)) from public.messages x where sender_id=target_account),'[]'),
  'message_backups',coalesce((select jsonb_agg(to_jsonb(x)) from public.message_backups x where sender_id=target_account),'[]'),
  'board_posts',coalesce((select jsonb_agg(to_jsonb(x)) from public.board_posts x where author_id=target_account),'[]'),
  'board_comments',coalesce((select jsonb_agg(to_jsonb(x)) from public.board_comments x where author_id=target_account),'[]'),
  'notification_preferences',(select to_jsonb(x) from public.notification_preferences x where user_id=target_account),
  'support_threads',coalesce((select jsonb_agg(to_jsonb(x)) from public.support_threads x where user_id=target_account),'[]'),
  'user_locations',coalesce((select jsonb_agg(to_jsonb(x)) from public.user_locations x where user_id=target_account),'[]'),
  'storage_objects',coalesce((select jsonb_agg(to_jsonb(x)) from storage.objects x where name like target_account::text||'/%'),'[]'));
 insert into account_private.phone_reassignment_archives(account_id,former_auth_user_id,phone_identity_hash,recovery_disposition,snapshot)
 values(target_account,former_auth_user,expected_phone_hash,account_private.phone_recovery_disposition(target_account),payload) on conflict(account_id) do nothing;
end; $$;
revoke all on function account_private.archive_reassigned_phone_account(uuid,uuid,text) from public,anon,authenticated;
grant execute on function account_private.archive_reassigned_phone_account(uuid,uuid,text) to service_role;

CREATE OR REPLACE FUNCTION account_private.authorize_identity(device_secret text, device_platform text, reinstall_identifier text, provider_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid:=auth.uid(); sid uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  ih text; dh text; scope text; aid uuid; recovered_id uuid; previous_id uuid; previous_device uuid;
  d account_private.account_devices; created boolean:=false; restored boolean:=false; attempts integer; matches integer;
  prior_phone_accounts uuid[]; prior_account uuid; social_methods integer;
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
  -- Resolve multiple wallets admitted to the SAME native device before
  -- SELECT INTO picks a row. A key from a different physical device still
  -- reaches the original binding-mismatch checks below.
  if device_platform<>'web' and (select count(distinct v.account_id)
      from account_private.account_devices v
      join account_private.account_identities b on b.account_id=v.account_id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih
        and v.device_scope_hash=scope)>1 then
    return jsonb_build_object('error','account_resolution_required'); end if;
  select v.* into d from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
    where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_hash=dh;
  if device_platform<>'web' then
    select v.id into recovered_id from account_private.account_devices v join account_private.account_identities b on b.account_id=v.account_id
      where b.auth_user_id=uid and b.provider=provider_name and b.identity_hash=ih and v.device_scope_hash=scope;
  end if;
  if d.id is not null and ((d.platform<>'web' and (device_platform<>d.platform or d.device_scope_hash<>scope))
    or (recovered_id is not null and recovered_id<>d.id)) then return jsonb_build_object('error','device_binding_mismatch'); end if;
  -- A phone identity can have independent accounts on different devices. If
  -- later social recovery brings both onto one device, never pick a wallet by
  -- row order. Ask for the linked social method instead.
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
  -- Do not guess which historical wallet to select if a social identity already
  -- has multiple legacy accounts. Known devices continue using their own account.
  if aid is null and provider_name in ('google','kakao') then
    select count(*),(array_agg(account_id))[1] into matches,aid from account_private.account_identities
      where provider=provider_name and auth_user_id=uid and identity_hash=ih;
    if matches>1 then return jsonb_build_object('error','account_resolution_required'); end if;
    restored:=aid is not null;
  end if;
  select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
  if previous_id is not null and (previous_id is distinct from aid or previous_device is distinct from d.id) then
    return jsonb_build_object('error','reauthenticate_required'); end if;
  -- Shared devices are allowed. Only conflicting bindings WITHIN the selected
  -- account are rejected; another account's data is neither selected nor moved.
  if exists(select 1 from account_private.account_devices v where v.account_id=aid
      and (v.device_scope_hash=scope or v.device_hash=dh) and v.id is distinct from d.id) then
    return jsonb_build_object('error','device_binding_mismatch'); end if;
  -- The legacy key-only endpoint cannot downgrade a known native device.
  if device_platform='web' and exists(select 1 from account_private.account_devices
      where device_hash=dh and platform<>'web') then
    return jsonb_build_object('error','device_binding_mismatch'); end if;
  if aid is not null and (not exists(select 1 from account_private.account_identities b where b.account_id=aid and b.auth_user_id=uid and account_private.identity_active(b))
    or exists(select 1 from public.profiles where id=aid and status::text='suspended' and (suspended_until is null or suspended_until>now()))) then
    return jsonb_build_object('error','account_link_unavailable'); end if;
  -- Count new grants, not background refreshes of an already-authorized session.
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
      -- Only a newly issued OTP session on an unknown native device transfers
    -- number ownership. Existing sessions and known-device restores keep their
    -- current behavior.
    if aid is null and provider_name='phone' and device_platform<>'web'
      and exists(select 1 from account_private.account_identities b
        where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih)
      and exists(select 1 from auth.sessions fresh_session where fresh_session.id=sid
        and fresh_session.created_at>(select min(b.linked_at) from account_private.account_identities b
          where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih)) then
      select array_agg(distinct b.account_id order by b.account_id) into prior_phone_accounts
        from account_private.account_identities b
        where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih;
      perform 1 from account_private.device_accounts a where a.id=any(prior_phone_accounts) order by a.id for update;
      -- Validate the complete set before any destructive mutation.
      if exists(select 1 from unnest(prior_phone_accounts) target(account_id)
        where not exists(select 1 from account_private.account_identities b
          where b.account_id=target.account_id and b.auth_user_id=uid
            and b.provider='phone' and b.identity_hash=ih)
          or (select count(*) from account_private.account_identities b where b.account_id=target.account_id)>3) then
        return jsonb_build_object('error','account_resolution_required');
      end if;
      if cardinality(prior_phone_accounts)>1 then return jsonb_build_object('error','account_resolution_required'); end if;
      foreach prior_account in array prior_phone_accounts loop
        select count(*) into social_methods from account_private.account_identities b
          where b.account_id=prior_account and b.provider in ('google','kakao');
        if social_methods=0 then
          -- Preserve A only in the server archive, revoke all app grants, and
          -- remove user-visible rows before issuing B a new phone principal.
          perform account_private.archive_reassigned_phone_account(prior_account,uid,ih);
          delete from account_private.sessions where account_id=prior_account;
          perform public.delete_account_data(prior_account);
          delete from account_private.device_accounts where id=prior_account;
        else
          -- Google/Kakao remain authoritative for A. Revoke only phone-bound
          -- app grants and push tokens; A's social access and data stay intact.
          delete from public.push_tokens p using account_private.sessions old_session
            where p.auth_session_id=old_session.session_id
              and old_session.account_id=prior_account and old_session.user_id=uid;
          delete from account_private.account_link_requests
            where account_id=prior_account and source_user=uid;
          delete from account_private.sessions where account_id=prior_account and user_id=uid;
          delete from account_private.account_identities
            where account_id=prior_account and auth_user_id=uid and provider='phone' and identity_hash=ih;
        end if;
      end loop;
    end if;
      insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
        values(uid,ih,dh,provider_name,scope) returning id into aid;
      insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values(aid,uid,provider_name,ih);
      created:=true;
    end if;
    insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
      values(aid,dh,scope,device_platform,created) returning * into d;
    insert into account_private.device_registrations(phone_hash,scope_hash) values(ih,case when created then scope end);
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
  if previous_id is null then insert into account_private.device_login_events(scope_hash) values(scope); end if;
  return jsonb_build_object('ok',true,'account_id',aid,'created',created,'restored',restored);
end $function$;

revoke all on function account_private.authorize_identity(text,text,text,text) from public,anon,authenticated;
commit;

-- Independent accounts may sign in on one device, but each 50P reward is limited
-- to once per rolling 24 hours for BOTH the account and the authorized device.
-- No account FK: deleting an account must not erase the device's cooldown.
create table account_private.device_reward_claims (
  scope_hash text not null,
  reward_type text not null check (reward_type in ('attendance','talk_write','board_post','board_comment','rewarded_ad')),
  claimed_at timestamptz not null,
  primary key(scope_hash,reward_type)
);
create index device_reward_claims_expiry on account_private.device_reward_claims(claimed_at);

-- Old rewards have no per-action device attribution. Conservatively seed every
-- known device once, without changing balances or extending the original time.
insert into account_private.device_reward_claims(scope_hash,reward_type,claimed_at)
select v.device_scope_hash,c.reward_type,max(c.claimed_at)
from public.point_reward_claims c join account_private.account_devices v on v.account_id=c.user_id
where c.claimed_at>now()-interval '24 hours'
group by v.device_scope_hash,c.reward_type;

-- A signed SSV callback carries only this opaque ticket, never a device hash.
-- It remains tied to the original account/device even after logout or switching.
create table account_private.rewarded_ad_claims (
  token uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.profiles(id) on delete cascade,
  scope_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '24 hours',
  processed_at timestamptz,
  awarded boolean not null default false
);
create index rewarded_ad_claims_account on account_private.rewarded_ad_claims(account_id,scope_hash,created_at desc);
create index rewarded_ad_claims_expiry on account_private.rewarded_ad_claims(expires_at);
revoke all on account_private.device_reward_claims,account_private.rewarded_ad_claims from public,anon,authenticated;

create function account_private.current_reward_scope() returns text
language plpgsql stable security definer set search_path='' as $$
declare aid uuid:=public.current_account_id(); scope text;
begin
  select v.device_scope_hash into scope from account_private.sessions g
  join account_private.account_devices v on v.id=g.device_id and v.account_id=g.account_id
  where g.account_id=aid and g.user_id=auth.uid()
    and g.session_id::text=auth.jwt()->>'session_id' and g.expires_at>now();
  if scope is null then raise exception 'authorized_device_required' using errcode='42501'; end if;
  return scope;
end $$;

create function account_private.last_activity_reward(aid uuid,reward_key text,scopes text[]) returns timestamptz
language sql stable security definer set search_path='' as $$
  select max(claimed_at) from (
    select claimed_at from public.point_reward_claims where user_id=aid and reward_type=reward_key
    union all
    select claimed_at from account_private.device_reward_claims where scope_hash=any(scopes) and reward_type=reward_key
  ) c;
$$;

-- All public award paths share this atomic gate. Sorted scope locks serialize
-- distinct accounts on one device; the account lock also covers multiple devices.
create function account_private.credit_activity_reward(aid uuid,reward_key text,scopes text[],reward_reference uuid default null)
returns table(awarded boolean,balance bigint,next_available_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare last_claim timestamptz; scope text; did_award boolean:=false; points bigint;
begin
  if reward_key is null or reward_key not in ('attendance','talk_write','board_post','board_comment','rewarded_ad') then
    raise exception 'invalid_reward_type';
  end if;
  if coalesce(cardinality(scopes),0)=0 or array_position(scopes,null) is not null then
    raise exception 'authorized_device_required';
  end if;
  if not exists(select 1 from public.profiles where id=aid and status='active') then raise exception 'active_profile_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':'||reward_key,0));
  for scope in select distinct s from unnest(scopes) s order by s loop
    perform pg_advisory_xact_lock(hashtextextended('activity-device:'||scope||':'||reward_key,0));
  end loop;
  last_claim:=account_private.last_activity_reward(aid,reward_key,scopes);
  if last_claim is null or last_claim<=now()-interval '24 hours' then
    insert into public.point_reward_claims(user_id,reward_type,claimed_at) values(aid,reward_key,now())
      on conflict(user_id,reward_type) do update set claimed_at=excluded.claimed_at;
    insert into account_private.device_reward_claims(scope_hash,reward_type,claimed_at)
      select distinct s,reward_key,now() from unnest(scopes) s
      on conflict(scope_hash,reward_type) do update set claimed_at=excluded.claimed_at;
    update public.point_wallets set balance=point_wallets.balance+50,updated_at=now() where user_id=aid returning point_wallets.balance into points;
    if not found then raise exception 'point_wallet_not_found'; end if;
    insert into public.point_transactions(user_id,amount,reason,reference_id) values(aid,50,'reward_'||reward_key,reward_reference);
    last_claim:=now(); did_award:=true;
  else
    select w.balance into points from public.point_wallets w where w.user_id=aid;
  end if;
  return query select did_award,coalesce(points,0),last_claim+interval '24 hours';
end $$;

create or replace function public.award_daily_action(reward_key text,reward_reference uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare result boolean;
begin
  perform public.require_account_access();
  if reward_key is null or reward_key not in ('talk_write','board_post','board_comment') then raise exception 'invalid_reward_type'; end if;
  select r.awarded into result from account_private.credit_activity_reward(public.current_account_id(),reward_key,array[account_private.current_reward_scope()],reward_reference) r;
  return result;
end $$;
revoke all on function public.award_daily_action(text,uuid) from public,anon,authenticated;

create or replace function public.claim_attendance_reward()
returns table(awarded boolean,balance bigint,next_available_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
  perform public.require_account_access();
  return query select * from account_private.credit_activity_reward(public.current_account_id(),'attendance',array[account_private.current_reward_scope()]);
end $$;

create or replace function public.my_attendance_status()
returns table(available boolean,next_available_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare last_claim timestamptz;
begin
  perform public.require_account_access();
  last_claim:=account_private.last_activity_reward(public.current_account_id(),'attendance',array[account_private.current_reward_scope()]);
  return query select last_claim is null or last_claim<=now()-interval '24 hours',coalesce(last_claim+interval '24 hours',now());
end $$;

create or replace function public.my_rewarded_ad_status()
returns table(available boolean,next_available_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare last_claim timestamptz;
begin
  perform public.require_account_access();
  last_claim:=account_private.last_activity_reward(public.current_account_id(),'rewarded_ad',array[account_private.current_reward_scope()]);
  return query select last_claim is null or last_claim<=now()-interval '24 hours',coalesce(last_claim+interval '24 hours',now());
end $$;

create function public.prepare_rewarded_ad_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid:=public.current_account_id(); scope text; last_claim timestamptz; ticket uuid;
begin
  perform public.require_account_access();
  scope:=account_private.current_reward_scope();
  if not exists(select 1 from public.profiles where id=aid and status='active') then raise exception 'active_profile_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':rewarded_ad',0));
  last_claim:=account_private.last_activity_reward(aid,'rewarded_ad',array[scope]);
  if last_claim>now()-interval '24 hours' then
    return jsonb_build_object('available',false,'next_available_at',last_claim+interval '24 hours');
  end if;
  -- Reuse a pending ticket so retries cannot create unlimited rows.
  select token into ticket from account_private.rewarded_ad_claims
    where account_id=aid and scope_hash=scope and processed_at is null and expires_at>now()+interval '1 hour'
    order by created_at desc limit 1;
  if ticket is null then
    insert into account_private.rewarded_ad_claims(account_id,scope_hash) values(aid,scope) returning token into ticket;
  end if;
  return jsonb_build_object('available',true,'token',ticket,'user_id',aid,'custom_data','ingtalk_rewarded_v2:'||ticket::text);
end $$;

create function public.my_rewarded_ad_claim_status(claim_token uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare result text;
begin
  perform public.require_account_access();
  select case when processed_at is not null then case when awarded then 'awarded' else 'denied' end
    when expires_at<=now() then 'expired' else 'pending' end into result
    from account_private.rewarded_ad_claims where token=claim_token and account_id=public.current_account_id();
  return coalesce(result,'unavailable');
end $$;

create or replace function public.credit_verified_rewarded_ad(target_user_id uuid,ad_provider text,ad_transaction_id text,verified_payload jsonb default '{}')
returns table(awarded boolean,balance bigint,next_available_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare scopes text[]; ticket account_private.rewarded_ad_claims; marker text:=verified_payload->>'custom_data'; result record; last_claim timestamptz;
begin
  -- EXECUTE is granted only to service_role; clients cannot submit SSV payloads.
  if target_user_id is null or nullif(trim(ad_provider),'') is null or nullif(trim(ad_transaction_id),'') is null then raise exception 'invalid_rewarded_ad_verification'; end if;
  if not exists(select 1 from public.profiles where id=target_user_id and status='active') then raise exception 'active_profile_required'; end if;
  if marker like 'ingtalk_rewarded_v2:%' then
    select * into ticket from account_private.rewarded_ad_claims
      where token::text=substr(marker,21) and account_id=target_user_id for update;
    if ticket.token is null then raise exception 'invalid_rewarded_ad_claim'; end if;
    scopes:=array[ticket.scope_hash];
  elsif marker is null or marker='ingtalk_rewarded_50' then
    -- Older APKs cannot identify the viewing device. Keep their SSV compatible,
    -- conservatively checking/consuming ALL devices on that account, never none.
    select array_agg(distinct device_scope_hash order by device_scope_hash) into scopes
      from account_private.account_devices where account_id=target_user_id;
  else raise exception 'invalid_rewarded_ad_claim';
  end if;
  if coalesce(cardinality(scopes),0)=0 then raise exception 'authorized_device_required'; end if;
  insert into public.rewarded_ad_verifications(provider,transaction_id,user_id,verification_payload)
    values(trim(ad_provider),trim(ad_transaction_id),target_user_id,coalesce(verified_payload,'{}'))
    on conflict(provider,transaction_id) do nothing;
  if not found or (ticket.token is not null and (ticket.processed_at is not null or ticket.expires_at<=now())) then
    last_claim:=account_private.last_activity_reward(target_user_id,'rewarded_ad',scopes);
    return query select false,coalesce((select w.balance from public.point_wallets w where w.user_id=target_user_id),0),coalesce(last_claim+interval '24 hours',now());
    return;
  end if;
  select * into result from account_private.credit_activity_reward(target_user_id,'rewarded_ad',scopes);
  update public.rewarded_ad_verifications set awarded=result.awarded where provider=trim(ad_provider) and transaction_id=trim(ad_transaction_id);
  if ticket.token is not null then
    update account_private.rewarded_ad_claims set processed_at=now(),awarded=result.awarded where token=ticket.token;
  end if;
  return query select result.awarded,result.balance,result.next_available_at;
end $$;

revoke all on function public.credit_verified_rewarded_ad(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.credit_verified_rewarded_ad(uuid,text,text,jsonb) to service_role;
revoke all on function public.claim_attendance_reward(),public.my_attendance_status(),public.my_rewarded_ad_status(),public.prepare_rewarded_ad_claim(),public.my_rewarded_ad_claim_status(uuid) from public,anon;
grant execute on function public.claim_attendance_reward(),public.my_attendance_status(),public.my_rewarded_ad_status(),public.prepare_rewarded_ad_claim(),public.my_rewarded_ad_claim_status(uuid) to authenticated;
revoke all on all functions in schema account_private from public,anon,authenticated;

create or replace function public.run_retention_cleanup(batch_limit integer default 5000) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=account_private.base_retention_cleanup(batch_limit);
  delete from account_private.device_registrations where created_at<=now()-interval '24 hours';
  delete from account_private.device_login_events where created_at<=now()-interval '24 hours';
  delete from account_private.phone_welcome_grants g where g.retain_until<=now()
    and not exists(select 1 from account_private.account_identities b where b.identity_hash=g.phone_hash);
  delete from account_private.reinstall_attempts where window_started<=now()-interval '1 hour';
  delete from account_private.account_link_requests where expires_at<=now()-interval '1 day';
  delete from account_private.identity_deletion_jobs j where created_at<=now()-interval '30 days'
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=any(j.identity_ids));
  delete from account_private.device_enrollment_history h where retain_until<=now()
    and not exists(select 1 from account_private.account_devices a where a.device_scope_hash=h.scope_hash);
  delete from account_private.device_reward_claims where claimed_at<=now()-interval '7 days';
  delete from account_private.rewarded_ad_claims where expires_at<=now()-interval '7 days';
  return result;
end $$;
notify pgrst,'reload schema';

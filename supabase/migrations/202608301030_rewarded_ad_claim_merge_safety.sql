-- Keep ad-loading failures from blocking account recovery for a full day, and
-- preserve late legacy SSV callbacks after an account has been retired.
alter table account_private.rewarded_ad_claims
  alter column expires_at set default now()+interval '15 minutes';

update account_private.rewarded_ad_claims
set expires_at=least(expires_at,now()+interval '15 minutes')
where processed_at is null and expires_at>now()+interval '15 minutes';

create or replace function public.prepare_rewarded_ad_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  aid uuid:=public.current_account_id();
  scope text; last_claim timestamptz; ticket uuid;
begin
  perform public.require_account_access();
  scope:=account_private.current_reward_scope();
  if not exists(select 1 from public.profiles where id=aid and status='active') then
    raise exception 'active_profile_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':rewarded_ad',0));
  last_claim:=account_private.last_activity_reward(aid,'rewarded_ad',array[scope]);
  if last_claim>now()-interval '24 hours' then
    return jsonb_build_object('available',false,'next_available_at',last_claim+interval '24 hours');
  end if;

  select token into ticket from account_private.rewarded_ad_claims
  where account_id=aid and scope_hash=scope and processed_at is null
    and expires_at>now()+interval '1 minute'
  order by created_at desc limit 1;

  if ticket is null then
    insert into account_private.rewarded_ad_claims(account_id,scope_hash,expires_at)
      values(aid,scope,now()+interval '15 minutes') returning token into ticket;
  end if;

  return jsonb_build_object('available',true,'token',ticket,'user_id',aid,
    'custom_data','ingtalk_rewarded_v2:'||ticket::text);
end $$;

create or replace function public.cancel_rewarded_ad_claim(claim_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare aid uuid:=public.current_account_id(); cancelled boolean:=false;
begin
  perform public.require_account_access();
  if claim_token is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':rewarded_ad',0));
  update account_private.rewarded_ad_claims
    set processed_at=now(),awarded=false
  where token=claim_token and account_id=aid and processed_at is null;
  cancelled:=found;
  return cancelled;
end $$;

create or replace function public.reset_rewarded_ad_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid:=public.current_account_id(); scope text;
begin
  perform public.require_account_access();
  scope:=account_private.current_reward_scope();
  if not exists(select 1 from public.profiles where id=aid and status='active') then
    raise exception 'active_profile_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':rewarded_ad',0));
  update account_private.rewarded_ad_claims set processed_at=now(),awarded=false
  where account_id=aid and scope_hash=scope and processed_at is null;
  return public.prepare_rewarded_ad_claim();
end $$;

create or replace function public.credit_verified_rewarded_ad_resolved(
  requested_user_id uuid,
  ad_provider text,
  ad_transaction_id text,
  verified_payload jsonb default '{}'
) returns table(awarded boolean,balance bigint,next_available_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare recipient uuid;
begin
  if requested_user_id is null then raise exception 'invalid_rewarded_ad_verification'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));

  select p.id into recipient from public.profiles p
    where p.id=requested_user_id and p.status='active';
  if recipient is null then
    select a.canonical_account_id into recipient
    from account_private.account_recovery_aliases a
    join public.profiles p on p.id=a.canonical_account_id and p.status='active'
    where a.retired_account_id=requested_user_id;
  end if;
  if recipient is null then raise exception 'active_profile_required'; end if;

  return query select r.awarded,r.balance,r.next_available_at
  from public.credit_verified_rewarded_ad(recipient,ad_provider,ad_transaction_id,verified_payload) r;
end $$;

revoke all on function public.prepare_rewarded_ad_claim(),public.reset_rewarded_ad_claim(),
  public.cancel_rewarded_ad_claim(uuid) from public,anon;
grant execute on function public.prepare_rewarded_ad_claim(),public.reset_rewarded_ad_claim(),
  public.cancel_rewarded_ad_claim(uuid) to authenticated;
revoke all on function public.credit_verified_rewarded_ad_resolved(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.credit_verified_rewarded_ad_resolved(uuid,text,text,jsonb) to service_role;
notify pgrst,'reload schema';

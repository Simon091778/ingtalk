-- Always issue a fresh rewarded-ad claim token on each user request, and
-- keep pending token reuse from causing stuck sessions.
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

  insert into account_private.rewarded_ad_claims(account_id,scope_hash)
    values(aid,scope)
    returning token into ticket;

  return jsonb_build_object('available',true,'token',ticket,'user_id',aid,'custom_data','ingtalk_rewarded_v2:'||ticket::text);
end $$;

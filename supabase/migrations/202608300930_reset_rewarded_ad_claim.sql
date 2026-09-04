-- Allow users to recover a stuck rewarded-ad claim flow by expiring older
-- unprocessed tickets before reissuing a fresh claim ticket.
create or replace function public.reset_rewarded_ad_claim()
returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  aid uuid:=public.current_account_id();
  scope text;
begin
  perform public.require_account_access();
  scope:=account_private.current_reward_scope();

  if not exists(select 1 from public.profiles where id=aid and status='active') then
    raise exception 'active_profile_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activity-account:'||aid::text||':rewarded_ad',0));

  -- A previous claim can remain pending after crashes/network loss.
  -- Expire any in-flight ticket for this device/account so recovery always
  -- creates a fresh claim for the next attempt.
  update account_private.rewarded_ad_claims
    set processed_at = now()
  where account_id = aid
    and scope_hash = scope
    and processed_at is null;

  return public.prepare_rewarded_ad_claim();
end $$;

revoke all on function public.reset_rewarded_ad_claim() from public,anon;
grant execute on function public.reset_rewarded_ad_claim() to authenticated;

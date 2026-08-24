-- Rewarded-ad points are credited only after an ad provider callback has been
-- verified by a trusted server. App clients can read availability but cannot
-- call the credit function or write verification/claim records.

alter table public.point_reward_claims
  drop constraint if exists point_reward_claims_reward_type_check;
alter table public.point_reward_claims
  add constraint point_reward_claims_reward_type_check
  check (reward_type in ('attendance', 'talk_write', 'board_post', 'board_comment', 'rewarded_ad'));

create table if not exists public.rewarded_ad_verifications (
  id bigint generated always as identity primary key,
  provider text not null check (char_length(trim(provider)) between 1 and 40),
  transaction_id text not null check (char_length(trim(transaction_id)) between 1 and 255),
  user_id uuid not null references public.profiles(id) on delete cascade,
  awarded boolean not null default false,
  verified_at timestamptz not null default now(),
  verification_payload jsonb not null default '{}'::jsonb,
  unique (provider, transaction_id)
);

alter table public.rewarded_ad_verifications enable row level security;
revoke all on public.rewarded_ad_verifications from anon, authenticated;

create or replace function public.my_rewarded_ad_status()
returns table (available boolean, next_available_at timestamptz)
language sql stable security definer set search_path = public as $$
  select claim.claimed_at is null or claim.claimed_at <= now() - interval '24 hours',
         case when claim.claimed_at is null then now() else claim.claimed_at + interval '24 hours' end
  from (
    select (
      select claimed_at
      from public.point_reward_claims
      where user_id = auth.uid() and reward_type = 'rewarded_ad'
    ) as claimed_at
  ) claim
  where auth.uid() is not null;
$$;
revoke all on function public.my_rewarded_ad_status() from public, anon;
grant execute on function public.my_rewarded_ad_status() to authenticated;

create or replace function public.credit_verified_rewarded_ad(
  target_user_id uuid,
  ad_provider text,
  ad_transaction_id text,
  verified_payload jsonb default '{}'::jsonb
)
returns table (awarded boolean, balance bigint, next_available_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  last_claim timestamptz;
  current_balance bigint;
  did_award boolean := false;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required';
  end if;
  if target_user_id is null
     or nullif(trim(ad_provider), '') is null
     or nullif(trim(ad_transaction_id), '') is null then
    raise exception 'invalid_rewarded_ad_verification';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = target_user_id and status = 'active'
  ) then
    raise exception 'active_profile_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':rewarded_ad', 0));

  -- A provider transaction is permanently consumed even when the user is still
  -- inside the cooldown, so it cannot be replayed after the cooldown expires.
  insert into public.rewarded_ad_verifications(
    provider, transaction_id, user_id, verification_payload
  ) values (
    trim(ad_provider), trim(ad_transaction_id), target_user_id, coalesce(verified_payload, '{}'::jsonb)
  ) on conflict (provider, transaction_id) do nothing;

  if not found then
    select wallet.balance into current_balance
    from public.point_wallets wallet where wallet.user_id = target_user_id;
    select claim.claimed_at into last_claim
    from public.point_reward_claims claim
    where claim.user_id = target_user_id and claim.reward_type = 'rewarded_ad';
    return query select false, coalesce(current_balance, 0),
      coalesce(last_claim + interval '24 hours', now());
    return;
  end if;

  select claim.claimed_at into last_claim
  from public.point_reward_claims claim
  where claim.user_id = target_user_id and claim.reward_type = 'rewarded_ad';

  if last_claim is null or last_claim <= now() - interval '24 hours' then
    insert into public.point_reward_claims(user_id, reward_type, claimed_at)
    values (target_user_id, 'rewarded_ad', now())
    on conflict (user_id, reward_type) do update set claimed_at = excluded.claimed_at;

    update public.point_wallets
    set balance = point_wallets.balance + 50, updated_at = now()
    where user_id = target_user_id
    returning point_wallets.balance into current_balance;
    if not found then raise exception 'point_wallet_not_found'; end if;

    insert into public.point_transactions(user_id, amount, reason)
    values (target_user_id, 50, 'reward_rewarded_ad');
    update public.rewarded_ad_verifications
    set awarded = true
    where provider = trim(ad_provider) and transaction_id = trim(ad_transaction_id);
    last_claim := now();
    did_award := true;
  else
    select wallet.balance into current_balance
    from public.point_wallets wallet where wallet.user_id = target_user_id;
  end if;

  return query select did_award, coalesce(current_balance, 0), last_claim + interval '24 hours';
end;
$$;

revoke all on function public.credit_verified_rewarded_ad(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.credit_verified_rewarded_ad(uuid, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';

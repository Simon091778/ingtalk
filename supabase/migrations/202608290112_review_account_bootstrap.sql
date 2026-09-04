-- Preconfigure synthetic review profiles after normal phone/device authorization.
-- Contains NO live review phone, OTP, Auth UID, or client-visible bypass flag.
create table account_private.review_access (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean not null default true,
  valid_until timestamptz not null,
  created_at timestamptz not null default now()
);
alter table account_private.review_access enable row level security;
revoke all on account_private.review_access from public,anon,authenticated;

create function account_private.prepare_review_account(aid uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare uid uuid; ph text;
begin
  -- Serialize with login/link/delete; never trust user-editable Auth metadata.
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  select a.auth_user_id,a.phone_hash into uid,ph
  from account_private.device_accounts a
  join account_private.review_access r on r.auth_user_id=a.auth_user_id and r.phone_hash=a.phone_hash
  join auth.users u on u.id=a.auth_user_id
  where a.id=aid and a.auth_provider='phone' and r.enabled and r.valid_until>now()
    and u.phone ~ '^120255501[0-9]{2}$'
    and account_private.identity_hash(u.id,'phone')=r.phone_hash
    and (u.banned_until is null or u.banned_until<now())
    and not exists(select 1 from account_private.identity_deletions d where d.auth_user_id=u.id)
    and exists(select 1 from account_private.account_identities b where b.account_id=aid
      and b.provider='phone' and b.auth_user_id=u.id and b.identity_hash=r.phone_hash);
  if uid is null then return false; end if;
  -- Only a new synthetic profile receives the one-time review balance. Never
  -- overwrite an existing profile, restore spent points, or undo moderation.
  insert into public.profiles(id,nickname,birth_year,region_code,gender,introduction,
    language_code,country_code,welcome_points_claimed)
  values(aid,'Review'||left(replace(aid::text,'-',''),3),1990,'UNSET','other',
    'Synthetic app review account.','en','KR',true)
  on conflict(id) do nothing;
  if not found then return false; end if;
  -- This is a review grant, not a purchase or an ad reward. Keep an audit ledger.
  update public.point_wallets set balance=balance+10000,updated_at=now() where user_id=aid;
  if not found then raise exception 'wallet_missing'; end if;
  insert into public.point_transactions(user_id,amount,reason,reference_id)
    values(aid,10000,'review_access',aid);
  return true;
end $$;
revoke all on function account_private.prepare_review_account(uuid) from public,anon,authenticated;

create function account_private.prepare_review_identity_account() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.provider='phone' then perform account_private.prepare_review_account(new.account_id); end if;
  return new;
end $$;
revoke all on function account_private.prepare_review_identity_account() from public,anon,authenticated;
create trigger prepare_review_identity_account after insert on account_private.account_identities
for each row execute function account_private.prepare_review_identity_account();

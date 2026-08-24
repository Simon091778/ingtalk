-- Welcome points are granted once per pseudonymous device, not once per disposable anonymous account.

create table if not exists public.device_welcome_grants (
  device_hash text primary key check (device_hash ~ '^[0-9a-f]{64}$'),
  first_granted_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.device_welcome_grants enable row level security;
revoke all on public.device_welcome_grants from public, anon, authenticated;

alter table public.profiles add column if not exists welcome_points_claimed boolean not null default false;
revoke update (welcome_points_claimed) on public.profiles from authenticated;

-- Existing accounts already received the legacy welcome balance. Mark them before new profiles are created.
update public.profiles set welcome_points_claimed = true where welcome_points_claimed = false;

alter table public.point_wallets alter column balance set default 0;

create or replace function public.create_point_wallet_for_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.point_wallets(user_id, balance) values (new.id, 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create or replace function public.claim_device_welcome_points(device_fingerprint text)
returns table (awarded boolean, balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_hash text := lower(trim(coalesce(device_fingerprint, '')));
  inserted_count integer := 0;
  already_claimed boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if normalized_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_device_fingerprint'; end if;

  perform pg_advisory_xact_lock(hashtextextended(normalized_hash, 0));
  select profile.welcome_points_claimed into already_claimed
  from public.profiles profile where profile.id = auth.uid() for update;
  if already_claimed is null then raise exception 'profile_not_found'; end if;
  if already_claimed then
    insert into public.device_welcome_grants(device_hash)
    values (normalized_hash) on conflict (device_hash) do update set last_seen_at = now();
    return query select false, coalesce((select wallet.balance from public.point_wallets wallet where wallet.user_id = auth.uid()), 0);
    return;
  end if;

  insert into public.device_welcome_grants(device_hash)
  values (normalized_hash) on conflict (device_hash) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 1 then
    update public.point_wallets set balance = point_wallets.balance + 1000, updated_at = now()
    where user_id = auth.uid();
    insert into public.point_transactions(user_id, amount, reason)
    values (auth.uid(), 1000, 'welcome_device');
  else
    update public.device_welcome_grants set last_seen_at = now() where device_hash = normalized_hash;
  end if;

  update public.profiles set welcome_points_claimed = true, updated_at = now() where id = auth.uid();
  return query select inserted_count = 1,
    coalesce((select wallet.balance from public.point_wallets wallet where wallet.user_id = auth.uid()), 0);
end;
$$;

revoke all on function public.claim_device_welcome_points(text) from public, anon, authenticated;
grant execute on function public.claim_device_welcome_points(text) to authenticated;

notify pgrst, 'reload schema';

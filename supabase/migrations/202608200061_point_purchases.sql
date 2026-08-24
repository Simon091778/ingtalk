-- Verified App Store / Google Play consumable point purchases.
create table if not exists public.point_products (
  product_id text primary key,
  point_amount bigint not null check (point_amount > 0),
  price_won bigint not null check (price_won > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.point_products(product_id, point_amount, price_won) values
  ('kr.ingtalk.points.3000', 3000, 3000),
  ('kr.ingtalk.points.5000', 5000, 5000),
  ('kr.ingtalk.points.10000', 10000, 10000),
  ('kr.ingtalk.points.30000', 30000, 30000),
  ('kr.ingtalk.points.50000', 50000, 50000),
  ('kr.ingtalk.points.100000', 100000, 99000)
on conflict (product_id) do update set
  point_amount = excluded.point_amount,
  price_won = excluded.price_won,
  is_active = true,
  updated_at = now();

create table if not exists public.point_purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'revenuecat' check (provider = 'revenuecat'),
  provider_event_id text not null unique,
  store_transaction_id text not null unique,
  user_id uuid not null references public.profiles(id) on delete restrict,
  product_id text not null references public.point_products(product_id),
  point_amount bigint not null check (point_amount > 0),
  price_won bigint not null check (price_won > 0),
  store text not null check (store in ('APP_STORE', 'PLAY_STORE', 'TEST_STORE', 'STRIPE', 'UNKNOWN_STORE')),
  environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
  status text not null default 'credited' check (status in ('credited', 'refunded')),
  unrecovered_points bigint not null default 0 check (unrecovered_points >= 0),
  purchased_at timestamptz,
  refunded_at timestamptz,
  raw_event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists point_purchase_receipts_user_idx
  on public.point_purchase_receipts(user_id, created_at desc);

alter table public.point_products enable row level security;
alter table public.point_purchase_receipts enable row level security;
drop policy if exists "authenticated users read active point products" on public.point_products;
create policy "authenticated users read active point products" on public.point_products
  for select to authenticated using (is_active);
drop policy if exists "users read own point purchases" on public.point_purchase_receipts;
create policy "users read own point purchases" on public.point_purchase_receipts
  for select to authenticated using (user_id = auth.uid());
revoke all on public.point_products, public.point_purchase_receipts from public, anon, authenticated;
grant select on public.point_products to authenticated;
grant select on public.point_purchase_receipts to authenticated;

create or replace function public.credit_verified_point_purchase(
  event_identifier text,
  transaction_identifier text,
  target_user_id uuid,
  purchased_product_id text,
  purchase_store text,
  purchase_environment text,
  purchased_at_ms bigint,
  event_payload jsonb
)
returns table (credited boolean, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  product public.point_products;
  receipt_uuid uuid;
  wallet_balance bigint;
begin
  if current_user not in ('service_role', 'postgres') then raise exception 'service_role_required'; end if;
  if nullif(trim(event_identifier), '') is null or nullif(trim(transaction_identifier), '') is null then raise exception 'invalid_purchase_identity'; end if;
  select * into product from public.point_products where product_id = purchased_product_id and is_active for share;
  if product.product_id is null then raise exception 'unknown_point_product'; end if;
  if not exists (select 1 from public.profiles where id = target_user_id) then raise exception 'profile_not_found'; end if;

  insert into public.point_purchase_receipts(
    provider_event_id, store_transaction_id, user_id, product_id, point_amount,
    price_won, store, environment, purchased_at, raw_event
  ) values (
    trim(event_identifier), trim(transaction_identifier), target_user_id, product.product_id, product.point_amount,
    product.price_won, purchase_store, purchase_environment,
    case when purchased_at_ms is null then null else to_timestamp(purchased_at_ms / 1000.0) end,
    coalesce(event_payload, '{}'::jsonb)
  )
  on conflict (store_transaction_id) do nothing
  returning id into receipt_uuid;

  if receipt_uuid is null then
    select point_wallet.balance into wallet_balance from public.point_wallets point_wallet where point_wallet.user_id = target_user_id;
    return query select false, coalesce(wallet_balance, 0);
    return;
  end if;

  update public.point_wallets point_wallet
  set balance = point_wallet.balance + product.point_amount, updated_at = now()
  where point_wallet.user_id = target_user_id
  returning point_wallet.balance into wallet_balance;
  if wallet_balance is null then raise exception 'point_wallet_not_found'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (target_user_id, product.point_amount, 'point_purchase', receipt_uuid);
  return query select true, wallet_balance;
end;
$$;

create or replace function public.refund_verified_point_purchase(
  original_transaction_identifier text,
  event_identifier text,
  event_payload jsonb
)
returns table (refunded boolean, recovered_points bigint, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  receipt public.point_purchase_receipts;
  recover_amount bigint;
  wallet_balance bigint;
begin
  if current_user not in ('service_role', 'postgres') then raise exception 'service_role_required'; end if;
  select * into receipt from public.point_purchase_receipts
  where store_transaction_id = trim(original_transaction_identifier) for update;
  if receipt.id is null then raise exception 'purchase_receipt_not_found'; end if;
  select point_wallet.balance into wallet_balance from public.point_wallets point_wallet
  where point_wallet.user_id = receipt.user_id for update;
  if receipt.status = 'refunded' then
    return query select false, (receipt.point_amount - receipt.unrecovered_points), coalesce(wallet_balance, 0);
    return;
  end if;
  recover_amount := least(coalesce(wallet_balance, 0), receipt.point_amount);
  update public.point_wallets point_wallet
  set balance = point_wallet.balance - recover_amount, updated_at = now()
  where point_wallet.user_id = receipt.user_id
  returning point_wallet.balance into wallet_balance;
  if recover_amount > 0 then
    insert into public.point_transactions(user_id, amount, reason, reference_id)
    values (receipt.user_id, -recover_amount, 'point_purchase_refund', receipt.id);
  end if;
  update public.point_purchase_receipts
  set status = 'refunded', refunded_at = now(), updated_at = now(),
      unrecovered_points = receipt.point_amount - recover_amount,
      raw_event = coalesce(event_payload, raw_event)
  where id = receipt.id;
  return query select true, recover_amount, wallet_balance;
end;
$$;

revoke all on function public.credit_verified_point_purchase(text, text, uuid, text, text, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.refund_verified_point_purchase(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.credit_verified_point_purchase(text, text, uuid, text, text, text, bigint, jsonb) to service_role;
grant execute on function public.refund_verified_point_purchase(text, text, jsonb) to service_role;

notify pgrst, 'reload schema';

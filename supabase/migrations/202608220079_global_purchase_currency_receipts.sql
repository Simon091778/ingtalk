-- Preserve the actual store charge separately from the KRW catalog reference.
alter table public.point_purchase_receipts
  add column if not exists purchase_currency text,
  add column if not exists purchase_amount numeric(14, 2),
  add column if not exists purchase_country_code text;

alter table public.point_purchase_receipts drop constraint if exists point_purchase_receipts_purchase_currency_check;
alter table public.point_purchase_receipts add constraint point_purchase_receipts_purchase_currency_check
  check (purchase_currency is null or purchase_currency ~ '^[A-Z]{3}$');
alter table public.point_purchase_receipts drop constraint if exists point_purchase_receipts_purchase_amount_check;
alter table public.point_purchase_receipts add constraint point_purchase_receipts_purchase_amount_check
  check (purchase_amount is null or purchase_amount >= 0);
alter table public.point_purchase_receipts drop constraint if exists point_purchase_receipts_purchase_country_code_check;
alter table public.point_purchase_receipts add constraint point_purchase_receipts_purchase_country_code_check
  check (purchase_country_code is null or purchase_country_code ~ '^[A-Z]{2}$');

create or replace function public.credit_verified_point_purchase_v2(
  event_identifier text,
  transaction_identifier text,
  target_user_id uuid,
  purchased_product_id text,
  purchase_store text,
  purchase_environment text,
  purchased_at_ms bigint,
  purchased_currency text,
  purchased_amount numeric,
  purchased_country_code text,
  event_payload jsonb
)
returns table (credited boolean, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  product public.point_products;
  receipt_uuid uuid;
  wallet_balance bigint;
  normalized_currency text := nullif(upper(trim(purchased_currency)), '');
  normalized_country text := nullif(upper(trim(purchased_country_code)), '');
begin
  if current_user not in ('service_role', 'postgres') then raise exception 'service_role_required'; end if;
  if nullif(trim(event_identifier), '') is null or nullif(trim(transaction_identifier), '') is null then raise exception 'invalid_purchase_identity'; end if;
  if normalized_currency is not null and normalized_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_purchase_currency'; end if;
  if normalized_country is not null and normalized_country !~ '^[A-Z]{2}$' then raise exception 'invalid_purchase_country'; end if;
  if purchased_amount is not null and purchased_amount < 0 then raise exception 'invalid_purchase_amount'; end if;
  select * into product from public.point_products where product_id = purchased_product_id and is_active for share;
  if product.product_id is null then raise exception 'unknown_point_product'; end if;
  if not exists (select 1 from public.profiles where id = target_user_id) then raise exception 'profile_not_found'; end if;

  insert into public.point_purchase_receipts(
    provider_event_id, store_transaction_id, user_id, product_id, point_amount,
    price_won, purchase_currency, purchase_amount, purchase_country_code,
    store, environment, purchased_at, raw_event
  ) values (
    trim(event_identifier), trim(transaction_identifier), target_user_id, product.product_id, product.point_amount,
    product.price_won, normalized_currency, purchased_amount, normalized_country,
    purchase_store, purchase_environment,
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

revoke all on function public.credit_verified_point_purchase_v2(text, text, uuid, text, text, text, bigint, text, numeric, text, jsonb) from public;
grant execute on function public.credit_verified_point_purchase_v2(text, text, uuid, text, text, text, bigint, text, numeric, text, jsonb) to service_role;

comment on column public.point_purchase_receipts.price_won is 'KRW catalog reference price at purchase time; not necessarily the amount charged.';
comment on column public.point_purchase_receipts.purchase_currency is 'ISO 4217 currency reported by RevenueCat.';
comment on column public.point_purchase_receipts.purchase_amount is 'Amount charged in purchase_currency as reported by RevenueCat.';
comment on column public.point_purchase_receipts.purchase_country_code is 'ISO 3166-1 alpha-2 storefront country reported by RevenueCat.';

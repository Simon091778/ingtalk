begin;

-- Financial ownership is anchored to the account that created the receipt.
-- This UUID is an audit identifier only: it is deliberately not a destructive
-- FK to profiles and must never be used to choose a login or refund wallet.
alter table public.point_purchase_receipts
  add column original_account_id uuid;

-- The only safe backfill is the still-attached operational payer. Rows that
-- had already lost user_id would remain NULL rather than being guessed.
update public.point_purchase_receipts
set original_account_id=user_id
where original_account_id is null and user_id is not null;

create index point_purchase_receipts_original_account_idx
  on public.point_purchase_receipts(original_account_id,created_at desc);

comment on column public.point_purchase_receipts.original_account_id is
  'Immutable internal account UUID recorded when the purchase receipt is created; audit-only and never a login, phone ownership, canonical-wallet, or refund-wallet selector.';

create function account_private.protect_purchase_original_account() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.original_account_id is null then
      if new.user_id is null then
        raise exception 'original_purchase_account_required';
      end if;
      new.original_account_id:=new.user_id;
    elsif new.user_id is not null and new.original_account_id<>new.user_id then
      raise exception 'original_purchase_account_mismatch';
    end if;
  elsif new.original_account_id is distinct from old.original_account_id then
    raise exception 'original_purchase_account_immutable';
  end if;
  return new;
end $$;

revoke all on function account_private.protect_purchase_original_account()
  from public,anon,authenticated;

create trigger protect_purchase_original_account
before insert or update on public.point_purchase_receipts
for each row execute function account_private.protect_purchase_original_account();

-- Resolve display metadata from the immutable original account. Aliases are
-- used only to explain the present canonical relationship; identity summaries
-- remain scoped to the original payer so a detached phone is never presented
-- as a payment-time snapshot or replaced with the survivor's phone.
create or replace function account_private.admin_purchase_payer_summary(
  target_account uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with resolved_account as (
    select target_account as original_account_id,
      alias_row.canonical_account_id,
      alias_row.canonical_account_id is not null as merged
    from (select 1) seed
    left join account_private.account_recovery_aliases alias_row
      on alias_row.retired_account_id=target_account
  ), account_state as (
    select resolved.*,
      original_profile.nickname as original_nickname,
      original_profile.status::text as original_status,
      canonical_profile.nickname as canonical_nickname,
      canonical_profile.status::text as canonical_status
    from resolved_account resolved
    left join public.profiles original_profile
      on original_profile.id=resolved.original_account_id
    left join public.profiles canonical_profile
      on canonical_profile.id=resolved.canonical_account_id
  )
  select jsonb_build_object(
    'original_account_id',state.original_account_id,
    'canonical_account_id',state.canonical_account_id,
    'nickname',state.original_nickname,
    'canonical_nickname',state.canonical_nickname,
    'account_status',case
      when state.original_account_id is null then 'unavailable'
      when state.merged then 'merged'
      when state.original_nickname is not null then state.original_status
      else 'deleted'
    end,
    'canonical_account_status',state.canonical_status,
    'merged',state.merged,
    'phone',case when state.original_account_id is not null
      then account_private.admin_account_phone(state.original_account_id)
      else jsonb_build_object('status','none','phone',null,'verified_at',null,
        'detached_at',null,'detach_reason',null) end,
    'google',case when state.original_account_id is not null
      then account_private.admin_account_google(state.original_account_id)
      else jsonb_build_object('status','none','email',null,'verified_at',null) end,
    'kakao',case when state.original_account_id is not null
      then account_private.admin_account_kakao(state.original_account_id)
      else jsonb_build_object('status','none','verified_at',null) end
  ) from account_state state;
$$;

revoke all on function account_private.admin_purchase_payer_summary(uuid)
  from public,anon,authenticated;
grant execute on function account_private.admin_purchase_payer_summary(uuid)
  to service_role;

create or replace function public.admin_list_point_purchases(
  search_text text default null,
  status_filter text default null,
  result_limit integer default 200)
returns table(
  receipt_id uuid,
  user_id uuid,
  nickname text,
  payer jsonb,
  payment_provider text,
  product_id text,
  point_amount bigint,
  price_won bigint,
  purchase_currency text,
  purchase_amount numeric,
  purchase_country_code text,
  store text,
  environment text,
  status text,
  unrecovered_points bigint,
  transaction_reference text,
  purchased_at timestamptz,
  refunded_at timestamptz,
  account_deleted_at timestamptz,
  created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare normalized_search text:=nullif(trim(search_text),'');
begin
  if not public.admin_has_role('reviewer') then
    raise exception 'admin_required' using errcode='42501';
  end if;
  if status_filter is not null and status_filter not in ('credited','refunded') then
    raise exception 'invalid_status_filter';
  end if;
  if result_limit is null or result_limit not between 1 and 500 then
    raise exception 'invalid_result_limit';
  end if;
  return query
    with page_receipts as materialized (
      select receipt.*
      from public.point_purchase_receipts receipt
      left join public.profiles operational_profile on operational_profile.id=receipt.user_id
      left join public.profiles original_profile on original_profile.id=receipt.original_account_id
      left join account_private.account_recovery_aliases alias_row
        on alias_row.retired_account_id=receipt.original_account_id
      left join public.profiles canonical_profile on canonical_profile.id=alias_row.canonical_account_id
      where (status_filter is null or receipt.status=status_filter)
        and (normalized_search is null
          or coalesce(receipt.original_account_id::text,'') ilike '%'||normalized_search||'%'
          or coalesce(receipt.user_id::text,'') ilike '%'||normalized_search||'%'
          or coalesce(original_profile.nickname,'') ilike '%'||normalized_search||'%'
          or coalesce(operational_profile.nickname,'') ilike '%'||normalized_search||'%'
          or coalesce(canonical_profile.nickname,'') ilike '%'||normalized_search||'%'
          or receipt.product_id ilike '%'||normalized_search||'%'
          or receipt.store ilike '%'||normalized_search||'%'
          or receipt.status ilike '%'||normalized_search||'%'
          or receipt.store_transaction_id ilike '%'||normalized_search||'%')
      order by receipt.created_at desc,receipt.id
      limit result_limit
    ), payer_summaries as materialized (
      select payer_account.original_account_id,
        account_private.admin_purchase_payer_summary(
          payer_account.original_account_id) as payer
      from (select distinct receipt.original_account_id
        from page_receipts receipt) payer_account
    )
    select receipt.id,receipt.user_id,operational_profile.nickname,
      summary.payer||jsonb_build_object('operational_account_id',receipt.user_id),
      receipt.provider,receipt.product_id,receipt.point_amount,receipt.price_won,
      receipt.purchase_currency,receipt.purchase_amount,receipt.purchase_country_code,
      receipt.store,receipt.environment,receipt.status,receipt.unrecovered_points,
      case when length(receipt.store_transaction_id)<=10 then receipt.store_transaction_id
        else left(receipt.store_transaction_id,4)||'…'||right(receipt.store_transaction_id,6) end,
      receipt.purchased_at,receipt.refunded_at,receipt.account_deleted_at,receipt.created_at
    from page_receipts receipt
    left join public.profiles operational_profile on operational_profile.id=receipt.user_id
    left join payer_summaries summary
      on summary.original_account_id is not distinct from receipt.original_account_id
    order by receipt.created_at desc,receipt.id;
end $$;

revoke all on function public.admin_list_point_purchases(text,text,integer)
  from public,anon;
grant execute on function public.admin_list_point_purchases(text,text,integer)
  to authenticated;

notify pgrst,'reload schema';
commit;

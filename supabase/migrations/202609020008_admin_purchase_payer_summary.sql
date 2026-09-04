begin;

-- Build the human-readable payer block from the authoritative receipt account
-- reference and the same current-identity resolvers used by account detail.
-- No authentication value is copied into the purchase ledger.
create function account_private.admin_purchase_payer_summary(target_account uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with resolved_account as (
    select target_account as original_account_id,
      coalesce(alias_row.canonical_account_id,target_account) as canonical_account_id,
      alias_row.canonical_account_id is not null as merged
    from (select 1) seed
    left join account_private.account_recovery_aliases alias_row
      on alias_row.retired_account_id=target_account
  ), account_profile as (
    select resolved.original_account_id,resolved.canonical_account_id,resolved.merged,
      profile.nickname,profile.status
    from resolved_account resolved
    left join public.profiles profile on profile.id=resolved.canonical_account_id
  )
  select jsonb_build_object(
    'original_account_id',profile.original_account_id,
    'canonical_account_id',case when profile.nickname is not null then profile.canonical_account_id else null end,
    'nickname',profile.nickname,
    'account_status',case
      when profile.nickname is not null then profile.status::text
      when profile.original_account_id is not null then 'deleted'
      else 'unavailable'
    end,
    'merged',profile.merged,
    'phone',case when profile.nickname is not null
      then account_private.admin_account_phone(profile.canonical_account_id)
      else jsonb_build_object('status','none','phone',null,'verified_at',null) end,
    'google',case when profile.nickname is not null
      then account_private.admin_account_google(profile.canonical_account_id)
      else jsonb_build_object('status','none','email',null,'verified_at',null) end,
    'kakao',case when profile.nickname is not null
      then account_private.admin_account_kakao(profile.canonical_account_id)
      else jsonb_build_object('status','none','verified_at',null) end
  )
  from account_profile profile;
$$;

revoke all on function account_private.admin_purchase_payer_summary(uuid)
  from public,anon,authenticated;
grant execute on function account_private.admin_purchase_payer_summary(uuid) to service_role;

drop function public.admin_list_point_purchases(text,text,integer);
create function public.admin_list_point_purchases(
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
      left join public.profiles profile on profile.id=receipt.user_id
      where (status_filter is null or receipt.status=status_filter)
        and (normalized_search is null
          or coalesce(receipt.user_id::text,'') ilike '%'||normalized_search||'%'
          or coalesce(profile.nickname,'') ilike '%'||normalized_search||'%'
          or receipt.product_id ilike '%'||normalized_search||'%'
          or receipt.store ilike '%'||normalized_search||'%'
          or receipt.status ilike '%'||normalized_search||'%'
          or receipt.store_transaction_id ilike '%'||normalized_search||'%')
      order by receipt.created_at desc,receipt.id
      limit result_limit
    ), payer_summaries as materialized (
      select payer_account.user_id,
        account_private.admin_purchase_payer_summary(payer_account.user_id) as payer
      from (select distinct receipt.user_id from page_receipts receipt
        where receipt.user_id is not null) payer_account
    )
    select receipt.id,receipt.user_id,profile.nickname,
      coalesce(summary.payer,account_private.admin_purchase_payer_summary(null)),
      receipt.provider,receipt.product_id,receipt.point_amount,receipt.price_won,
      receipt.purchase_currency,receipt.purchase_amount,receipt.purchase_country_code,
      receipt.store,receipt.environment,receipt.status,receipt.unrecovered_points,
      case when length(receipt.store_transaction_id)<=10 then receipt.store_transaction_id
        else left(receipt.store_transaction_id,4)||'…'||right(receipt.store_transaction_id,6) end,
      receipt.purchased_at,receipt.refunded_at,receipt.account_deleted_at,receipt.created_at
    from page_receipts receipt
    left join public.profiles profile on profile.id=receipt.user_id
    left join payer_summaries summary on summary.user_id=receipt.user_id
    order by receipt.created_at desc,receipt.id;
end $$;

revoke all on function public.admin_list_point_purchases(text,text,integer)
  from public,anon;
grant execute on function public.admin_list_point_purchases(text,text,integer)
  to authenticated;

notify pgrst,'reload schema';
commit;

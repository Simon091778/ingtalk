begin;

-- Read-only operational summaries. Authentication hashes, Auth user/session IDs,
-- full store transaction identifiers and provider payloads are intentionally omitted.
create function public.admin_list_account_merges(
  search_text text default null,
  result_limit integer default 200)
returns table(
  merge_id uuid,
  survivor_account_id uuid,
  survivor_nickname text,
  losing_account_id uuid,
  verified_provider text,
  survivor_balance bigint,
  losing_balance bigint,
  merged_balance bigint,
  asset_policy text,
  deleted_posts integer,
  deleted_comments integer,
  deleted_messages integer,
  deleted_purchases integer,
  deleted_conversation_cards integer,
  deleted_open_chat_messages integer,
  point_ledger_entries integer,
  created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare normalized_search text:=nullif(trim(search_text),'');
begin
  if not public.admin_has_role('reviewer') then
    raise exception 'admin_required' using errcode='42501';
  end if;
  if result_limit is null or result_limit not between 1 and 500 then
    raise exception 'invalid_result_limit';
  end if;
  return query
    select audit.id,audit.survivor_account_id,profile.nickname,
      audit.losing_account_id,audit.verified_provider,
      audit.survivor_balance,audit.losing_balance,audit.merged_balance,
      coalesce(audit.asset_counts->>'policy','legacy_transfer'),
      coalesce((audit.asset_counts->>'posts')::integer,0),
      coalesce((audit.asset_counts->>'comments')::integer,0),
      coalesce((audit.asset_counts->>'messages')::integer,0),
      coalesce((audit.asset_counts->>'purchases')::integer,0),
      coalesce((audit.asset_counts->>'conversation_cards')::integer,0),
      coalesce((audit.asset_counts->>'open_chat_messages')::integer,0),
      jsonb_array_length(audit.losing_point_ledger),audit.created_at
    from account_private.account_merge_audit audit
    left join public.profiles profile on profile.id=audit.survivor_account_id
    where normalized_search is null
      or audit.survivor_account_id::text ilike '%'||normalized_search||'%'
      or audit.losing_account_id::text ilike '%'||normalized_search||'%'
      or coalesce(profile.nickname,'') ilike '%'||normalized_search||'%'
      or audit.verified_provider ilike '%'||normalized_search||'%'
      or coalesce(audit.asset_counts->>'policy','legacy_transfer') ilike '%'||normalized_search||'%'
    order by audit.created_at desc,audit.id
    limit result_limit;
end $$;

create function public.admin_list_point_purchases(
  search_text text default null,
  status_filter text default null,
  result_limit integer default 200)
returns table(
  receipt_id uuid,
  user_id uuid,
  nickname text,
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
    select receipt.id,receipt.user_id,profile.nickname,receipt.product_id,
      receipt.point_amount,receipt.price_won,receipt.purchase_currency,
      receipt.purchase_amount,receipt.purchase_country_code,receipt.store,
      receipt.environment,receipt.status,receipt.unrecovered_points,
      case when length(receipt.store_transaction_id)<=10 then receipt.store_transaction_id
        else left(receipt.store_transaction_id,4)||'…'||right(receipt.store_transaction_id,6) end,
      receipt.purchased_at,receipt.refunded_at,receipt.account_deleted_at,receipt.created_at
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
    limit result_limit;
end $$;

revoke all on function public.admin_list_account_merges(text,integer) from public,anon;
revoke all on function public.admin_list_point_purchases(text,text,integer) from public,anon;
grant execute on function public.admin_list_account_merges(text,integer) to authenticated;
grant execute on function public.admin_list_point_purchases(text,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;

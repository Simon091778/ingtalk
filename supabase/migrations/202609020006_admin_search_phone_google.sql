begin;

create or replace function public.admin_search_users(
  search_text text default '',
  status_filter text default null,
  result_limit integer default 100
)
returns table (
  user_id uuid,
  nickname text,
  gender text,
  birth_year integer,
  status text,
  suspended_until timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  point_balance bigint,
  talk_count bigint,
  post_count bigint,
  comment_count bigint,
  report_count bigint,
  action_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text:=left(trim(coalesce(search_text,'')),254);
  compact_phone text;
  normalized_phone text;
  normalized_email text;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if status_filter is not null and status_filter not in ('active','paused','suspended','deleted') then
    raise exception 'invalid_status_filter';
  end if;

  compact_phone:=regexp_replace(normalized_search,'[[:space:]().-]','','g');
  normalized_phone:=case
    when compact_phone ~ '^010[0-9]{8}$' then '+82'||substr(compact_phone,2)
    when compact_phone ~ '^8210[0-9]{8}$' then '+'||compact_phone
    when compact_phone ~ '^\+8210[0-9]{8}$' then compact_phone
    else null
  end;
  normalized_email:=case when position('@' in normalized_search)>1 then lower(normalized_search) else null end;

  return query
  with phone_matches as materialized (
    select distinct identity_row.account_id
    from account_private.account_identities identity_row
    cross join lateral (
      select account_private.admin_account_phone(identity_row.account_id) as resolved
    ) current_phone
    where normalized_phone is not null
      and identity_row.provider='phone'
      and identity_row.identity_hash=account_private.hash_phone(normalized_phone)
      and account_private.identity_active(identity_row)
      and current_phone.resolved->>'status'='active'
      and current_phone.resolved->>'phone'=normalized_phone
  ), google_matches as materialized (
    -- Start from the private account mapping and restrict the Auth join to
    -- Google rows. Supabase owns auth.identities, so the application migration
    -- intentionally does not alter that table or duplicate email elsewhere.
    select distinct identity_row.account_id
    from account_private.account_identities identity_row
    join auth.identities google_identity
      on google_identity.user_id=identity_row.auth_user_id
      and google_identity.provider='google'
      and identity_row.identity_hash=account_private.hash_phone('google-sub-v1:'||google_identity.provider_id)
    cross join lateral (
      select account_private.admin_account_google(identity_row.account_id) as resolved
    ) current_google
    where normalized_email is not null
      and google_identity.provider='google'
      and google_identity.identity_data->>'sub'=google_identity.provider_id
      and lower(btrim(google_identity.identity_data->>'email'))=normalized_email
      and account_private.identity_active(identity_row)
      and current_google.resolved->>'status'='active'
      and lower(current_google.resolved->>'email')=normalized_email
  )
  select
    profile.id,
    profile.nickname,
    profile.gender,
    profile.birth_year,
    profile.status::text,
    profile.suspended_until,
    profile.created_at,
    profile.updated_at,
    coalesce(wallet.balance,0),
    (select count(*) from public.conversation_cards card where card.author_id=profile.id),
    (select count(*) from public.board_posts post where post.author_id=profile.id),
    (select count(*) from public.board_comments comment where comment.author_id=profile.id),
    (select count(*) from public.reports report where report.reported_user_id=profile.id),
    (select count(*) from public.moderation_actions action where action.target_user_id=profile.id)
  from public.profiles profile
  left join public.point_wallets wallet on wallet.user_id=profile.id
  where (status_filter is null or profile.status::text=status_filter)
    and (
      normalized_search=''
      or profile.nickname ilike '%'||normalized_search||'%'
      or profile.id::text ilike '%'||normalized_search||'%'
      or exists(select 1 from phone_matches matched where matched.account_id=profile.id)
      or exists(select 1 from google_matches matched where matched.account_id=profile.id)
    )
  order by profile.created_at desc
  limit least(greatest(result_limit,1),200);
end;
$$;

revoke all on function public.admin_search_users(text,text,integer) from public,anon,authenticated;
grant execute on function public.admin_search_users(text,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;

begin;

-- Resolve the email attached to the account's current Google OAuth identity.
-- The provider identity payload remains authoritative; no raw email is copied
-- into profiles or account identity tables.
create function account_private.admin_account_google(target_account uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with active_google as (
    select google_identity.identity_data->>'email' as email
    from account_private.account_identities identity_row
    join auth.identities google_identity
      on google_identity.user_id=identity_row.auth_user_id
      and google_identity.provider='google'
      and google_identity.identity_data->>'sub'=google_identity.provider_id
      and identity_row.identity_hash=account_private.hash_phone('google-sub-v1:'||google_identity.provider_id)
    where identity_row.account_id=target_account
      and identity_row.provider='google'
      and account_private.identity_active(identity_row)
  ), resolved as (
    select count(*)::integer as candidate_count,
      count(*) filter(where nullif(btrim(email),'') is not null)::integer as email_count,
      min(email) filter(where nullif(btrim(email),'') is not null) as email
    from active_google
  )
  select jsonb_build_object(
    'status',case
      when resolved.candidate_count=1 and resolved.email_count=1 then 'active'
      when resolved.candidate_count>0 or exists(
        select 1 from account_private.account_identities identity_row
        where identity_row.account_id=target_account and identity_row.provider='google'
      ) then 'unavailable'
      else 'none'
    end,
    'email',case
      when resolved.candidate_count=1 and resolved.email_count=1 then resolved.email
      else null
    end
  )
  from resolved;
$$;

revoke all on function account_private.admin_account_google(uuid) from public,anon,authenticated;
grant execute on function account_private.admin_account_google(uuid) to service_role;

-- Extend the existing single account-detail request. The existing reviewer gate
-- remains the only public authorization boundary.
create or replace function public.admin_get_account_operations(target_user_uuid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=target_user_uuid) then raise exception 'user_not_found'; end if;
  select jsonb_build_object(
    'account_id',p.id,'checked_at',now(),'profile_active',p.status='active',
    'phone',account_private.admin_account_phone(p.id),
    'google',account_private.admin_account_google(p.id),
    'identities',coalesce((select jsonb_agg(jsonb_build_object(
      'provider',b.provider,'linked_at',b.linked_at,'active',account_private.identity_active(b)) order by b.provider)
      from account_private.account_identities b where b.account_id=p.id),'[]'::jsonb),
    'devices',coalesce((select jsonb_agg(jsonb_build_object(
      'id',d.id,'platform',d.platform,'is_primary',d.is_primary,'created_at',d.created_at,
      'active_sessions',(select count(*) from account_private.sessions s join auth.sessions a on a.id=s.session_id and a.user_id=s.user_id
        where s.account_id=p.id and s.device_id=d.id and s.expires_at>now()),
      'rewards',(select jsonb_agg(jsonb_build_object('type',r.key,
        'account_claimed_at',c.claimed_at,'device_claimed_at',v.claimed_at,
        'available',p.status='active' and (greatest(c.claimed_at,v.claimed_at) is null or greatest(c.claimed_at,v.claimed_at)<=now()-interval '24 hours'),
        'next_available_at',greatest(c.claimed_at,v.claimed_at)+interval '24 hours') order by r.ord)
        from unnest(array['attendance','talk_write','board_post','board_comment','rewarded_ad']) with ordinality r(key,ord)
        left join public.point_reward_claims c on c.user_id=p.id and c.reward_type=r.key
        left join account_private.device_reward_claims v on v.scope_hash=d.device_scope_hash and v.reward_type=r.key)
      ) order by d.created_at,d.id) from account_private.account_devices d where d.account_id=p.id),'[]'::jsonb),
    'ad_claims',coalesce((select jsonb_agg(row_to_json(c) order by c.created_at desc,c.reference) from (
      select substr(encode(extensions.digest(t.token::text,'sha256'),'hex'),1,12) as reference,
        t.created_at,t.expires_at,t.processed_at,
        case when t.processed_at is not null then case when t.awarded then 'awarded' else 'denied' end
          when t.expires_at<=now() then 'expired' else 'pending' end as status,
        (select d.id from account_private.account_devices d where d.account_id=p.id and d.device_scope_hash=t.scope_hash) as device_id
      from account_private.rewarded_ad_claims t where t.account_id=p.id order by t.created_at desc,t.token limit 30
    ) c),'[]'::jsonb),
    'verifications',coalesce((select jsonb_agg(row_to_json(v) order by v.verified_at desc,v.id desc) from (
      select id,provider,awarded,verified_at from public.rewarded_ad_verifications where user_id=p.id order by verified_at desc,id desc limit 30
    ) v),'[]'::jsonb)
  ) into result from public.profiles p where p.id=target_user_uuid;
  return result;
end $$;

revoke all on function public.admin_get_account_operations(uuid) from public,anon;
grant execute on function public.admin_get_account_operations(uuid) to authenticated;

notify pgrst,'reload schema';
commit;

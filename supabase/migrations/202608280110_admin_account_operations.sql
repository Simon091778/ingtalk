-- Narrow admin RPCs: never return identity/device hashes, session IDs, ad tickets,
-- signatures or provider payloads. Reward eligibility remains server controlled.
create function public.admin_get_account_operations(target_user_uuid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=target_user_uuid) then raise exception 'user_not_found'; end if;
  select jsonb_build_object(
    'account_id',p.id,'checked_at',now(),'profile_active',p.status='active',
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

create function public.admin_revoke_device_sessions(target_user_uuid uuid,target_device_uuid uuid,admin_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare removed integer; device_platform text;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required' using errcode='42501'; end if;
  if admin_note is null or length(trim(admin_note)) not between 2 and 300 then raise exception 'invalid_admin_note'; end if;
  -- Serialize with login/link/recovery so a concurrently moved session is never
  -- revoked under an obsolete account/device association.
  perform pg_advisory_xact_lock(hashtextextended('ingtalk-account-identity-mutations-v1',0));
  select d.platform into device_platform from account_private.account_devices d
    join public.profiles p on p.id=d.account_id where d.id=target_device_uuid and d.account_id=target_user_uuid;
  if not found then raise exception 'device_not_found'; end if;
  -- Delete the actual Auth session, not only the app grant: a still-valid JWT
  -- must not be able to recreate that grant. Other devices/providers stay intact.
  delete from auth.sessions a using account_private.sessions s
    where a.id=s.session_id and a.user_id=s.user_id and s.account_id=target_user_uuid and s.device_id=target_device_uuid;
  get diagnostics removed = row_count;
  if removed>0 then
    insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
    values(auth.uid(),target_user_uuid,'revoke_device_sessions',trim(admin_note),
      jsonb_build_object('device_id',target_device_uuid,'platform',device_platform,'sessions',removed),
      jsonb_build_object('device_id',target_device_uuid,'platform',device_platform,'sessions',0));
  end if;
  return jsonb_build_object('revoked_sessions',removed);
end $$;

revoke all on function public.admin_get_account_operations(uuid) from public,anon;
revoke all on function public.admin_revoke_device_sessions(uuid,uuid,text) from public,anon;
grant execute on function public.admin_get_account_operations(uuid) to authenticated;
grant execute on function public.admin_revoke_device_sessions(uuid,uuid,text) to authenticated;

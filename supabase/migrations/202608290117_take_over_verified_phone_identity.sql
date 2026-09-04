-- A freshly verified phone number belongs to its current holder. When a
-- Google/Kakao account links that number, retire any phone-only app accounts
-- for the same number instead of transferring their profile, points or chats.
-- Accounts that also own a social identity, or are suspended, remain protected.
do $migration$
declare definition text;
  old_declaration text:=$old$other_id uuid; identity_count integer; device_count integer; recovery_device uuid; source_shell boolean:=false;$old$;
  new_declaration text:=$new$other_id uuid; identity_count integer; device_count integer; recovery_device uuid; source_shell boolean:=false;
  target_account_ids uuid[]; target_id uuid;$new$;
  old_lookup text:=$old$select count(*),(array_agg(account_id))[1] into identity_count,other_id
    from account_private.account_identities
    where (auth_user_id=uid or (provider=provider_name and identity_hash=ih)) and account_id<>r.account_id;
  if identity_count>1 then return jsonb_build_object('error','account_link_conflict'); end if;$old$;
  new_lookup text:=$new$select count(*),(array_agg(account_id order by account_id))[1],array_agg(account_id order by account_id)
    into identity_count,other_id,target_account_ids
    from account_private.account_identities
    where (auth_user_id=uid or (provider=provider_name and identity_hash=ih)) and account_id<>r.account_id;
  if identity_count>1 and provider_name<>'phone' then return jsonb_build_object('error','account_link_conflict'); end if;$new$;
  old_source_policy text:=$old$source_shell:=source_identity.provider='phone'
      and account_private.identity_active(source_identity)
      and not exists(select 1 from account_private.identity_deletions where auth_user_id=r.source_user)
      and not exists(select 1 from public.profiles where id=r.account_id)
      and not exists(select 1 from public.point_wallets where user_id=r.account_id)
      and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
      and device_count=1
      and exists(select 1 from account_private.account_devices where id=binding_id and account_id=r.account_id);$old$;
  new_source_policy text:=$new$source_shell:=source_identity.provider='phone'
      and account_private.identity_active(source_identity)
      and not exists(select 1 from account_private.identity_deletions where auth_user_id=r.source_user)
      and (select count(*) from account_private.account_identities where account_id=r.account_id)=1
      and device_count=1
      and (exists(select 1 from public.profiles where id=other_id)
        or exists(select 1 from public.point_wallets where user_id=other_id))
      and exists(select 1 from account_private.account_devices where id=binding_id and account_id=r.account_id);$new$;
  old_source_move text:=$old$    -- Move only the freshly verified phone login method. Deleting the empty
    -- shell cannot delete profile, points, chat or purchase data because the
    -- checks above and the account row locks exclude all such app data.
      update account_private.account_identities set account_id=other_id$old$;
  new_source_move text:=$new$    -- The freshly verified social account is canonical. Retire the current
    -- phone-only app data and move only its verified phone login method.
      perform public.delete_account_data(r.account_id);
      update account_private.account_identities set account_id=other_id$new$;
  insertion_point text:=$old$  -- Existing safe direction: the additional identity may have created its own
  -- empty shell on this device before the link was completed.$old$;
  takeover_block text:=$new$  -- A current Google/Kakao owner may take over a freshly OTP-verified phone
  -- number. Old phone-only app principals are deleted; their data and points
  -- are deliberately not transferred to the social account.
  if other_id is not null and provider_name='phone' then
    perform 1 from account_private.device_accounts where id=any(target_account_ids) order by id for update;
    if not exists(select 1 from account_private.account_identities b where b.account_id=r.account_id
        and b.provider in ('google','kakao') and account_private.identity_active(b))
      or exists(select 1 from unnest(target_account_ids) target(account_id) where
        (select count(*) from account_private.account_identities b where b.account_id=target.account_id)<>1
        or not exists(select 1 from account_private.account_identities b where b.account_id=target.account_id
          and b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih and account_private.identity_active(b))
        or exists(select 1 from public.profiles p where p.id=target.account_id and p.status::text='suspended'
          and (p.suspended_until is null or p.suspended_until>now()))) then
      return jsonb_build_object('error','account_link_conflict');
    end if;
    select account_id,device_id into previous_id,previous_device from account_private.sessions where session_id=sid;
    if previous_id is not null and previous_id<>r.account_id and not previous_id=any(target_account_ids) then
      return jsonb_build_object('error','account_link_conflict');
    end if;
    foreach target_id in array target_account_ids loop
      perform public.delete_account_data(target_id);
      delete from account_private.device_accounts where id=target_id;
    end loop;
    insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
      values(r.account_id,uid,'phone',ih);
    insert into account_private.phone_welcome_grants(phone_hash) values(ih)
      on conflict(phone_hash) do update set retain_until=now()+interval '1 year';
    insert into account_private.sessions(session_id,user_id,account_id,device_id,expires_at)
      values(sid,uid,r.account_id,binding_id,now()+interval '30 days')
      on conflict(session_id) do update set user_id=excluded.user_id,account_id=excluded.account_id,
        device_id=excluded.device_id,expires_at=excluded.expires_at;
    update account_private.account_link_requests set used_at=now() where token_hash=r.token_hash;
    return jsonb_build_object('ok',true,'account_id',r.account_id,'discarded_phone_accounts',to_jsonb(target_account_ids),
      'recovered_existing_account',false);
  end if;

  -- Existing safe direction: the additional identity may have created its own
  -- empty shell on this device before the link was completed.$new$;
begin
  definition:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  if position(old_declaration in definition)=0 then raise exception 'link_declaration_clause_missing'; end if;
  definition:=replace(definition,old_declaration,new_declaration);
  if position(old_lookup in definition)=0 then raise exception 'link_identity_lookup_clause_missing'; end if;
  definition:=replace(definition,old_lookup,new_lookup);
  if position(old_source_policy in definition)=0 then raise exception 'link_phone_source_policy_missing'; end if;
  definition:=replace(definition,old_source_policy,new_source_policy);
  if position(old_source_move in definition)=0 then raise exception 'link_phone_source_move_missing'; end if;
  definition:=replace(definition,old_source_move,new_source_move);
  if position(insertion_point in definition)=0 then raise exception 'link_takeover_insertion_point_missing'; end if;
  execute replace(definition,insertion_point,takeover_block);
end $migration$;

notify pgrst,'reload schema';

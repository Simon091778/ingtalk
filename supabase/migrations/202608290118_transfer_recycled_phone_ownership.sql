-- A new OTP session on an unknown native device represents the current holder
-- of a recycled phone number. Retire phone-only accounts, but only detach the
-- phone method from accounts protected by Google or Kakao so their data remains.
do $migration$
declare definition text;
  old_declaration text:=$old$d account_private.account_devices; created boolean:=false; restored boolean:=false; attempts integer; matches integer;$old$;
  new_declaration text:=$new$d account_private.account_devices; created boolean:=false; restored boolean:=false; attempts integer; matches integer;
  prior_phone_accounts uuid[]; prior_account uuid; social_methods integer;$new$;
  insertion_point text:=$old$insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)$old$;
  transfer_block text:=$new$-- Only a newly issued OTP session on an unknown native device transfers
    -- number ownership. Existing sessions and known-device restores keep their
    -- current behavior.
    if aid is null and provider_name='phone' and device_platform<>'web'
      and exists(select 1 from account_private.account_identities b
        where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih)
      and exists(select 1 from auth.sessions fresh_session where fresh_session.id=sid
        and fresh_session.created_at>(select min(b.linked_at) from account_private.account_identities b
          where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih)) then
      select array_agg(distinct b.account_id order by b.account_id) into prior_phone_accounts
        from account_private.account_identities b
        where b.auth_user_id=uid and b.provider='phone' and b.identity_hash=ih;
      perform 1 from account_private.device_accounts a where a.id=any(prior_phone_accounts) order by a.id for update;
      -- Validate the complete set before any destructive mutation.
      if exists(select 1 from unnest(prior_phone_accounts) target(account_id)
        where not exists(select 1 from account_private.account_identities b
          where b.account_id=target.account_id and b.auth_user_id=uid
            and b.provider='phone' and b.identity_hash=ih)
          or (select count(*) from account_private.account_identities b where b.account_id=target.account_id)>3) then
        return jsonb_build_object('error','account_resolution_required');
      end if;
      foreach prior_account in array prior_phone_accounts loop
        select count(*) into social_methods from account_private.account_identities b
          where b.account_id=prior_account and b.provider in ('google','kakao');
        if social_methods=0 then
          -- No durable social proof exists: discard the old holder's app data,
          -- points and chats using the normal deletion/audit path.
          perform public.delete_account_data(prior_account);
          delete from account_private.device_accounts where id=prior_account;
        else
          -- Google/Kakao remain authoritative for the old account. Revoke only
          -- the recycled phone login and every app grant issued to that phone UID.
          delete from account_private.account_link_requests
            where account_id=prior_account and source_user=uid;
          delete from account_private.sessions where account_id=prior_account and user_id=uid;
          delete from account_private.account_identities
            where account_id=prior_account and auth_user_id=uid and provider='phone' and identity_hash=ih;
        end if;
      end loop;
    end if;
      insert into account_private.device_accounts(auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)$new$;
begin
  definition:=pg_get_functiondef('account_private.authorize_identity(text,text,text,text)'::regprocedure);
  if position(old_declaration in definition)=0 then raise exception 'authorize_identity_declaration_missing'; end if;
  definition:=replace(definition,old_declaration,new_declaration);
  if position(insertion_point in definition)=0 then raise exception 'phone_transfer_insertion_point_missing'; end if;
  execute replace(definition,insertion_point,transfer_block);
end $migration$;

notify pgrst,'reload schema';

begin;
create or replace function account_private.retire_phone_identity(target_account uuid,expected_hash text,reason text)
returns void language plpgsql security definer set search_path='' as $$
declare old_identity account_private.account_identities;
  current_auth_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
begin
  select * into old_identity
  from account_private.account_identities
  where account_id=target_account and provider='phone' and identity_hash=expected_hash
  for update;
  if old_identity.account_id is null then return; end if;

  insert into account_private.phone_identity_history(account_id,auth_user_id,identity_hash,retired_reason)
  values(old_identity.account_id,old_identity.auth_user_id,old_identity.identity_hash,reason);
  delete from public.push_tokens p using account_private.sessions old_session
    where p.auth_session_id=old_session.session_id
      and old_session.account_id=target_account
      and old_session.user_id=old_identity.auth_user_id;
  delete from account_private.account_link_requests
    where account_id=target_account and source_user=old_identity.auth_user_id;
  delete from account_private.sessions
    where account_id=target_account and user_id=old_identity.auth_user_id;
  delete from account_private.account_identities
    where account_id=target_account and provider='phone' and identity_hash=expected_hash;
  -- Keep only the freshly verified OTP transport session when a recycled
  -- number maps to the same Supabase Auth user.  A different old phone user,
  -- or an administrative cleanup without a request JWT, loses every session.
  delete from auth.sessions
    where user_id=old_identity.auth_user_id and id is distinct from current_auth_session;
end; $$;
revoke all on function account_private.retire_phone_identity(uuid,text,text) from public,anon,authenticated;
grant execute on function account_private.retire_phone_identity(uuid,text,text) to service_role;
commit;

begin;

-- Preserve the exact-pair resolver and wrap it with the global ownership
-- transition required by a newly verified OTP. The existing advisory lock is
-- transaction-scoped, so resolver writes and retirement remain atomic.
alter function account_private.authorize_phone_device_pair(text,text,text)
  rename to authorize_phone_device_pair_202609020010;

create function account_private.authorize_phone_device_pair(
  device_secret text,device_platform text,reinstall_identifier text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
  ih text;
  selected_account uuid;
  recovery_account uuid;
  previous_candidates integer:=0;
  previous_owner record;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('ingtalk-account-identity-mutations-v1',0));

  result:=account_private.authorize_phone_device_pair_202609020010(
    device_secret,device_platform,reinstall_identifier);

  -- A formerly detached exact pair may become current again only after a fresh
  -- OTP on that same device scope. Restore that one proven account, never an
  -- account selected by timestamp, balance, or login recency.
  if result->>'error'='account_link_unavailable'
      and account_private.fresh_identity('phone') then
    ih:=account_private.identity_hash(auth.uid(),'phone');
    select binding.account_id into recovery_account
    from account_private.phone_device_bindings binding
    where binding.device_scope_hash=account_private.device_scope(
        device_secret,device_platform,reinstall_identifier)
      and binding.phone_identity_hash=ih
    for update;
    if recovery_account is not null then
      perform 1 from account_private.device_accounts account_row
      where account_row.id in(
        select distinct identity_row.account_id
        from account_private.account_identities identity_row
        where identity_row.provider='phone' and identity_row.identity_hash=ih
        union select recovery_account)
      order by account_row.id for update;
      for previous_owner in
        select distinct identity_row.account_id
        from account_private.account_identities identity_row
        where identity_row.provider='phone' and identity_row.identity_hash=ih
          and identity_row.account_id<>recovery_account
        order by identity_row.account_id
      loop
        perform account_private.retire_phone_identity(
          previous_owner.account_id,ih,'return_to_known_device');
      end loop;
      insert into account_private.account_identities(
        account_id,auth_user_id,provider,identity_hash)
      select recovery_account,auth.uid(),'phone',ih
      where not exists(select 1 from account_private.account_identities identity_row
        where identity_row.account_id=recovery_account and identity_row.provider='phone'
          and identity_row.identity_hash=ih);
      result:=account_private.authorize_phone_device_pair_202609020010(
        device_secret,device_platform,reinstall_identifier);
    end if;
  end if;
  if not coalesce((result->>'ok')::boolean,false) then return result; end if;

  ih:=account_private.identity_hash(auth.uid(),'phone');
  selected_account:=(result->>'account_id')::uuid;
  if ih is null or selected_account is null then
    raise exception 'phone_owner_transition_invalid';
  end if;

  -- Existing ambiguous production groups are not repaired merely because the
  -- app refreshes an old session. A fresh OTP is the authoritative event that
  -- may select its resulting exact-pair account as the new current owner.
  if account_private.fresh_identity('phone') then
    select count(distinct identity_row.account_id) into previous_candidates
    from account_private.account_identities identity_row
    where identity_row.provider='phone' and identity_row.identity_hash=ih;

    perform 1 from account_private.device_accounts account_row
    where account_row.id in(
      select distinct identity_row.account_id
      from account_private.account_identities identity_row
      where identity_row.provider='phone' and identity_row.identity_hash=ih)
    order by account_row.id for update;

    if previous_candidates>1 then
      insert into account_private.phone_identity_conflicts(
        identity_hash,candidate_count,detected_at,resolved_at,resolution_note)
      values(ih,previous_candidates,now(),null,null)
      on conflict(identity_hash) do update set
        candidate_count=excluded.candidate_count,
        resolved_at=null,
        resolution_note=null;
    end if;

    for previous_owner in
      select distinct identity_row.account_id
      from account_private.account_identities identity_row
      where identity_row.provider='phone' and identity_row.identity_hash=ih
        and identity_row.account_id<>selected_account
      order by identity_row.account_id
    loop
      perform account_private.retire_phone_identity(
        previous_owner.account_id,ih,'new_device_phone_reassignment');
    end loop;

    if (select count(distinct identity_row.account_id)
        from account_private.account_identities identity_row
        where identity_row.provider='phone' and identity_row.identity_hash=ih)<>1
      or not exists(select 1 from account_private.account_identities identity_row
        where identity_row.provider='phone' and identity_row.identity_hash=ih
          and identity_row.account_id=selected_account) then
      raise exception 'phone_owner_transition_incomplete';
    end if;

    update account_private.phone_identity_conflicts
      set resolved_at=now(),resolution_note='resolved_by_fresh_verified_phone_transition'
      where identity_hash=ih and resolved_at is null;
  end if;

  return result;
end $$;

revoke all on function account_private.authorize_phone_device_pair_202609020010(
  text,text,text),account_private.authorize_phone_device_pair(text,text,text)
  from public,anon,authenticated;
grant execute on function account_private.authorize_phone_device_pair_202609020010(
  text,text,text),account_private.authorize_phone_device_pair(text,text,text)
  to service_role;

-- Existing ambiguous rows are recorded but deliberately left untouched. A
-- deferred guard prevents any future transaction from committing a new phone
-- hash with more than one canonical owner while allowing the wrapper to insert
-- B and retire A inside the same transaction.
insert into account_private.phone_identity_conflicts(
  identity_hash,candidate_count,detected_at,resolved_at,resolution_note)
select identity_row.identity_hash,count(distinct identity_row.account_id)::integer,
  now(),null,null
from account_private.account_identities identity_row
where identity_row.provider='phone'
group by identity_row.identity_hash
having count(distinct identity_row.account_id)>1
on conflict(identity_hash) do update set
  candidate_count=excluded.candidate_count,
  resolved_at=null,
  resolution_note=null;

create function account_private.enforce_single_phone_owner_deferred()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from account_private.account_identities identity_row
      where identity_row.provider='phone'
        and identity_row.identity_hash=new.identity_hash
      group by identity_row.identity_hash
      having count(distinct identity_row.account_id)>1) then
    raise exception 'phone_identity_conflict';
  end if;
  return null;
end $$;

revoke all on function account_private.enforce_single_phone_owner_deferred()
  from public,anon,authenticated;

create constraint trigger enforce_single_phone_owner_deferred
after insert or update of account_id,identity_hash,provider
on account_private.account_identities
deferrable initially deferred
for each row when (new.provider='phone')
execute function account_private.enforce_single_phone_owner_deferred();

notify pgrst,'reload schema';
commit;

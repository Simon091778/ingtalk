begin;

-- A merged canonical account can own several device-scoped phone pairs. Social
-- providers still have one portable subject per provider and account.
alter table account_private.account_identities drop constraint account_identities_pkey;
alter table account_private.account_identities
  add constraint account_identities_pkey primary key(account_id,provider,identity_hash);
create unique index account_identities_one_social_provider_per_account
  on account_private.account_identities(account_id,provider)
  where provider in ('google','kakao');

do $migration$
declare
  definition text:=pg_get_functiondef(
    'account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)'::regprocedure);
  old_guard text:=$old$  if exists(select 1 from account_private.account_identities a
      join account_private.account_identities b on b.account_id=loser
        and (b.provider=a.provider or b.auth_user_id=a.auth_user_id)
      where a.account_id=survivor)
$old$;
  new_guard text:=$new$  if exists(select 1 from account_private.account_identities a
      join account_private.account_identities b on b.account_id=loser
        and ((b.provider=a.provider and b.provider<>'phone')
          or (b.auth_user_id=a.auth_user_id
            and not (b.provider='phone' and a.provider='phone'
              and b.identity_hash=a.identity_hash)))
      where a.account_id=survivor)
$new$;
  old_move text:=$old$  update account_private.account_identities set account_id=survivor where account_id=loser;$old$;
  new_move text:=$new$  delete from account_private.account_identities losing_identity
    using account_private.account_identities survivor_identity
    where losing_identity.account_id=loser and survivor_identity.account_id=survivor
      and losing_identity.provider='phone' and survivor_identity.provider='phone'
      and (losing_identity.identity_hash=survivor_identity.identity_hash
        or losing_identity.auth_user_id=survivor_identity.auth_user_id);
  update account_private.account_identities set account_id=survivor where account_id=loser;$new$;
begin
  if position(old_guard in definition)=0 then raise exception 'merge identity guard anchor not found'; end if;
  definition:=replace(definition,old_guard,new_guard);
  if position(old_move in definition)=0 then raise exception 'merge identity move anchor not found'; end if;
  execute replace(definition,old_move,new_move);
end $migration$;

commit;

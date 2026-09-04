begin;

do $migration$
declare
  definition text:=pg_get_functiondef(
    'account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)'::regprocedure);
  old_device_guard text:=$old$    or exists(select 1 from account_private.account_devices a
      join account_private.account_devices b on b.account_id=loser
        and (b.device_hash=a.device_hash or b.device_scope_hash=a.device_scope_hash)
      where a.account_id=survivor)
$old$;
  old_transfer text:=$old$  update account_private.phone_device_bindings set account_id=survivor where account_id=loser;
  update account_private.account_devices set is_primary=false where account_id=loser;
  update account_private.account_devices set account_id=survivor where account_id=loser;$old$;
  new_transfer text:=$new$  delete from account_private.phone_device_bindings losing_pair
    using account_private.phone_device_bindings survivor_pair
    where losing_pair.account_id=loser and survivor_pair.account_id=survivor
      and losing_pair.device_scope_hash=survivor_pair.device_scope_hash
      and losing_pair.phone_identity_hash=survivor_pair.phone_identity_hash;
  update account_private.phone_device_bindings set account_id=survivor where account_id=loser;
  delete from account_private.account_devices losing_device
    using account_private.account_devices survivor_device
    where losing_device.account_id=loser and survivor_device.account_id=survivor
      and (losing_device.device_hash=survivor_device.device_hash
        or losing_device.device_scope_hash=survivor_device.device_scope_hash);
  update account_private.account_devices set is_primary=false where account_id=loser;
  update account_private.account_devices set account_id=survivor where account_id=loser;$new$;
begin
  if position(old_device_guard in definition)=0 then
    raise exception 'merge device guard anchor not found';
  end if;
  definition:=replace(definition,old_device_guard,'');
  if position(old_transfer in definition)=0 then
    raise exception 'merge device transfer anchor not found';
  end if;
  execute replace(definition,old_transfer,new_transfer);
end $migration$;

commit;

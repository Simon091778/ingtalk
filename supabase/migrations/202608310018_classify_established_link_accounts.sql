begin;

create or replace function account_private.account_is_established(target_account uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles where id=target_account)
    or exists(select 1 from public.point_wallets where user_id=target_account)
    or exists(select 1 from public.point_transactions where user_id=target_account)
    or exists(select 1 from public.point_purchase_receipts where user_id=target_account)
    or exists(select 1 from public.conversation_cards where author_id=target_account)
    or exists(select 1 from public.messages where sender_id=target_account)
    or exists(select 1 from public.board_posts where author_id=target_account)
    or exists(select 1 from public.support_messages where sender_user_id=target_account)
$$;
revoke all on function account_private.account_is_established(uuid) from public,anon,authenticated;
grant execute on function account_private.account_is_established(uuid) to service_role;

do $$
declare
  definition text:=pg_get_functiondef('public.finish_account_link(text,text,text,text)'::regprocedure);
  old_guard text:=$old$if other_id is not null
      and account_private.phone_recovery_disposition(r.account_id)<>'discardable'
      and account_private.phone_recovery_disposition(other_id)<>'discardable' then
    return jsonb_build_object('error','account_link_conflict');
  end if;$old$;
  new_guard text:=$new$if other_id is not null
      and account_private.account_is_established(r.account_id)
      and account_private.account_is_established(other_id) then
    return jsonb_build_object('error','account_link_conflict');
  end if;$new$;
begin
  if position(old_guard in definition)=0 then
    raise exception 'finish_account_link established-account classifier anchor not found';
  end if;
  execute replace(definition,old_guard,new_guard);
end $$;

commit;

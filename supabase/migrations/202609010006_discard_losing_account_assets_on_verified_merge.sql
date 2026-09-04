begin;

-- A verified merge keeps the account that initiated the link. Only the higher
-- point balance and the verified authentication identities survive from the
-- other principal; its user-facing content is deliberately discarded.
create or replace function account_private.merge_verified_accounts(
  survivor uuid,loser uuid,source_session uuid,verified_session uuid,verified_provider text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  survivor_balance bigint:=0;
  loser_balance bigint:=0;
  final_balance bigint:=0;
  loser_ledger jsonb:='[]'::jsonb;
  counts jsonb;
begin
  if survivor is null or loser is null or survivor=loser
      or verified_provider not in ('phone','google','kakao') then
    raise exception 'invalid_verified_account_merge';
  end if;

  perform 1 from account_private.device_accounts
    where id in(survivor,loser) order by id for update;
  if (select count(*) from account_private.device_accounts where id in(survivor,loser))<>2 then
    raise exception 'account_merge_missing_principal';
  end if;

  -- Phone identities are device-scoped and may coexist. Portable social
  -- providers still have one slot per canonical account.
  if exists(select 1 from account_private.account_identities a
      join account_private.account_identities b on b.account_id=loser
        and ((b.provider=a.provider and b.provider<>'phone')
          or (b.auth_user_id=a.auth_user_id
            and not (b.provider='phone' and a.provider='phone'
              and b.identity_hash=a.identity_hash)))
      where a.account_id=survivor) then
    raise exception 'account_merge_asset_conflict';
  end if;

  perform 1 from public.point_wallets where user_id in(survivor,loser)
    order by user_id for update;
  select coalesce((select balance from public.point_wallets where user_id=survivor),0),
         coalesce((select balance from public.point_wallets where user_id=loser),0)
    into survivor_balance,loser_balance;
  final_balance:=greatest(survivor_balance,loser_balance);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'amount',amount,'reason',reason,'reference_id',reference_id,'created_at',created_at)
      order by id),'[]'::jsonb)
    into loser_ledger from public.point_transactions where user_id=loser;
  counts:=jsonb_build_object(
    'policy','discard_losing_assets',
    'posts',(select count(*) from public.board_posts where author_id=loser),
    'comments',(select count(*) from public.board_comments where author_id=loser),
    'messages',(select count(*) from public.messages where sender_id=loser),
    'purchases',(select count(*) from public.point_purchase_receipts where user_id=loser),
    'conversation_cards',(select count(*) from public.conversation_cards where author_id=loser),
    'open_chat_messages',(select count(*) from public.open_chat_messages where sender_user_id=loser));

  -- Preserve alias chains before retiring the losing principal.
  update account_private.account_recovery_aliases
    set canonical_account_id=survivor
    where canonical_account_id=loser and retired_account_id<>survivor;
  insert into account_private.account_recovery_aliases(
    retired_account_id,canonical_account_id,reason)
    values(loser,survivor,'verified_account_merge')
    on conflict(retired_account_id) do nothing;
  if exists(select 1 from account_private.account_recovery_aliases
      where retired_account_id=loser and canonical_account_id<>survivor) then
    raise exception 'account_merge_alias_conflict';
  end if;

  -- MAX, never SUM. The losing ledger is retained only in the private merge
  -- audit; the losing public wallet and transactions are removed below.
  perform account_private.preserve_higher_point_balance(loser,survivor);

  -- A room owned by the losing account is discarded unless the survivor is
  -- already a participant. In that exceptional case the room remains because
  -- it also contains survivor-owned state, but losing messages are removed.
  delete from public.chat_rooms room
    where room.request_id in(
      select request.id from public.chat_requests request
      join public.open_chat_rooms open_room on open_room.id=request.open_chat_room_id
      where open_room.owner_user_id=loser
        and not exists(select 1 from public.open_chat_participants participant
          where participant.room_id=open_room.id and participant.user_id=survivor));
  delete from public.chat_requests request
    using public.open_chat_rooms open_room
    where request.open_chat_room_id=open_room.id and open_room.owner_user_id=loser
      and not exists(select 1 from public.open_chat_participants participant
        where participant.room_id=open_room.id and participant.user_id=survivor);
  delete from public.open_chat_rooms open_room
    where open_room.owner_user_id=loser
      and not exists(select 1 from public.open_chat_participants participant
        where participant.room_id=open_room.id and participant.user_id=survivor);
  update public.open_chat_rooms open_room set owner_user_id=survivor
    where open_room.owner_user_id=loser;
  delete from public.open_chat_messages where sender_user_id=loser;

  -- Reuse the account-deletion path so conversations, posts, comments,
  -- discovery cards, support data, preferences and profile data are removed in
  -- their FK-safe order. Purchase identifiers remain only as detached,
  -- payload-scrubbed refund/idempotency tombstones.
  perform public.delete_account_data(loser);

  -- Losing sessions and endpoints are revoked. The freshly verified session is
  -- rebound to the survivor by finish_account_link after this helper returns.
  delete from public.push_tokens where user_id=loser
    or auth_session_id in(select session_id from account_private.sessions where account_id=loser);
  delete from auth.sessions where id in(
      select session_id from account_private.sessions where account_id=loser)
    and id<>verified_session;
  delete from account_private.sessions where account_id=loser;
  delete from account_private.account_link_requests where account_id=loser;

  -- Authentication continuity is technical identity state, not user content.
  -- Coalesce exact pairs/devices and attach the verified providers to survivor.
  delete from account_private.phone_device_bindings losing_pair
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
  update account_private.account_devices set account_id=survivor where account_id=loser;

  delete from account_private.account_identities losing_identity
    using account_private.account_identities survivor_identity
    where losing_identity.account_id=loser and survivor_identity.account_id=survivor
      and losing_identity.provider='phone' and survivor_identity.provider='phone'
      and (losing_identity.identity_hash=survivor_identity.identity_hash
        or losing_identity.auth_user_id=survivor_identity.auth_user_id);
  update account_private.account_identities set account_id=survivor where account_id=loser;

  insert into account_private.account_merge_audit(
    survivor_account_id,losing_account_id,source_session_id,verified_session_id,
    verified_provider,survivor_balance,losing_balance,merged_balance,
    losing_point_ledger,asset_counts)
  values(survivor,loser,source_session,verified_session,verified_provider,
    survivor_balance,loser_balance,final_balance,loser_ledger,counts);

  delete from account_private.device_accounts where id=loser;
  return jsonb_build_object('ok',true,'account_id',survivor,'merged',true,
    'merged_balance',final_balance);
end $$;

revoke all on function account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)
  to service_role;

notify pgrst,'reload schema';
commit;

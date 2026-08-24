-- Device-bound point recovery and a 30-day user-visible chat window.
-- Message backups are deliberately server-only and are removed only by an owner RPC.

create table if not exists public.device_point_wallets (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique check (device_hash ~ '^[0-9a-f]{64}$'),
  balance bigint not null default 0 check (balance >= 0),
  status text not null default 'active' check (status in ('active', 'restricted')),
  welcome_granted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.device_wallet_bindings (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.device_point_wallets(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  bound_at timestamptz not null default now(),
  released_at timestamptz,
  recovery_reason text not null default 'initial' check (recovery_reason in ('initial', 'reinstall', 'account_deleted'))
);

create unique index if not exists device_wallet_one_active_user_idx
  on public.device_wallet_bindings(wallet_id) where released_at is null;
create unique index if not exists device_user_one_active_wallet_idx
  on public.device_wallet_bindings(user_id) where released_at is null and user_id is not null;
create index if not exists device_wallet_bindings_user_idx
  on public.device_wallet_bindings(user_id, bound_at desc);

alter table public.device_point_wallets enable row level security;
alter table public.device_wallet_bindings enable row level security;
revoke all on public.device_point_wallets, public.device_wallet_bindings from public, anon, authenticated;

-- Keep the existing per-user wallet as an API-compatible cache. Every legitimate
-- mutation of an actively bound wallet is mirrored to the device wallet.
create or replace function public.sync_active_device_wallet_balance()
returns trigger language plpgsql security definer set search_path = public as $$
declare bound_wallet uuid; has_historical_binding boolean;
begin
  select binding.wallet_id into bound_wallet
  from public.device_wallet_bindings binding
  where binding.user_id = new.user_id and binding.released_at is null;

  if bound_wallet is not null then
    update public.device_point_wallets
    set balance = new.balance, updated_at = now(), last_seen_at = now()
    where id = bound_wallet;
    return new;
  end if;

  select exists (
    select 1 from public.device_wallet_bindings binding where binding.user_id = new.user_id
  ) into has_historical_binding;
  if has_historical_binding then raise exception 'inactive_device_wallet_binding'; end if;
  return new;
end;
$$;

drop trigger if exists sync_active_device_wallet_after_balance on public.point_wallets;
create trigger sync_active_device_wallet_after_balance
after update of balance on public.point_wallets
for each row execute function public.sync_active_device_wallet_balance();

-- Called immediately after anonymous sign-in. If this installation belongs to a
-- previously bound device, migrate the recoverable identity to the fresh auth UUID.
create or replace function public.restore_device_account(device_fingerprint text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  normalized_hash text := lower(trim(coalesce(device_fingerprint, '')));
  wallet public.device_point_wallets;
  previous_user uuid;
  target_user_uuid uuid := auth.uid();
  restored_profile jsonb;
begin
  if target_user_uuid is null then raise exception 'authentication_required'; end if;
  if normalized_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_device_fingerprint'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized_hash, 0));

  select * into wallet from public.device_point_wallets where device_hash = normalized_hash for update;
  if wallet.id is null then return jsonb_build_object('recovered', false); end if;
  if wallet.status <> 'active' then raise exception 'device_wallet_restricted'; end if;

  select binding.user_id into previous_user
  from public.device_wallet_bindings binding
  where binding.wallet_id = wallet.id and binding.released_at is null
  for update;

  update public.device_point_wallets set last_seen_at = now() where id = wallet.id;
  if previous_user is null or previous_user = target_user_uuid then
    return jsonb_build_object('recovered', false);
  end if;
  if not exists (select 1 from public.profiles where id = previous_user) then
    update public.device_wallet_bindings set released_at = now(), recovery_reason = 'account_deleted'
    where wallet_id = wallet.id and released_at is null;
    return jsonb_build_object('recovered', false, 'balance_available', wallet.balance);
  end if;
  if exists (select 1 from public.profiles where id = target_user_uuid) then
    raise exception 'recovery_target_already_has_profile';
  end if;

  insert into public.profiles (
    id, nickname, birth_year, region_code, introduction, trust_score, is_verified,
    status, created_at, updated_at, gender, interests, avatar_url,
    suspended_until, suspension_reason, welcome_points_claimed
  )
  select target_user_uuid, nickname, birth_year, region_code, introduction, trust_score, is_verified,
    status, created_at, now(), gender, interests, avatar_url,
    suspended_until, suspension_reason, true
  from public.profiles where id = previous_user;

  -- Move chat identity so the most recent 30 days remain usable after reinstall.
  update public.chat_members set user_id = target_user_uuid where user_id = previous_user;
  update public.messages set sender_id = target_user_uuid where sender_id = previous_user;
  update public.chat_requests set sender_id = target_user_uuid where sender_id = previous_user;
  update public.chat_requests set receiver_id = target_user_uuid where receiver_id = previous_user;
  update public.chat_rooms set board_sender_id = target_user_uuid where board_sender_id = previous_user;
  update public.chat_rooms set board_receiver_id = target_user_uuid where board_receiver_id = previous_user;
  update public.reports set reporter_id = target_user_uuid where reporter_id = previous_user;
  update public.reports set reported_user_id = target_user_uuid where reported_user_id = previous_user;

  -- Preserve the rest of the anonymous profile so the user sees the same account.
  update public.conversation_cards set author_id = target_user_uuid where author_id = previous_user;
  update public.board_posts set author_id = target_user_uuid where author_id = previous_user;
  update public.board_comments set author_id = target_user_uuid where author_id = previous_user;
  update public.board_post_likes set user_id = target_user_uuid where user_id = previous_user;
  update public.user_locations set user_id = target_user_uuid where user_id = previous_user;
  update public.push_notifications set user_id = target_user_uuid where user_id = previous_user;
  delete from public.push_tokens where user_id = target_user_uuid;
  update public.push_tokens set user_id = target_user_uuid where user_id = previous_user;

  insert into public.blocks(blocker_id, blocked_id, created_at)
  select case when blocker_id = previous_user then target_user_uuid else blocker_id end,
         case when blocked_id = previous_user then target_user_uuid else blocked_id end,
         created_at
  from public.blocks
  where block.blocker_id = previous_user or block.blocked_id = previous_user
  on conflict do nothing;
  delete from public.blocks block
  where block.blocker_id = previous_user or block.blocked_id = previous_user;

  update public.point_transactions set user_id = target_user_uuid where user_id = previous_user;
  update public.point_reward_claims set user_id = target_user_uuid where user_id = previous_user;
  update public.point_wallets set balance = wallet.balance, updated_at = now() where user_id = target_user_uuid;
  delete from public.point_wallets where user_id = previous_user;

  update public.device_wallet_bindings
  set released_at = now(), recovery_reason = 'reinstall'
  where wallet_id = wallet.id and released_at is null;
  insert into public.device_wallet_bindings(wallet_id, user_id, recovery_reason)
  values (wallet.id, target_user_uuid, 'reinstall');

  update public.moderation_actions set target_user_id = target_user_uuid where target_user_id = previous_user;
  delete from public.profiles where id = previous_user;

  select jsonb_build_object(
    'nickname', profile.nickname,
    'birth_year', profile.birth_year,
    'gender', profile.gender,
    'interests', profile.interests,
    'avatar_url', profile.avatar_url
  ) into restored_profile from public.profiles profile where profile.id = target_user_uuid;

  return jsonb_build_object('recovered', true, 'balance', wallet.balance, 'profile', restored_profile);
end;
$$;

-- Upgrade the existing claim RPC: first use creates the device wallet and grants
-- welcome points once; later uses bind the current anonymous account to that wallet.
create or replace function public.claim_device_welcome_points(device_fingerprint text)
returns table (awarded boolean, balance bigint)
language plpgsql security definer set search_path = public as $$
declare
  normalized_hash text := lower(trim(coalesce(device_fingerprint, '')));
  wallet_uuid uuid;
  wallet_balance bigint;
  inserted_count integer := 0;
  profile_already_claimed boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if normalized_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_device_fingerprint'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'profile_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized_hash, 0));
  select welcome_points_claimed into profile_already_claimed
  from public.profiles where id = auth.uid() for update;

  select id, device_point_wallets.balance into wallet_uuid, wallet_balance
  from public.device_point_wallets where device_hash = normalized_hash for update;

  if wallet_uuid is null then
    insert into public.device_welcome_grants(device_hash) values (normalized_hash)
    on conflict (device_hash) do nothing;
    get diagnostics inserted_count = row_count;
    wallet_balance := coalesce((select balance from public.point_wallets where user_id = auth.uid()), 0);
    if inserted_count = 1 and not profile_already_claimed then wallet_balance := wallet_balance + 1000; end if;
    insert into public.device_point_wallets(device_hash, balance, welcome_granted_at)
    values (normalized_hash, wallet_balance, case when inserted_count = 1 and not profile_already_claimed then now() end)
    returning id into wallet_uuid;
    if inserted_count = 1 and not profile_already_claimed then
      insert into public.point_transactions(user_id, amount, reason)
      values (auth.uid(), 1000, 'welcome_device');
    end if;
  else
    update public.device_point_wallets set last_seen_at = now() where id = wallet_uuid;
  end if;

  if exists (select 1 from public.device_wallet_bindings where wallet_id = wallet_uuid and released_at is null and user_id <> auth.uid()) then
    raise exception 'device_account_recovery_required';
  end if;
  insert into public.device_wallet_bindings(wallet_id, user_id, recovery_reason)
  select wallet_uuid, auth.uid(), 'initial'
  where not exists (select 1 from public.device_wallet_bindings where wallet_id = wallet_uuid and released_at is null);

  update public.point_wallets set balance = wallet_balance, updated_at = now() where user_id = auth.uid();
  update public.profiles set welcome_points_claimed = true, updated_at = now() where id = auth.uid();
  update public.device_welcome_grants set last_seen_at = now() where device_hash = normalized_hash;
  return query select inserted_count = 1 and not profile_already_claimed, wallet_balance;
end;
$$;

-- Immutable-by-default server backup. No app or ordinary operator receives table access.
create table if not exists public.message_backups (
  original_message_id bigint primary key,
  room_id uuid not null,
  sender_id uuid not null,
  body text not null,
  moderation_state text not null,
  message_created_at timestamptz not null,
  backed_up_at timestamptz not null default now()
);
create index if not exists message_backups_room_created_idx
  on public.message_backups(room_id, message_created_at desc);
alter table public.message_backups enable row level security;
revoke all on public.message_backups from public, anon, authenticated;

create or replace function public.backup_chat_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.message_backups(
    original_message_id, room_id, sender_id, body, moderation_state, message_created_at
  ) values (new.id, new.room_id, new.sender_id, new.body, new.moderation_state, new.created_at)
  on conflict (original_message_id) do nothing;
  return new;
end;
$$;
drop trigger if exists backup_chat_message_after_insert on public.messages;
create trigger backup_chat_message_after_insert after insert on public.messages
for each row execute function public.backup_chat_message();

insert into public.message_backups(original_message_id, room_id, sender_id, body, moderation_state, message_created_at)
select id, room_id, sender_id, body, moderation_state, created_at from public.messages
on conflict (original_message_id) do nothing;

-- Users can read only the rolling 30-day window. The backup remains unaffected.
drop policy if exists "members read messages" on public.messages;
create policy "members read recent messages" on public.messages for select to authenticated
using (public.is_room_member(room_id) and created_at >= now() - interval '30 days');

drop function if exists public.my_chat_rooms();
create function public.my_chat_rooms()
returns table (
  room_id uuid, other_user_id uuid, other_nickname text, other_board_alias text,
  other_avatar_url text, other_gender text, other_birth_year integer,
  last_message text, last_message_at timestamptz, unread_count bigint
)
language sql stable security definer set search_path = public as $$
  select room.id, other_member.user_id, other_profile.nickname,
    case when room.board_sender_id = other_member.user_id then room.board_sender_alias
         when room.board_receiver_id = other_member.user_id then room.board_receiver_alias end,
    other_profile.avatar_url, other_profile.gender, other_profile.birth_year, last_msg.body,
    coalesce(last_msg.created_at, room.created_at),
    (select count(*) from public.messages unread where unread.room_id = room.id
      and unread.sender_id <> auth.uid()
      and unread.created_at >= now() - interval '30 days'
      and unread.created_at > coalesce(mine.last_read_at, room.created_at)
      and unread.moderation_state = 'visible')
  from public.chat_rooms room
  join public.chat_members mine on mine.room_id = room.id and mine.user_id = auth.uid() and mine.hidden_at is null
  join public.chat_members other_member on other_member.room_id = room.id and other_member.user_id <> auth.uid()
  join public.profiles other_profile on other_profile.id = other_member.user_id
  left join lateral (select body, created_at from public.messages latest where latest.room_id = room.id
    and latest.created_at >= now() - interval '30 days'
    and latest.moderation_state = 'visible' order by latest.created_at desc limit 1) last_msg on true
  where room.closed_at is null and not exists (select 1 from public.blocks block
    where (block.blocker_id = auth.uid() and block.blocked_id = other_member.user_id)
       or (block.blocker_id = other_member.user_id and block.blocked_id = auth.uid()))
  order by coalesce(last_msg.created_at, room.created_at) desc;
$$;

create or replace function public.admin_delete_message_backups(
  message_ids bigint[], deletion_reason text
)
returns integer language plpgsql security definer set search_path = public as $$
declare deleted_count integer; live_deleted integer;
begin
  if not public.admin_has_role('owner') then raise exception 'owner_required'; end if;
  if coalesce(array_length(message_ids, 1), 0) not between 1 and 500 then raise exception 'invalid_message_ids'; end if;
  if char_length(trim(coalesce(deletion_reason, ''))) not between 2 and 500 then raise exception 'deletion_reason_required'; end if;

  delete from public.messages where id = any(message_ids);
  get diagnostics live_deleted = row_count;
  delete from public.message_backups where original_message_id = any(message_ids);
  get diagnostics deleted_count = row_count;
  insert into public.moderation_actions(admin_user_id, action, note, before_state, after_state)
  values (auth.uid(), 'delete_message_backup', trim(deletion_reason),
    jsonb_build_object('requested_ids', message_ids),
    jsonb_build_object('live_deleted', live_deleted, 'backup_deleted', deleted_count));
  return deleted_count;
end;
$$;

revoke all on function public.restore_device_account(text) from public, anon, authenticated;
revoke all on function public.claim_device_welcome_points(text) from public, anon, authenticated;
revoke all on function public.sync_active_device_wallet_balance() from public, anon, authenticated;
revoke all on function public.backup_chat_message() from public, anon, authenticated;
revoke all on function public.my_chat_rooms() from public, anon, authenticated;
revoke all on function public.admin_delete_message_backups(bigint[], text) from public, anon, authenticated;
grant execute on function public.restore_device_account(text) to authenticated;
grant execute on function public.claim_device_welcome_points(text) to authenticated;
grant execute on function public.my_chat_rooms() to authenticated;
grant execute on function public.admin_delete_message_backups(bigint[], text) to authenticated;

notify pgrst, 'reload schema';

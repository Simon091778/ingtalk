-- Point wallet: 1,000 welcome points and a 100 point charge per successful chat request.

create table if not exists public.point_wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance bigint not null default 1000 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount bigint not null check (amount <> 0),
  reason text not null,
  reference_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, reason, reference_id)
);

alter table public.point_wallets enable row level security;
alter table public.point_transactions enable row level security;
drop policy if exists "users read own point wallet" on public.point_wallets;
create policy "users read own point wallet" on public.point_wallets for select to authenticated using (user_id = auth.uid());
drop policy if exists "users read own point transactions" on public.point_transactions;
create policy "users read own point transactions" on public.point_transactions for select to authenticated using (user_id = auth.uid());
revoke all on public.point_wallets, public.point_transactions from authenticated;
grant select on public.point_wallets, public.point_transactions to authenticated;

insert into public.point_wallets(user_id, balance)
select id, 1000 from public.profiles
on conflict (user_id) do nothing;

create or replace function public.create_point_wallet_for_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.point_wallets(user_id, balance) values (new.id, 1000)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_point_wallet on public.profiles;
create trigger create_profile_point_wallet after insert on public.profiles
for each row execute function public.create_point_wallet_for_profile();

create or replace function public.my_point_balance()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select balance from public.point_wallets where user_id = auth.uid()), 0);
$$;
revoke all on function public.my_point_balance() from public;
grant execute on function public.my_point_balance() to authenticated;

create or replace function public.create_chat_request(card_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_card public.conversation_cards; request_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then raise exception 'opening_message_length'; end if;
  select * into target_card from public.conversation_cards where id = card_uuid and is_active and expires_at > now();
  if target_card.id is null then raise exception 'card_not_available'; end if;
  if target_card.author_id = auth.uid() then raise exception 'cannot_request_self'; end if;
  if exists (select 1 from public.blocks where (blocker_id = auth.uid() and blocked_id = target_card.author_id) or (blocker_id = target_card.author_id and blocked_id = auth.uid())) then raise exception 'users_blocked'; end if;

  insert into public.chat_requests(card_id, sender_id, receiver_id, opening_message)
  values (card_uuid, auth.uid(), target_card.author_id, trim(opening_text)) returning id into request_uuid;

  update public.point_wallets set balance = balance - 100, updated_at = now()
  where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), -100, 'chat_request', request_uuid);
  return request_uuid;
exception when unique_violation then raise exception 'request_already_exists';
end;
$$;
revoke all on function public.create_chat_request(uuid, text) from public;
grant execute on function public.create_chat_request(uuid, text) to authenticated;

create or replace function public.create_board_chat_request(post_uuid uuid, receiver_uuid uuid, opening_text text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target_post public.board_posts; request_uuid uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if char_length(trim(opening_text)) < 2 or char_length(trim(opening_text)) > 200 then raise exception 'opening_message_length'; end if;
  if receiver_uuid = auth.uid() then raise exception 'cannot_request_self'; end if;
  select * into target_post from public.board_posts where id = post_uuid;
  if target_post.id is null then raise exception 'post_not_available'; end if;
  if not exists (select 1 from public.profiles where id = receiver_uuid and status = 'active') then raise exception 'receiver_not_available'; end if;
  if receiver_uuid <> target_post.author_id and not exists (select 1 from public.board_comments where post_id = post_uuid and author_id = receiver_uuid) then raise exception 'receiver_not_in_post'; end if;
  if exists (select 1 from public.blocks where (blocker_id = auth.uid() and blocked_id = receiver_uuid) or (blocker_id = receiver_uuid and blocked_id = auth.uid())) then raise exception 'users_blocked'; end if;

  insert into public.chat_requests(card_id, board_post_id, source_topic, sender_id, receiver_id, opening_message)
  values (null, post_uuid, left(target_post.body, 120), auth.uid(), receiver_uuid, trim(opening_text)) returning id into request_uuid;

  update public.point_wallets set balance = balance - 100, updated_at = now()
  where user_id = auth.uid() and balance >= 100;
  if not found then raise exception 'insufficient_points'; end if;
  insert into public.point_transactions(user_id, amount, reason, reference_id)
  values (auth.uid(), -100, 'chat_request', request_uuid);
  return request_uuid;
exception when unique_violation then raise exception 'request_already_exists';
end;
$$;
revoke all on function public.create_board_chat_request(uuid, uuid, text) from public;
grant execute on function public.create_board_chat_request(uuid, uuid, text) to authenticated;
notify pgrst, 'reload schema';

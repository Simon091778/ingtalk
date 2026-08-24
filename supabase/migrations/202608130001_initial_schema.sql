create extension if not exists pgcrypto;

create type public.profile_status as enum ('active', 'paused', 'suspended', 'deleted');
create type public.request_status as enum ('pending', 'accepted', 'declined', 'cancelled');
create type public.report_status as enum ('open', 'reviewing', 'resolved', 'dismissed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 2 and 12),
  birth_year int not null check (birth_year between 1900 and extract(year from now())::int - 19),
  region_code text not null,
  introduction text not null default '' check (char_length(introduction) <= 300),
  trust_score int not null default 0 check (trust_score between 0 and 100),
  is_verified boolean not null default false,
  status public.profile_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_cards (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  purpose text not null check (purpose in ('수다', '취미 친구', '동네 친구', '연애', '고민 상담')),
  topic text not null check (char_length(topic) between 5 and 120),
  interests text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.chat_requests (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.conversation_cards(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  opening_message text not null check (char_length(opening_message) between 2 and 200),
  status public.request_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique(card_id, sender_id),
  check (sender_id <> receiver_id)
);

create table public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.chat_requests(id) on delete restrict,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table public.chat_members (
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (room_id, user_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 2000),
  moderation_state text not null default 'visible' check (moderation_state in ('visible', 'held', 'removed')),
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid references public.chat_rooms(id) on delete set null,
  message_id bigint references public.messages(id) on delete set null,
  reason text not null,
  details text not null default '' check (char_length(details) <= 1000),
  status public.report_status not null default 'open',
  created_at timestamptz not null default now(),
  check (reporter_id <> reported_user_id)
);

create index conversation_cards_feed_idx on public.conversation_cards (created_at desc) where is_active;
create index chat_requests_receiver_idx on public.chat_requests (receiver_id, status, created_at desc);
create index messages_room_idx on public.messages (room_id, created_at desc);
create index reports_status_idx on public.reports (status, created_at);

alter table public.profiles enable row level security;
alter table public.conversation_cards enable row level security;
alter table public.blocks enable row level security;
alter table public.chat_requests enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.reports enable row level security;

create policy "active profiles are discoverable" on public.profiles for select to authenticated
using (status = 'active' and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = id) or (b.blocker_id = id and b.blocked_id = auth.uid())));
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "safe active cards are discoverable" on public.conversation_cards for select to authenticated
using (is_active and expires_at > now() and not exists (select 1 from public.blocks b where (b.blocker_id = auth.uid() and b.blocked_id = author_id) or (b.blocker_id = author_id and b.blocked_id = auth.uid())));
create policy "users create own cards" on public.conversation_cards for insert to authenticated with check (author_id = auth.uid());
create policy "users update own cards" on public.conversation_cards for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy "users manage own blocks" on public.blocks for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());
create policy "request participants read" on public.chat_requests for select to authenticated using (auth.uid() in (sender_id, receiver_id));
create policy "sender creates request" on public.chat_requests for insert to authenticated with check (sender_id = auth.uid() and receiver_id = (select author_id from public.conversation_cards where id = card_id));
create policy "receiver responds to request" on public.chat_requests for update to authenticated using (receiver_id = auth.uid()) with check (receiver_id = auth.uid());

create or replace function public.is_room_member(room_uuid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.chat_members where room_id = room_uuid and user_id = auth.uid());
$$;
revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;

create policy "room members read rooms" on public.chat_rooms for select to authenticated using (public.is_room_member(id));
create policy "members read memberships" on public.chat_members for select to authenticated using (public.is_room_member(room_id));
create policy "members read messages" on public.messages for select to authenticated using (public.is_room_member(room_id));
create policy "members send own messages" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_room_member(room_id));
create policy "users create reports" on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy "users read own reports" on public.reports for select to authenticated using (reporter_id = auth.uid());

create or replace function public.accept_chat_request(request_uuid uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare req public.chat_requests; new_room uuid;
begin
  select * into req from public.chat_requests where id = request_uuid for update;
  if req.receiver_id <> auth.uid() or req.status <> 'pending' then raise exception 'request_not_allowed'; end if;
  if exists (select 1 from public.blocks where (blocker_id = req.sender_id and blocked_id = req.receiver_id) or (blocker_id = req.receiver_id and blocked_id = req.sender_id)) then raise exception 'users_blocked'; end if;
  update public.chat_requests set status = 'accepted', responded_at = now() where id = request_uuid;
  insert into public.chat_rooms(request_id) values (request_uuid) returning id into new_room;
  insert into public.chat_members(room_id, user_id) values (new_room, req.sender_id), (new_room, req.receiver_id);
  return new_room;
end; $$;
revoke all on function public.accept_chat_request(uuid) from public;
grant execute on function public.accept_chat_request(uuid) to authenticated;

alter publication supabase_realtime add table public.messages;

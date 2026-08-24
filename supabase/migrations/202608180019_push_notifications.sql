-- Device push tokens and server-generated chat notification events.

create table if not exists public.push_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null check (token like 'ExponentPushToken[%'),
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, token)
);

create index if not exists push_tokens_user_idx on public.push_tokens(user_id);
alter table public.push_tokens enable row level security;
grant select, insert, update, delete on public.push_tokens to authenticated;
grant usage, select on sequence public.push_tokens_id_seq to authenticated;

drop policy if exists "users manage own push tokens" on public.push_tokens;
create policy "users manage own push tokens"
on public.push_tokens for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create table if not exists public.push_notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists push_notifications_user_idx on public.push_notifications(user_id, created_at desc);
alter table public.push_notifications enable row level security;
revoke all on public.push_notifications from anon, authenticated;

create or replace function public.enqueue_chat_request_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare sender_name text;
begin
  select nickname into sender_name from public.profiles where id = new.sender_id;
  insert into public.push_notifications(user_id, title, body, data)
  values (
    new.receiver_id,
    '새 대화 신청',
    coalesce(sender_name, '상대방') || '님이 대화를 신청했어요.',
    jsonb_build_object('kind', 'chat_request', 'request_id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists chat_request_push_trigger on public.chat_requests;
create trigger chat_request_push_trigger
after insert on public.chat_requests
for each row execute function public.enqueue_chat_request_push();

create or replace function public.enqueue_message_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sender_name text;
  room_created_at timestamptz;
  opening_text text;
begin
  select p.nickname into sender_name from public.profiles p where p.id = new.sender_id;
  select r.created_at, q.opening_message into room_created_at, opening_text
  from public.chat_rooms r
  join public.chat_requests q on q.id = r.request_id
  where r.id = new.room_id;

  -- 수락 과정에서 복사되는 최초 신청 문구는 이미 신청 알림을 보냈으므로 중복 발송하지 않습니다.
  if new.created_at <= room_created_at + interval '10 seconds' and new.body = opening_text then
    return new;
  end if;

  insert into public.push_notifications(user_id, title, body, data)
  select
    m.user_id,
    coalesce(sender_name, '상대방'),
    left(new.body, 120),
    jsonb_build_object('kind', 'message', 'room_id', new.room_id, 'message_id', new.id)
  from public.chat_members m
  where m.room_id = new.room_id and m.user_id <> new.sender_id;
  return new;
end;
$$;

drop trigger if exists message_push_trigger on public.messages;
create trigger message_push_trigger
after insert on public.messages
for each row execute function public.enqueue_message_push();

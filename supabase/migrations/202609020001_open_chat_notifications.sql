begin;

alter table public.notification_preferences
  add column if not exists open_chat_enabled boolean not null default true;

create or replace function public.enqueue_open_chat_message_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sender_name text;
  room_title text;
  push_body text;
begin
  -- System lifecycle notices must not keep a room noisy or look like messages
  -- written by a participant.
  if new.message_type = 'system' or new.sender_user_id is null then
    return new;
  end if;

  select profile.nickname into sender_name
  from public.profiles profile
  where profile.id = new.sender_user_id;

  select room.title into room_title
  from public.open_chat_rooms room
  where room.id = new.room_id and room.status = 'active';

  if room_title is null then
    return new;
  end if;

  push_body := case new.message_type
    when 'audio' then coalesce(sender_name, '참여자') || '님이 음성 메시지를 보냈어요.'
    when 'image' then coalesce(sender_name, '참여자') || '님이 사진을 보냈어요.'
    else coalesce(sender_name, '참여자') || ': ' || left(coalesce(new.content, ''), 120)
  end;

  insert into public.push_notifications(user_id, title, body, data)
  select
    participant.user_id,
    room_title,
    push_body,
    jsonb_build_object(
      'kind', 'open_chat_message',
      'open_chat_room_id', new.room_id,
      'message_id', new.id
    )
  from public.open_chat_participants participant
  where participant.room_id = new.room_id
    and participant.user_id <> new.sender_user_id;

  return new;
end;
$$;

drop trigger if exists open_chat_message_push_trigger on public.open_chat_messages;
create trigger open_chat_message_push_trigger
after insert on public.open_chat_messages
for each row execute function public.enqueue_open_chat_message_push();

notify pgrst, 'reload schema';

commit;

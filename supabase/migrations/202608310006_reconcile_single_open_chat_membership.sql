-- Reconcile memberships created before the one-account/one-room rule and then
-- enforce the invariant with a database-native unique index. An owned room is
-- preferred as the membership to retain. If an account historically owned
-- several rooms, the most recently joined owned room is retained and normal
-- ownership succession is applied to the others.

do $$
declare
  account_row record;
  membership_row record;
  retained_room uuid;
  successor uuid;
begin
  for account_row in
    select user_id
    from public.open_chat_participants
    group by user_id
    having count(*) > 1
  loop
    select participant.room_id into retained_room
    from public.open_chat_participants participant
    join public.open_chat_rooms room on room.id = participant.room_id
    where participant.user_id = account_row.user_id
    order by (room.status = 'active' and room.owner_user_id = account_row.user_id) desc,
             participant.joined_at desc,
             participant.room_id
    limit 1;

    for membership_row in
      select participant.room_id, room.status, room.owner_user_id
      from public.open_chat_participants participant
      join public.open_chat_rooms room on room.id = participant.room_id
      where participant.user_id = account_row.user_id
        and participant.room_id <> retained_room
      order by participant.joined_at, participant.room_id
      for update of room
    loop
      if membership_row.status = 'active' and membership_row.owner_user_id = account_row.user_id then
        select participant.user_id into successor
        from public.open_chat_participants participant
        join public.profiles profile on profile.id = participant.user_id and profile.status = 'active'
        where participant.room_id = membership_row.room_id
          and participant.user_id <> account_row.user_id
          and not exists (
            select 1 from public.open_chat_room_bans ban
            where ban.room_id = membership_row.room_id and ban.user_id = participant.user_id
          )
        order by participant.joined_at, participant.user_id
        limit 1;

        if successor is null then
          update public.open_chat_rooms
          set status = 'closed', owner_user_id = null, closed_at = now(),
              closed_reason = 'empty_room', updated_at = now()
          where id = membership_row.room_id;
        else
          update public.open_chat_rooms
          set owner_user_id = successor, updated_at = now()
          where id = membership_row.room_id;
        end if;
      end if;

      delete from public.open_chat_participants
      where room_id = membership_row.room_id and user_id = account_row.user_id;
    end loop;
  end loop;
end $$;

drop trigger if exists enforce_single_open_chat_membership on public.open_chat_participants;
drop function if exists public.enforce_single_open_chat_membership();

create unique index open_chat_participants_one_room_per_user_idx
on public.open_chat_participants(user_id);

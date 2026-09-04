-- Operator controls for open chat and public user-generated content.

create or replace function public.admin_list_open_chat_rooms(
  search_text text default null,
  status_filter text default null,
  result_limit integer default 300
)
returns table (
  room_id uuid, title text, category text, room_status text,
  owner_user_id uuid, owner_nickname text, member_count bigint, max_members integer,
  message_count bigint, report_count bigint, created_at timestamptz,
  last_user_message_at timestamptz, inactivity_warning_at timestamptz,
  closed_at timestamptz, closed_reason text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare normalized_search text := left(trim(coalesce(search_text, '')), 100);
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if status_filter is not null and status_filter not in ('active', 'closed') then raise exception 'invalid_status_filter'; end if;
  return query
  select room.id, room.title, room.category, room.status,
    room.owner_user_id, owner.nickname,
    (select count(*) from public.open_chat_participants participant where participant.room_id=room.id),
    room.max_members,
    (select count(*) from public.open_chat_messages message where message.room_id=room.id),
    (select count(*) from public.reports report where report.open_chat_room_id=room.id),
    room.created_at, room.last_user_message_at, room.inactivity_warning_at,
    room.closed_at, room.closed_reason
  from public.open_chat_rooms room
  left join public.profiles owner on owner.id=room.owner_user_id
  where (status_filter is null or room.status=status_filter)
    and (normalized_search='' or room.id::text ilike '%'||normalized_search||'%'
      or room.title ilike '%'||normalized_search||'%'
      or coalesce(owner.nickname,'') ilike '%'||normalized_search||'%'
      or coalesce(room.owner_user_id::text,'') ilike '%'||normalized_search||'%')
  order by case when room.status='active' then 0 else 1 end,
    coalesce(room.last_user_message_at,room.created_at) desc
  limit least(greatest(coalesce(result_limit,300),1),1000);
end; $$;

create or replace function public.admin_get_open_chat_room(target_room_uuid uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if not exists(select 1 from public.open_chat_rooms where id=target_room_uuid) then raise exception 'room_not_found'; end if;
  select jsonb_build_object(
    'room',(select to_jsonb(x) from (
      select room.id,room.title,room.description,room.notice,room.category,room.region,room.tags,
        room.status,room.owner_user_id,owner.nickname owner_nickname,room.max_members,
        room.created_at,room.updated_at,room.last_user_message_at,room.inactivity_warning_at,
        room.closed_at,room.closed_reason,room.cover_storage_path
      from public.open_chat_rooms room left join public.profiles owner on owner.id=room.owner_user_id
      where room.id=target_room_uuid
    ) x),
    'participants',coalesce((select jsonb_agg(to_jsonb(x) order by x.is_owner desc,x.joined_at) from (
      select participant.user_id,profile.nickname,profile.status::text account_status,
        participant.joined_at,room.owner_user_id=participant.user_id is_owner
      from public.open_chat_participants participant
      join public.profiles profile on profile.id=participant.user_id
      join public.open_chat_rooms room on room.id=participant.room_id
      where participant.room_id=target_room_uuid
    ) x),'[]'::jsonb),
    'bans',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
      select ban.user_id,profile.nickname,ban.created_at
      from public.open_chat_room_bans ban left join public.profiles profile on profile.id=ban.user_id
      where ban.room_id=target_room_uuid
    ) x),'[]'::jsonb),
    'messages',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from (
      select message.id,message.sender_user_id,profile.nickname sender_nickname,message.message_type,
        message.content,message.audio_storage_path,message.audio_duration_ms,
        message.image_storage_path,message.image_width,message.image_height,
        message.reply_to_message_id,message.created_at,
        (select count(*) from public.reports report where report.open_chat_message_id=message.id) report_count
      from public.open_chat_messages message left join public.profiles profile on profile.id=message.sender_user_id
      where message.room_id=target_room_uuid order by message.created_at desc limit 500
    ) x),'[]'::jsonb)
  ) into result;
  return result;
end; $$;

create or replace function public.admin_close_open_chat_room(target_room_uuid uuid,admin_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare target public.open_chat_rooms;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  select * into target from public.open_chat_rooms where id=target_room_uuid for update;
  if not found then raise exception 'room_not_found'; end if;
  if target.status<>'active' then raise exception 'room_not_active'; end if;
  insert into public.open_chat_messages(room_id,message_type,content)
  values(target_room_uuid,'system','운영 정책에 따라 수다방이 종료되었습니다.');
  update public.open_chat_rooms set status='closed',owner_user_id=null,closed_at=now(),
    closed_reason='admin_closed',updated_at=now() where id=target_room_uuid;
  delete from public.open_chat_participants where room_id=target_room_uuid;
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target.owner_user_id,'close_open_chat_room',trim(admin_note),
    jsonb_build_object('room_id',target.id,'title',target.title,'status',target.status),
    jsonb_build_object('room_id',target.id,'status','closed','closed_reason','admin_closed'));
end; $$;

create or replace function public.admin_remove_open_chat_member(
  target_room_uuid uuid,target_user_uuid uuid,block_reentry boolean,admin_note text
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare target public.open_chat_rooms; member_name text;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  select * into target from public.open_chat_rooms where id=target_room_uuid for update;
  if not found or target.status<>'active' then raise exception 'room_not_active'; end if;
  if target.owner_user_id=target_user_uuid then raise exception 'cannot_remove_room_owner'; end if;
  select profile.nickname into member_name from public.open_chat_participants participant
    join public.profiles profile on profile.id=participant.user_id
    where participant.room_id=target_room_uuid and participant.user_id=target_user_uuid;
  if not found then raise exception 'not_room_member'; end if;
  if block_reentry then
    insert into public.open_chat_room_bans(room_id,user_id,banned_by)
    values(target_room_uuid,target_user_uuid,null) on conflict(room_id,user_id) do nothing;
  end if;
  delete from public.open_chat_participants where room_id=target_room_uuid and user_id=target_user_uuid;
  insert into public.open_chat_messages(room_id,message_type,content)
  values(target_room_uuid,'system',member_name||'님이 운영자에 의해 퇴장되었습니다.');
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target_user_uuid,case when block_reentry then 'ban_open_chat_member' else 'remove_open_chat_member' end,
    trim(admin_note),jsonb_build_object('room_id',target_room_uuid,'member',true),
    jsonb_build_object('room_id',target_room_uuid,'member',false,'banned',block_reentry));
end; $$;

create or replace function public.admin_unban_open_chat_member(
  target_room_uuid uuid,target_user_uuid uuid,admin_note text
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  delete from public.open_chat_room_bans where room_id=target_room_uuid and user_id=target_user_uuid;
  if not found then raise exception 'ban_not_found'; end if;
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target_user_uuid,'unban_open_chat_member',trim(admin_note),
    jsonb_build_object('room_id',target_room_uuid,'banned',true),
    jsonb_build_object('room_id',target_room_uuid,'banned',false));
end; $$;

create or replace function public.admin_delete_open_chat_message(target_message_id bigint,admin_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare target public.open_chat_messages;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  select * into target from public.open_chat_messages where id=target_message_id for update;
  if not found then raise exception 'message_not_found'; end if;
  if target.message_type='system' then raise exception 'cannot_delete_system_message'; end if;
  delete from public.open_chat_messages where id=target_message_id;
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target.sender_user_id,'delete_open_chat_message',trim(admin_note),
    jsonb_build_object('room_id',target.room_id,'message_id',target.id,'message_type',target.message_type,
      'content',target.content,'audio_storage_path',target.audio_storage_path,'image_storage_path',target.image_storage_path),
    jsonb_build_object('room_id',target.room_id,'message_id',target.id,'deleted',true));
end; $$;

create or replace function public.admin_list_public_content(
  content_filter text default null,search_text text default null,status_filter text default null,result_limit integer default 300
)
returns table(content_kind text,content_id uuid,author_id uuid,author_nickname text,title text,body text,
  content_status text,country_code text,created_at timestamptz,expires_at timestamptz,
  comment_count bigint,report_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare normalized_search text:=left(trim(coalesce(search_text,'')),100);
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  if content_filter is not null and content_filter not in ('talk','post') then raise exception 'invalid_content_filter'; end if;
  if status_filter is not null and status_filter not in ('active','inactive') then raise exception 'invalid_status_filter'; end if;
  return query
  select * from (
    select 'talk'::text,card.id,card.author_id,profile.nickname,card.purpose,card.topic,
      case when card.is_active and card.expires_at>now() then 'active' else 'inactive' end,
      card.country_group,card.created_at,card.expires_at,0::bigint,
      (select count(*) from public.reports report where report.target_type='card' and report.reported_user_id=card.author_id)
    from public.conversation_cards card join public.profiles profile on profile.id=card.author_id
    where (content_filter is null or content_filter='talk')
      and (normalized_search='' or card.id::text ilike '%'||normalized_search||'%' or profile.nickname ilike '%'||normalized_search||'%'
        or card.topic ilike '%'||normalized_search||'%')
    union all
    select 'post'::text,post.id,post.author_id,profile.nickname,post.title,post.body,'active'::text,
      post.country_code,post.created_at,null::timestamptz,
      (select count(*) from public.board_comments comment where comment.post_id=post.id),
      (select count(*) from public.reports report where report.target_type='post' and report.reported_user_id=post.author_id)
    from public.board_posts post join public.profiles profile on profile.id=post.author_id
    where (content_filter is null or content_filter='post')
      and (normalized_search='' or post.id::text ilike '%'||normalized_search||'%' or profile.nickname ilike '%'||normalized_search||'%'
        or post.title ilike '%'||normalized_search||'%' or post.body ilike '%'||normalized_search||'%')
  ) content(content_kind,content_id,author_id,author_nickname,title,body,content_status,country_code,created_at,expires_at,comment_count,report_count)
  where status_filter is null or content.content_status=status_filter
  order by content.created_at desc
  limit least(greatest(coalesce(result_limit,300),1),1000);
end; $$;

create or replace function public.admin_list_board_comments(target_post_uuid uuid,result_limit integer default 500)
returns table(comment_id uuid,author_id uuid,author_nickname text,anonymous_name text,body text,parent_id uuid,created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  return query select comment.id,comment.author_id,profile.nickname,comment.anonymous_name,comment.body,comment.parent_id,comment.created_at
    from public.board_comments comment join public.profiles profile on profile.id=comment.author_id
    where comment.post_id=target_post_uuid order by comment.created_at
    limit least(greatest(coalesce(result_limit,500),1),1000);
end; $$;

create or replace function public.admin_set_conversation_card_active(target_card_uuid uuid,next_active boolean,admin_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare target public.conversation_cards;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  select * into target from public.conversation_cards where id=target_card_uuid for update;
  if not found then raise exception 'card_not_found'; end if;
  if next_active and exists(select 1 from public.conversation_cards where author_id=target.author_id and is_active and id<>target.id)
    then raise exception 'author_has_active_card'; end if;
  update public.conversation_cards set is_active=next_active,
    expires_at=case when next_active and expires_at<=now() then now()+interval '30 days' else expires_at end
    where id=target_card_uuid;
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target.author_id,case when next_active then 'restore_conversation_card' else 'hide_conversation_card' end,
    trim(admin_note),jsonb_build_object('card_id',target.id,'is_active',target.is_active),
    jsonb_build_object('card_id',target.id,'is_active',next_active));
end; $$;

create or replace function public.admin_delete_board_content(target_kind text,target_content_uuid uuid,admin_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare snapshot jsonb; target_user uuid;
begin
  if not public.admin_has_role('moderator') then raise exception 'admin_role_required'; end if;
  if target_kind not in ('post','comment') then raise exception 'invalid_content_kind'; end if;
  if char_length(trim(coalesce(admin_note,''))) not between 2 and 1000 then raise exception 'admin_note_required'; end if;
  if target_kind='post' then
    select to_jsonb(post),post.author_id into snapshot,target_user from public.board_posts post where post.id=target_content_uuid for update;
    if snapshot is null then raise exception 'post_not_found'; end if;
    snapshot:=snapshot||jsonb_build_object('comment_count',(select count(*) from public.board_comments where post_id=target_content_uuid));
    delete from public.board_posts where id=target_content_uuid;
  else
    select to_jsonb(comment),comment.author_id into snapshot,target_user from public.board_comments comment where comment.id=target_content_uuid for update;
    if snapshot is null then raise exception 'comment_not_found'; end if;
    delete from public.board_comments where id=target_content_uuid;
  end if;
  insert into public.moderation_actions(admin_user_id,target_user_id,action,note,before_state,after_state)
  values(auth.uid(),target_user,'delete_board_'||target_kind,trim(admin_note),snapshot,
    jsonb_build_object('content_id',target_content_uuid,'deleted',true));
end; $$;

-- Open-chat reports now expose their room identifier through the existing admin contract.
create or replace function public.admin_list_reports(status_filter text default null,result_limit integer default 100)
returns table(id uuid,target_type text,reason text,details text,priority text,status text,created_at timestamptz,
  reviewed_at timestamptz,review_note text,room_id uuid,reported_user_id uuid,reported_nickname text,
  reported_status text,suspended_until timestamptz,reporter_nickname text,content_snapshot jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.admin_has_role('reviewer') then raise exception 'admin_required'; end if;
  return query select report.id,report.target_type,report.reason,report.details,report.priority,report.status::text,
    report.created_at,report.reviewed_at,report.review_note,coalesce(report.room_id,report.open_chat_room_id),
    report.reported_user_id,reported.nickname,reported.status::text,reported.suspended_until,reporter.nickname,report.content_snapshot
  from public.reports report join public.profiles reported on reported.id=report.reported_user_id
  join public.profiles reporter on reporter.id=report.reporter_id
  where status_filter is null or report.status::text=status_filter
  order by case report.priority when 'urgent' then 0 when 'high' then 1 else 2 end,report.created_at desc
  limit least(greatest(result_limit,1),200);
end; $$;

revoke all on function public.admin_list_open_chat_rooms(text,text,integer) from public,anon,authenticated;
revoke all on function public.admin_get_open_chat_room(uuid) from public,anon,authenticated;
revoke all on function public.admin_close_open_chat_room(uuid,text) from public,anon,authenticated;
revoke all on function public.admin_remove_open_chat_member(uuid,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.admin_unban_open_chat_member(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.admin_delete_open_chat_message(bigint,text) from public,anon,authenticated;
revoke all on function public.admin_list_public_content(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.admin_list_board_comments(uuid,integer) from public,anon,authenticated;
revoke all on function public.admin_set_conversation_card_active(uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.admin_delete_board_content(text,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_list_open_chat_rooms(text,text,integer) to authenticated;
grant execute on function public.admin_get_open_chat_room(uuid) to authenticated;
grant execute on function public.admin_close_open_chat_room(uuid,text) to authenticated;
grant execute on function public.admin_remove_open_chat_member(uuid,uuid,boolean,text) to authenticated;
grant execute on function public.admin_unban_open_chat_member(uuid,uuid,text) to authenticated;
grant execute on function public.admin_delete_open_chat_message(bigint,text) to authenticated;
grant execute on function public.admin_list_public_content(text,text,text,integer) to authenticated;
grant execute on function public.admin_list_board_comments(uuid,integer) to authenticated;
grant execute on function public.admin_set_conversation_card_active(uuid,boolean,text) to authenticated;
grant execute on function public.admin_delete_board_content(text,uuid,text) to authenticated;
notify pgrst,'reload schema';

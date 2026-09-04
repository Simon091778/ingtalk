begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(25);

create function pg_temp.uid(n integer) returns uuid language sql as $$select ('86000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.login(n integer) returns void language plpgsql as $$begin
  perform set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.uid(n),'role','authenticated','amr',
    jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$begin execute statement; return null; exception when others then return sqlerrm; end $$;

insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,created_at,updated_at)
select pg_temp.uid(n),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'content'||n||'@test.local',now(),now(),now() from generate_series(1,6) n;
insert into public.admin_users(user_id,role) values(pg_temp.uid(1),'reviewer'),(pg_temp.uid(2),'moderator');
insert into account_private.device_accounts(id,auth_user_id)
select pg_temp.uid(n),pg_temp.uid(n) from generate_series(3,6) n;
insert into public.profiles(id,nickname,birth_year,region_code,gender) values
  (pg_temp.uid(3),'수다방장',1990,'KR','male'),(pg_temp.uid(4),'수다회원',1991,'KR','female'),
  (pg_temp.uid(5),'콘텐츠작가',1992,'KR','other'),(pg_temp.uid(6),'댓글작가',1993,'KR','male');

insert into public.open_chat_rooms(id,title,description,category,owner_user_id,max_members)
values(pg_temp.uid(20),'관리 대상 수다방','운영 테스트','수다',pg_temp.uid(3),10);
insert into public.open_chat_participants(room_id,user_id) values(pg_temp.uid(20),pg_temp.uid(3)),(pg_temp.uid(20),pg_temp.uid(4));
insert into public.open_chat_messages(id,room_id,sender_user_id,message_type,content) overriding system value
values(860020,pg_temp.uid(20),pg_temp.uid(4),'text','관리 대상 메시지');
insert into public.conversation_cards(id,author_id,purpose,topic,country_group)
values(pg_temp.uid(30),pg_temp.uid(5),'수다','관리 대상 톡','KR');
insert into public.board_posts(id,author_id,title,body,anonymous_name,anonymous_gender,country_code)
values(pg_temp.uid(40),pg_temp.uid(5),'관리 게시글','관리 대상 본문','익명1','other','KR');
insert into public.board_comments(id,post_id,author_id,body,anonymous_name,anonymous_gender)
values(pg_temp.uid(41),pg_temp.uid(40),pg_temp.uid(6),'관리 대상 댓글','익명2','male');

select ok(not has_function_privilege('anon','public.admin_list_open_chat_rooms(text,text,integer)','EXECUTE'),'anonymous cannot list open chat operations');
select ok(not has_function_privilege('anon','public.admin_delete_board_content(text,uuid,text)','EXECUTE'),'anonymous cannot delete public content');
set local role authenticated; select pg_temp.login(3);
select is(pg_temp.error($$select * from public.admin_list_open_chat_rooms(null,null,10)$$),'account_unlock_required','ordinary user cannot inspect open chats');
select pg_temp.login(1);
select is((select count(*) from public.admin_list_open_chat_rooms('관리 대상','active',10)),1::bigint,'reviewer searches open chat metadata');
select is((public.admin_get_open_chat_room(pg_temp.uid(20))#>>'{participants,1,nickname}'),'수다회원','reviewer inspects room participants');
select is((select count(*) from public.admin_list_public_content('talk','관리 대상','active',10)),1::bigint,'reviewer searches talk cards');
select is((select count(*) from public.admin_list_public_content('post','관리 게시글',null,10)),1::bigint,'reviewer searches board posts');
select is((select count(*) from public.admin_list_board_comments(pg_temp.uid(40),10)),1::bigint,'reviewer inspects board comments');
select is(pg_temp.error($$select public.admin_close_open_chat_room(pg_temp.uid(20),'정책 위반')$$),'admin_role_required','reviewer cannot close room');
select pg_temp.login(2);
select lives_ok($$select public.admin_remove_open_chat_member(pg_temp.uid(20),pg_temp.uid(4),true,'반복적인 운영 정책 위반')$$,'moderator removes and bans member');
reset role;
select is((select count(*) from public.open_chat_participants where room_id=pg_temp.uid(20) and user_id=pg_temp.uid(4)),0::bigint,'removed member leaves participant set');
select is((select count(*) from public.open_chat_room_bans where room_id=pg_temp.uid(20) and user_id=pg_temp.uid(4)),1::bigint,'blocked member cannot re-enter');
select is((select action from public.moderation_actions where target_user_id=pg_temp.uid(4) order by id desc limit 1),'ban_open_chat_member','member action is audited');
set local role authenticated; select pg_temp.login(2);
select lives_ok($$select public.admin_unban_open_chat_member(pg_temp.uid(20),pg_temp.uid(4),'검토 후 차단 해제')$$,'moderator releases room ban');
reset role;
select is((select count(*) from public.open_chat_room_bans where room_id=pg_temp.uid(20)),0::bigint,'ban release removes ban row');
set local role authenticated; select pg_temp.login(2);
select lives_ok($$select public.admin_delete_open_chat_message(860020,'부적절한 메시지')$$,'moderator deletes user message');
reset role;
select is((select count(*) from public.open_chat_messages where room_id=pg_temp.uid(20) and message_type='text'),0::bigint,'deleted open chat message disappears');
set local role authenticated; select pg_temp.login(2);
select lives_ok($$select public.admin_set_conversation_card_active(pg_temp.uid(30),false,'운영 정책 위반')$$,'moderator hides talk card');
reset role;
select is((select is_active from public.conversation_cards where id=pg_temp.uid(30)),false,'hidden talk card is inactive');
set local role authenticated; select pg_temp.login(2);
select lives_ok($$select public.admin_delete_board_content('comment',pg_temp.uid(41),'부적절한 댓글')$$,'moderator deletes board comment');
select lives_ok($$select public.admin_delete_board_content('post',pg_temp.uid(40),'부적절한 게시글')$$,'moderator deletes board post');
select lives_ok($$select public.admin_close_open_chat_room(pg_temp.uid(20),'운영 정책 위반 방 종료')$$,'moderator closes room and ejects owner');
reset role;
select is((select status from public.open_chat_rooms where id=pg_temp.uid(20)),'closed','admin closure marks room closed');
select is((select owner_user_id from public.open_chat_rooms where id=pg_temp.uid(20)),null::uuid,'admin closure clears owner');
select is((select count(*) from public.open_chat_participants where room_id=pg_temp.uid(20)),0::bigint,'admin closure removes all participants');
select * from finish();
rollback;

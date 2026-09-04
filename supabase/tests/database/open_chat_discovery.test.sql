begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(28);

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select ('95000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  '82109500000'||n,now(),false,now(),now() from generate_series(1,3) n;
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash)
select ('15000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid,
  account_private.hash_phone('82109500000'||n),repeat((n+6)::text,64) from generate_series(1,3) n;
update account_private.device_accounts set device_scope_hash=device_hash where id::text like '15000000-0000-4000-8000-%';
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where id::text like '15000000-0000-4000-8000-%';
insert into public.profiles(id,nickname,birth_year,region_code,gender,interests)
select ('15000000-0000-4000-8000-00000000000'||n)::uuid,'발견톡'||n,1990,'TEST','male',array['대화'] from generate_series(1,3) n;
insert into auth.sessions(id,user_id)
select ('25000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.sessions(session_id,user_id,account_id)
select ('25000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid,
 ('15000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
select id,device_hash,device_scope_hash,'web',true from account_private.device_accounts where id::text like '15000000-0000-4000-8000-%';
update account_private.sessions session set device_id=device.id from account_private.account_devices device
where device.account_id=session.account_id and device.is_primary and session.account_id::text like '15000000-0000-4000-8000-%';
update public.point_wallets set balance=1000 where user_id::text like '15000000-0000-4000-8000-%';

create temporary table open_discovery_state(name text primary key, value uuid, big_value bigint);
grant all on table open_discovery_state to authenticated;
create or replace function pg_temp.run_error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end;
$$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
insert into open_discovery_state(name,value) values ('room',public.create_open_chat_room('발견 연결 테스트','기존 일대일 연결','수다',10,'서울','{}'));
select is(public.my_point_balance(),900::bigint,'creating the source room charges 100 points');
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000002"}',true);
select public.join_open_chat_room((select value from open_discovery_state where name='room'));
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000003"}',true);
select public.join_open_chat_room((select value from open_discovery_state where name='room'));

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
insert into open_discovery_state(name,value) values ('request',public.create_open_chat_request((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000002','오픈채팅에서 반가웠어요'));
select ok((select value from open_discovery_state where name='request') is not null,'participant creates an existing private chat request');
select results_eq(
  $$select open_chat_room_id, sender_id, receiver_id, status::text from public.chat_requests where id=(select value from open_discovery_state where name='request')$$,
  $$values ((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000001'::uuid,'15000000-0000-4000-8000-000000000002'::uuid,'pending'::text)$$,
  'request uses open chat only as source and keeps the existing request table');
select is(public.my_point_balance(),800::bigint,'room creation and the open-chat request each charge 100 points');
select is(pg_temp.run_error($$select public.create_open_chat_request((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000001','셀프')$$),'cannot_request_self','self request is rejected by the server');

reset role;
insert into public.blocks(blocker_id,blocked_id) values ('15000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000003"}',true);
select is(pg_temp.run_error($$select public.create_open_chat_request((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000001','차단 우회')$$),'users_blocked','global block cannot be bypassed from open chat');

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select is(public.create_open_chat_request((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000002','갱신한 요청'),(select value from open_discovery_state where name='request'),'duplicate request refreshes the existing request');
select is((select count(*) from public.chat_requests where open_chat_room_id=(select value from open_discovery_state where name='room') and sender_id=public.current_account_id()),1::bigint,'duplicate refresh does not create another row');

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000002"}',true);
select is((select count(*) from public.my_chat_requests() where request_id=(select value from open_discovery_state where name='request')),1::bigint,'open-chat request appears in the existing request inbox');
insert into open_discovery_state(name,value) values ('private_room',public.respond_to_chat_request((select value from open_discovery_state where name='request'),'accepted'));
select ok((select value from open_discovery_state where name='private_room') is not null,'recipient accepts through the existing response RPC');
select is((select count(*) from public.chat_members where room_id=(select value from open_discovery_state where name='private_room')),2::bigint,'acceptance creates the normal two-member private room');

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select lives_ok($$select public.update_open_chat_room((select value from open_discovery_state where name='room'),'수정된 발견방','수정 설명','친구','부산','첫 공지')$$,'current owner edits room information');
select results_eq($$select title,description,category,region,notice from public.open_chat_rooms where id=(select value from open_discovery_state where name='room')$$,$$values ('수정된 발견방'::text,'수정 설명'::text,'친구'::text,'부산'::text,'첫 공지'::text)$$,'room fields and notice are updated');
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000002"}',true);
select is(pg_temp.run_error($$select public.update_open_chat_room((select value from open_discovery_state where name='room'),'침입 수정','설명','친구','','')$$),'owner_required','normal participant cannot edit');
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select lives_ok($$select public.transfer_open_chat_ownership((select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000002')$$,'ownership transfers before stale edit');
select is(pg_temp.run_error($$select public.update_open_chat_room((select value from open_discovery_state where name='room'),'이전 방장 수정','설명','친구','','')$$),'owner_required','former owner cannot edit after transfer');
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000002"}',true);
select lives_ok($$select public.update_open_chat_room((select value from open_discovery_state where name='room'),'새 방장 수정','설명','지역','대전','새 공지')$$,'new owner receives edit permission');
select results_eq($$select title,notice from public.open_chat_rooms where id=(select value from open_discovery_state where name='room')$$,$$values ('새 방장 수정'::text,'새 공지'::text)$$,'new owner changes are stored');

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000003"}',true);
with inserted as (
  insert into public.open_chat_messages(room_id,sender_user_id,content)
  values ((select value from open_discovery_state where name='room'),public.current_account_id(),'신고 증거 메시지') returning id
) insert into open_discovery_state(name,big_value) select 'message',id from inserted;

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select ok(public.report_open_chat('open_chat_user',(select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000003',null,'abuse','반복 괴롭힘') is not null,'participant submits a user report');
select is(pg_temp.run_error($$select public.report_open_chat('open_chat_user',(select value from open_discovery_state where name='room'),'15000000-0000-4000-8000-000000000003',null,'abuse','중복')$$),'report_already_exists','duplicate report spam is rejected');
reset role;
select results_eq(
  $$select reporter_id,reported_user_id,target_type from public.reports where target_type='open_chat_user' and open_chat_room_id=(select value from open_discovery_state where name='room')$$,
  $$values ('15000000-0000-4000-8000-000000000001'::uuid,'15000000-0000-4000-8000-000000000003'::uuid,'open_chat_user'::text)$$,
  'reporter identity is always derived from current_account_id');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select ok(public.report_open_chat('open_chat_message',(select value from open_discovery_state where name='room'),null,(select big_value from open_discovery_state where name='message'),'spam','광고 메시지') is not null,'participant reports an accessible message');
select ok(public.report_open_chat('open_chat_room',(select value from open_discovery_state where name='room'),null,null,'other','방 운영 신고') is not null,'non-owner participant reports the room');
select is(has_table_privilege('authenticated','public.reports','INSERT'),false,'client cannot forge reporter through direct report inserts');

select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000003"}',true);
insert into open_discovery_state(name,value) values ('other_room',public.create_open_chat_room('다른 신고방','','취미',10,null,'{}'));
with inserted as (
  insert into public.open_chat_messages(room_id,sender_user_id,content)
  values ((select value from open_discovery_state where name='other_room'),public.current_account_id(),'다른 방 메시지') returning id
) insert into open_discovery_state(name,big_value) select 'other_message',id from inserted;
select set_config('request.jwt.claims','{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}',true);
select is(pg_temp.run_error($$select public.report_open_chat('open_chat_message',(select value from open_discovery_state where name='room'),null,(select big_value from open_discovery_state where name='other_message'),'spam','관계없는 메시지')$$),'invalid_report_target','message from an unrelated room is rejected');
select lives_ok($$select public.join_open_chat_room((select value from open_discovery_state where name='other_room'))$$,'future successor joins room owned by deleting account');
reset role;
select lives_ok($$select public.delete_account_data('15000000-0000-4000-8000-000000000003')$$,'account deletion reconciles owned open-chat rooms');
select is((select owner_user_id from public.open_chat_rooms where id=(select value from open_discovery_state where name='other_room')),'15000000-0000-4000-8000-000000000001'::uuid,'remaining participant succeeds a deleted owner');

select * from finish();
rollback;

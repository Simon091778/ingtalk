begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select no_plan();

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select ('94000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  '82109400000'||n,now(),false,now(),now() from generate_series(1,3) n;
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash)
select ('14000000-0000-4000-8000-00000000000'||n)::uuid,('94000000-0000-4000-8000-00000000000'||n)::uuid,
  account_private.hash_phone('82109400000'||n),repeat((n+3)::text,64) from generate_series(1,3) n;
update account_private.device_accounts set device_scope_hash=device_hash where id::text like '14000000-0000-4000-8000-%';
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where id::text like '14000000-0000-4000-8000-%';
insert into public.profiles(id,nickname,birth_year,region_code,gender,interests)
select ('14000000-0000-4000-8000-00000000000'||n)::uuid,'오픈톡'||n,1990,'TEST','male',array['대화'] from generate_series(1,3) n;
insert into auth.sessions(id,user_id)
select ('24000000-0000-4000-8000-00000000000'||n)::uuid,('94000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.sessions(session_id,user_id,account_id)
select ('24000000-0000-4000-8000-00000000000'||n)::uuid,('94000000-0000-4000-8000-00000000000'||n)::uuid,
 ('14000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
select id,device_hash,device_scope_hash,'web',true from account_private.device_accounts where id::text like '14000000-0000-4000-8000-%';
update account_private.sessions session set device_id=device.id
from account_private.account_devices device where device.account_id=session.account_id and device.is_primary
  and session.account_id::text like '14000000-0000-4000-8000-%';
update public.point_wallets set balance=case when user_id='14000000-0000-4000-8000-000000000003' then 99 else 1000 end
where user_id::text like '14000000-0000-4000-8000-%';

create temporary table open_chat_test_state(name text primary key, room_id uuid);
grant all on table open_chat_test_state to authenticated;
create or replace function pg_temp.run_error(statement text)
returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end;
$$;

reset role;
update public.point_wallets set balance=1000 where user_id::text like '14000000-0000-4000-8000-%';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

insert into open_chat_test_state values ('main', public.create_open_chat_room('입퇴장 테스트','','수다',10,null,'{}'));
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡1님이 입장했습니다.'),1::bigint,'creator membership has one persisted join');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'));
select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'));
select is((select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='main') and user_id=public.current_account_id()),1::bigint,'join retry has one membership');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡2님이 입장했습니다.'),1::bigint,'join retry has one notice visible to entrant');
select is(pg_temp.run_error($$insert into public.open_chat_messages(room_id,sender_user_id,message_type,content) values ((select room_id from open_chat_test_state where name='main'),public.current_account_id(),'system','위조')$$),'new row violates row-level security policy for table "open_chat_messages"','member cannot forge system messages');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);

select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'));
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡3님이 입장했습니다.'),1::bigint,'C sees its persisted join');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡3님이 입장했습니다.'),1::bigint,'A sees C join');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡3님이 입장했습니다.'),1::bigint,'B sees C join');
reset role;
update public.profiles set nickname='변경닉네임' where id='14000000-0000-4000-8000-000000000003';
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡3님이 입장했습니다.'),1::bigint,'old notice keeps nickname snapshot');
update public.point_wallets set balance=0 where user_id='14000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);

select is(pg_temp.run_error($$select public.create_open_chat_room('실패할 방','','수다',10,null,'{}')$$),'insufficient_points','failed room switch rolls back');
select ok(public.is_open_chat_member((select room_id from open_chat_test_state where name='main')),'failed creation preserves previous membership');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='변경닉네임님이 퇴장했습니다.'),0::bigint,'failed creation rolls back departure notice');
select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'));
select lives_ok($$select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'))$$,'leave retry succeeds without mutation');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main')),0::bigint,'departed user cannot read room history');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='변경닉네임님이 퇴장했습니다.'),1::bigint,'A sees exactly one C leave');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='변경닉네임님이 퇴장했습니다.'),1::bigint,'B sees exactly one C leave');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);
select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'));
select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'));
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content like '%님이 입장했습니다.' and content in ('변경닉네임님이 입장했습니다.','오픈톡3님이 입장했습니다.')),2::bigint,'actual rejoin is a new event, its retry is not');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

select public.kick_open_chat_member((select room_id from open_chat_test_state where name='main'),'14000000-0000-4000-8000-000000000003');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='변경닉네임님이 방에서 내보내졌습니다.'),1::bigint,'kick keeps its own notice');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='변경닉네임님이 퇴장했습니다.'),1::bigint,'kick adds no normal leave notice');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);
select is(pg_temp.run_error($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'))$$),'room_banned','kicked user remains banned');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

select is(public.leave_open_chat_room((select room_id from open_chat_test_state where name='main')),'14000000-0000-4000-8000-000000000002'::uuid,'owner departure transfers to remaining eligible member');
select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡1님이 퇴장했습니다.'),1::bigint,'departed owner has one leave notice');
select results_eq($$select content from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content in ('오픈톡1님이 퇴장했습니다.','오픈톡2님이 새로운 방장이 되었습니다.') order by created_at,id$$,$$values ('오픈톡1님이 퇴장했습니다.'::text),('오픈톡2님이 새로운 방장이 되었습니다.'::text)$$,'leave precedes succession notice');
select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'));
select lives_ok($$select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'))$$,'last member leave retry is safe');
reset role;
select is((select status from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='main')),'closed'::text,'last participant closes room');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and content='오픈톡2님이 퇴장했습니다.'),0::bigint,'empty-room closure does not manufacture a useless leave');
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='open_chat_messages'),'system history shares existing Realtime publication');
select is((select count(*) from public.push_notifications where user_id::text like '14000000-0000-4000-8000-%'),0::bigint,'membership system notices do not generate chat push notifications');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

insert into open_chat_test_state values ('next',public.create_open_chat_room('이동 원본 방','','수다',10,null,'{}'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select public.join_open_chat_room((select room_id from open_chat_test_state where name='next'));
insert into open_chat_test_state values ('switch',public.create_open_chat_room('이동 목적 방','','수다',10,null,'{}'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='next') and content='오픈톡2님이 퇴장했습니다.'),1::bigint,'creating another room emits actual departure in old room');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select public.leave_open_chat_room((select room_id from open_chat_test_state where name='switch'));
select public.join_open_chat_room((select room_id from open_chat_test_state where name='next'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);

reset role;
update public.point_wallets set balance=1000 where user_id='14000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);

insert into open_chat_test_state values ('destination',public.create_open_chat_room('다른 목적 방','','수다',10,null,'{}'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select public.join_open_chat_room((select room_id from open_chat_test_state where name='destination'));
select public.join_open_chat_room((select room_id from open_chat_test_state where name='destination'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);

select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='next') and content='오픈톡2님이 퇴장했습니다.'),2::bigint,'joining another room emits one more actual departure, not two on retry');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);

select public.join_open_chat_room((select room_id from open_chat_test_state where name='next'));
reset role;
select lives_ok($$select public.delete_account_data('14000000-0000-4000-8000-000000000001')$$,'account deletion still uses existing cleanup');
select is((select owner_user_id from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='next')),'14000000-0000-4000-8000-000000000002'::uuid,'account deletion still transfers ownership');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='next') and content='오픈톡1님이 퇴장했습니다.'),0::bigint,'account deletion does not add voluntary leave');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='next') and content='오픈톡1님이 입장했습니다.'),1::bigint,'system nickname history survives account deletion');
select * from finish();
rollback;

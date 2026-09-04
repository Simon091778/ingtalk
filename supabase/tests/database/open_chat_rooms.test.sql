begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(63);

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

select has_column('public', 'notification_preferences', 'open_chat_enabled', 'notification preferences expose a separate open-chat switch');
select col_not_null('public', 'notification_preferences', 'open_chat_enabled', 'the open-chat switch always has an explicit value');

select ok(public, 'room-cover bucket is public discovery content')
from storage.buckets where id='open-chat-covers';
select is(file_size_limit, 8388608::bigint, 'room-cover bucket has an eight MiB server limit')
from storage.buckets where id='open-chat-covers';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
insert into open_chat_test_state values ('main', public.create_open_chat_room('테스트 오픈방','원자성 테스트','수다',3,'서울',array['테스트']));
select is(public.my_point_balance(),900::bigint,'successful room creation charges exactly 100 points');
select results_eq(
  $$select amount,reason,reference_id from public.point_transactions where user_id='14000000-0000-4000-8000-000000000001' and reason='open_chat_room_create'$$,
  $$values (-100::bigint,'open_chat_room_create'::text,(select room_id from open_chat_test_state where name='main'))$$,
  'room creation records one ledger entry against the created room');
select is(pg_temp.run_error($$select public.create_open_chat_room('정원 초과 방','검증','수다',21,null,'{}')$$), 'invalid_max_members', 'new room capacity cannot exceed twenty');
select is(public.my_point_balance(),900::bigint,'invalid room creation does not charge points');
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);
select is(pg_temp.run_error($$select public.create_open_chat_room('잔액 부족 방','원자성 확인','수다',10,null,'{}')$$),
  'insufficient_points','room creation rejects an account with less than 100 points');
reset role;
select is((select balance from public.point_wallets where user_id='14000000-0000-4000-8000-000000000003'),99::bigint,'insufficient room creation leaves the wallet unchanged');
select is((select count(*) from public.open_chat_rooms where owner_user_id='14000000-0000-4000-8000-000000000003'),0::bigint,
  'insufficient room creation leaves no partial room');
update public.point_wallets set balance=1000 where user_id='14000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select is((select owner_user_id from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='main')),
  '14000000-0000-4000-8000-000000000001'::uuid, 'creator is owner');
select ok(public.is_open_chat_member((select room_id from open_chat_test_state where name='main')), 'creator is participant');
select is((select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='main')), 1::bigint, 'room creation adds one participant');
select is(pg_temp.run_error($$select public.set_open_chat_room_cover(
  (select room_id from open_chat_test_state where name='main'),
  (select room_id from open_chat_test_state where name='main')::text||'/14000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',1200,800
)$$), 'cover_not_uploaded', 'room cover must exist before it can be attached');
insert into storage.objects(bucket_id,name) select 'open-chat-covers',
  room_id::text||'/14000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'
from open_chat_test_state where name='main';
select lives_ok($$select public.set_open_chat_room_cover(
  (select room_id from open_chat_test_state where name='main'),
  (select room_id from open_chat_test_state where name='main')::text||'/14000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',1200,800
)$$, 'owner attaches an uploaded room cover');
select results_eq(
  $$select cover_width,cover_height from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='main')$$,
  $$values (1200,800)$$, 'room stores typed cover dimensions');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select is(pg_temp.run_error($$select public.set_open_chat_room_cover(
  (select room_id from open_chat_test_state where name='main'),null,null,null
)$$), 'owner_required', 'normal participant cannot replace the room cover');
select is((select owner_nickname from public.list_open_chat_rooms('popular') where room_id=(select room_id from open_chat_test_state where name='main')),
  '오픈톡1'::text, 'room preview includes the owner nickname');
select is((select cover_storage_path from public.list_open_chat_rooms('popular') where room_id=(select room_id from open_chat_test_state where name='main')),
  (select room_id from open_chat_test_state where name='main')::text||'/14000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
  'room discovery includes its cover path');
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'))$$, 'second user joins');
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'))$$, 'duplicate join is idempotent');
select is((select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='main')), 2::bigint, 'unique membership prevents duplicate rows');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'))$$, 'third user joins up to capacity');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select is(pg_temp.run_error($$select public.create_open_chat_room('두 번째 방','방장 중복 생성 차단','수다',10,null,'{}')$$),
  'owner_must_leave_room_first', 'owner must leave the owned room before creating another room');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000003"}', true);
insert into open_chat_test_state values ('switch', public.create_open_chat_room('이동할 방','자동 퇴장 테스트','친구',10,null,'{}'));
select is(public.my_point_balance(),900::bigint,'creating while leaving a non-owner membership charges 100 points');
select is((select count(*) from public.open_chat_participants where user_id='14000000-0000-4000-8000-000000000003'),
  1::bigint, 'creating a room automatically leaves the prior non-owner membership');
select is((select room_id from public.open_chat_participants where user_id='14000000-0000-4000-8000-000000000003'),
  (select room_id from open_chat_test_state where name='switch'), 'creator participates only in the newly created room');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select is(pg_temp.run_error($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='switch'))$$),
  'owner_must_leave_room_first', 'owner cannot enter another room before leaving the owned room');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='switch'))$$, 'regular member switches rooms atomically');
select is((select count(*) from public.open_chat_participants where user_id='14000000-0000-4000-8000-000000000002'),
  1::bigint, 'regular member retains only one membership after switching');
select is((select room_id from public.open_chat_participants where user_id='14000000-0000-4000-8000-000000000002'),
  (select room_id from open_chat_test_state where name='switch'), 'regular member is moved to the selected room');
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='main'))$$, 'regular member can switch back to the original room');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select lives_ok($$select public.transfer_open_chat_ownership((select room_id from open_chat_test_state where name='main'),'14000000-0000-4000-8000-000000000002')$$, 'owner transfers atomically');
select is((select owner_user_id from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='main')),
  '14000000-0000-4000-8000-000000000002'::uuid, 'new owner is stored once');
select is(pg_temp.run_error($$select public.kick_open_chat_member((select room_id from open_chat_test_state where name='main'),'14000000-0000-4000-8000-000000000003')$$), 'owner_required', 'former owner cannot use owner privileges');

select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select ok(public.leave_open_chat_room((select room_id from open_chat_test_state where name='main')) in
  ('14000000-0000-4000-8000-000000000001'::uuid,'14000000-0000-4000-8000-000000000003'::uuid), 'owner leave chooses one active successor');
reset role;
select is((select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='main') and user_id='14000000-0000-4000-8000-000000000002'), 0::bigint, 'departed owner is removed');
select is((select count(*) from public.open_chat_participants participant join public.open_chat_rooms room on room.id=participant.room_id and room.owner_user_id=participant.user_id where room.id=(select room_id from open_chat_test_state where name='main')), 1::bigint, 'exactly one owner remains and is an active participant');
select is((select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='main') and message_type='system' and content like '%님이 새로운 방장이 되었습니다.'), 2::bigint, 'direct and automatic ownership changes are recorded');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select public.leave_open_chat_room((select room_id from open_chat_test_state where name='main'));
insert into open_chat_test_state values ('single', public.create_open_chat_room('마지막 방장 방','','친구',10,null,'{}'));
select is(public.my_point_balance(),800::bigint,'a later successful room creation charges another 100 points');
select is(public.leave_open_chat_room((select room_id from open_chat_test_state where name='single')), null::uuid, 'last owner has no successor');
reset role;
select results_eq(
  $$select status, owner_user_id, closed_reason from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='single')$$,
  $$values ('closed'::text, null::uuid, 'empty_room'::text)$$, 'last owner leaving closes the room');
select is((select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='single')), 0::bigint, 'closed empty room has no participant');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
insert into open_chat_test_state values ('kick', public.create_open_chat_room('강퇴 테스트 방','','취미',10,null,'{}'));
select is(public.my_point_balance(),700::bigint,'each additional successful room creation charges 100 points');
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select lives_ok($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='kick'))$$, 'kick target joins');
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
insert into public.open_chat_messages(room_id,sender_user_id,content)
values ((select room_id from open_chat_test_state where name='kick'),'14000000-0000-4000-8000-000000000001','푸시 알림 테스트');
reset role;
select is((select count(*) from public.push_notifications where user_id='14000000-0000-4000-8000-000000000002'),1::bigint,
  'a participant message queues one push for the other room participant');
select is((select data->>'kind' from public.push_notifications where user_id='14000000-0000-4000-8000-000000000002' order by id desc limit 1),'open_chat_message'::text,
  'the queued push is typed as an open-chat message');
select is((select count(*) from public.push_notifications where user_id='14000000-0000-4000-8000-000000000001'),0::bigint,
  'the sender does not receive their own open-chat push');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000001"}', true);
select lives_ok($$select public.kick_open_chat_member((select room_id from open_chat_test_state where name='kick'),'14000000-0000-4000-8000-000000000002')$$, 'owner kicks another member');
select is((select count(*) from public.open_chat_room_bans where room_id=(select room_id from open_chat_test_state where name='kick')), 0::bigint, 'ban rows are exposed only to the banned account for realtime removal');
select set_config('request.jwt.claims', '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"24000000-0000-4000-8000-000000000002"}', true);
select is(pg_temp.run_error($$select public.join_open_chat_room((select room_id from open_chat_test_state where name='kick'))$$), 'room_banned', 'kicked member cannot rejoin');
select is(pg_temp.run_error($$insert into public.open_chat_messages(room_id,sender_user_id,content) values ((select room_id from open_chat_test_state where name='kick'),'14000000-0000-4000-8000-000000000002','침입')$$),
  'new row violates row-level security policy for table "open_chat_messages"', 'non-member cannot send a message');

reset role;
update public.open_chat_rooms
set last_user_message_at='2026-07-01 00:00:00+00', inactivity_warning_at=null
where id=(select room_id from open_chat_test_state where name='kick');
select is(
  public.run_open_chat_inactivity_maintenance('2026-07-31 00:00:00+00'),
  '{"closed_count": 0, "warned_count": 1}'::jsonb,
  'exactly thirty inactive days emits one warning without closing the room');
select is(
  (select inactivity_warning_at from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='kick')),
  '2026-07-31 00:00:00+00'::timestamptz,
  'the grace period starts at the warning time');
select is(
  (select last_user_message_at from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='kick')),
  '2026-07-01 00:00:00+00'::timestamptz,
  'the system warning does not advance real-user activity');
select is(
  (select count(*) from public.open_chat_messages where room_id=(select room_id from open_chat_test_state where name='kick')
    and message_type='system' and content like '30일 동안 대화가 없어%'),
  1::bigint,
  'the inactivity notice is stored once as a system message');
select is(
  public.run_open_chat_inactivity_maintenance('2026-07-31 23:59:59+00'),
  '{"closed_count": 0, "warned_count": 0}'::jsonb,
  'the room stays active throughout the full twenty-four-hour grace period');
insert into public.open_chat_messages(room_id,sender_user_id,message_type,content,created_at)
values ((select room_id from open_chat_test_state where name='kick'),
  '14000000-0000-4000-8000-000000000001','text','아직 사용 중입니다','2026-07-31 12:00:00+00');
select is(
  (select inactivity_warning_at from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='kick')),
  null::timestamptz,
  'a real user message cancels the pending expiration');
select is(
  (select last_user_message_at from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='kick')),
  '2026-07-31 12:00:00+00'::timestamptz,
  'a real user message restarts the inactivity clock');
update public.open_chat_rooms
set last_user_message_at='2026-07-01 00:00:00+00', inactivity_warning_at='2026-07-31 00:00:00+00'
where id=(select room_id from open_chat_test_state where name='kick');
select is(
  public.run_open_chat_inactivity_maintenance('2026-08-01 00:00:00+00'),
  '{"closed_count": 1, "warned_count": 0}'::jsonb,
  'twenty-four silent hours after the warning closes the room');
select results_eq(
  $$select status,owner_user_id,closed_reason from public.open_chat_rooms where id=(select room_id from open_chat_test_state where name='kick')$$,
  $$values ('closed'::text,null::uuid,'inactive_after_30_day_warning'::text)$$,
  'inactive expiration records a closed room with no owner');
select is(
  (select count(*) from public.open_chat_participants where room_id=(select room_id from open_chat_test_state where name='kick')),
  0::bigint,
  'inactive expiration removes every participant');

select * from finish();
rollback;

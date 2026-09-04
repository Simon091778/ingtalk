begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(43);

create temporary table merge_state(label text primary key,result jsonb);
grant all on pg_temp.merge_state to authenticated,service_role;
create function pg_temp.aid(k text) returns uuid language sql as $$
 select (result->>'account_id')::uuid from pg_temp.merge_state where label=k
$$;
create function pg_temp.ticket(k text) returns text language sql as $$
 select result->>'ticket' from pg_temp.merge_state where label=k
$$;
create function pg_temp.merge_error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
create function pg_temp.claim(uid uuid,sid uuid,kind text,phone_value text default null) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated',
  'session_id',sid,'phone',phone_value,'amr',jsonb_build_array(jsonb_build_object(
   'method',case when kind='phone' then 'otp' else 'oauth' end,
   'timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at) values
 ('c1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055520001',now(),false,now(),now()),
 ('c1000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055520004',now(),false,now(),now()),
 ('c1000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055520006',now(),false,now(),now());
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at) values
 ('c1000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','merge-google@example.invalid',now(),false,now(),now()),
 ('c1000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
 ('c1000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
 ('c1000000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000000','authenticated','authenticated','atomic-google@example.invalid',now(),false,now(),now()),
 ('c1000000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000000','authenticated','authenticated','atomic-google-two@example.invalid',now(),false,now(),now());
insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
 (gen_random_uuid(),'c1000000-0000-4000-8000-000000000002','google','merge-google','{"sub":"merge-google","email_verified":true}'),
 (gen_random_uuid(),'c1000000-0000-4000-8000-000000000003','kakao','88110003','{"sub":"88110003","provider_id":"88110003"}'),
 (gen_random_uuid(),'c1000000-0000-4000-8000-000000000005','kakao','88110005','{"sub":"88110005","provider_id":"88110005"}'),
 (gen_random_uuid(),'c1000000-0000-4000-8000-000000000007','google','atomic-google','{"sub":"atomic-google","email_verified":true}'),
 (gen_random_uuid(),'c1000000-0000-4000-8000-000000000008','google','atomic-google-two','{"sub":"atomic-google-two","email_verified":true}');
insert into auth.sessions(id,user_id) values
 ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001'),
 ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002'),
 ('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000002'),
 ('c2000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000004'),
 ('c2000000-0000-4000-8000-000000000005','c1000000-0000-4000-8000-000000000003'),
 ('c2000000-0000-4000-8000-000000000006','c1000000-0000-4000-8000-000000000005'),
 ('c2000000-0000-4000-8000-000000000007','c1000000-0000-4000-8000-000000000006'),
 ('c2000000-0000-4000-8000-000000000008','c1000000-0000-4000-8000-000000000007'),
 ('c2000000-0000-4000-8000-000000000009','c1000000-0000-4000-8000-000000000008');

select ok(not has_function_privilege('authenticated','account_private.merge_verified_accounts(uuid,uuid,uuid,uuid,text)','EXECUTE'),'merge helper is server-only');
select ok(not has_table_privilege('authenticated','account_private.account_merge_audit','SELECT'),'merge audit is private');

-- M1/M5/M7: Phone A (3000) explicitly verifies established Google B (8000).
select pg_temp.claim('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','phone','821055520001');
set local role authenticated;
insert into pg_temp.merge_state values('A',public.authorize_device_account_v2(repeat('1',64),'android',repeat('a',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'병합A',1990,'TEST','male');
select public.claim_account_welcome_points();
reset role;
update public.point_wallets set balance=3000 where user_id=pg_temp.aid('A');
insert into public.board_posts(id,author_id,title,body,anonymous_name,anonymous_gender)
 values('c3000000-0000-4000-8000-000000000001',pg_temp.aid('A'),'A 글','A asset','A','male');

select pg_temp.claim('c1000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','google');
set local role authenticated;
insert into pg_temp.merge_state values('B',public.authorize_google_device_account(repeat('2',64),'android',repeat('b',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'병합B',1990,'TEST','female');
select public.claim_account_welcome_points();
reset role;
update public.point_wallets set balance=8000 where user_id=pg_temp.aid('B');
insert into public.board_posts(id,author_id,title,body,anonymous_name,anonymous_gender)
 values('c3000000-0000-4000-8000-000000000002',pg_temp.aid('B'),'B 글','B asset','B','female');
insert into public.board_comments(id,post_id,author_id,body,anonymous_name,anonymous_gender) values
 ('c3000000-0000-4000-8000-000000000003','c3000000-0000-4000-8000-000000000001',pg_temp.aid('A'),'A comment','A','male'),
 ('c3000000-0000-4000-8000-000000000004','c3000000-0000-4000-8000-000000000001',pg_temp.aid('B'),'B comment','B','female');
insert into account_private.device_accounts(id,auth_user_id)
 values('c3000000-0000-4000-8000-000000000010','c1000000-0000-4000-8000-000000000005');
insert into public.profiles(id,nickname,birth_year,region_code,gender)
 values('c3000000-0000-4000-8000-000000000010','상대방',1990,'TEST','male');
insert into public.conversation_cards(id,author_id,purpose,topic,expires_at)
 values('c3000000-0000-4000-8000-000000000011','c3000000-0000-4000-8000-000000000010','수다','merge message fixture',now()+interval '1 day');
insert into public.chat_requests(id,card_id,sender_id,receiver_id,opening_message,status)
 values('c3000000-0000-4000-8000-000000000012','c3000000-0000-4000-8000-000000000011',pg_temp.aid('B'),'c3000000-0000-4000-8000-000000000010','hello','accepted');
insert into public.chat_rooms(id,request_id) values('c3000000-0000-4000-8000-000000000013','c3000000-0000-4000-8000-000000000012');
insert into public.chat_members(room_id,user_id) values
 ('c3000000-0000-4000-8000-000000000013',pg_temp.aid('B')),
 ('c3000000-0000-4000-8000-000000000013','c3000000-0000-4000-8000-000000000010');
insert into public.messages(room_id,sender_id,body)
 values('c3000000-0000-4000-8000-000000000013',pg_temp.aid('B'),'B message');
insert into public.chat_requests(id,card_id,sender_id,receiver_id,opening_message,status)
 values('c3000000-0000-4000-8000-000000000014','c3000000-0000-4000-8000-000000000011',pg_temp.aid('A'),'c3000000-0000-4000-8000-000000000010','A hello','accepted');
insert into public.chat_rooms(id,request_id) values('c3000000-0000-4000-8000-000000000015','c3000000-0000-4000-8000-000000000014');
insert into public.chat_members(room_id,user_id) values
 ('c3000000-0000-4000-8000-000000000015',pg_temp.aid('A')),
 ('c3000000-0000-4000-8000-000000000015','c3000000-0000-4000-8000-000000000010');
insert into public.messages(room_id,sender_id,body)
 values('c3000000-0000-4000-8000-000000000015',pg_temp.aid('A'),'A message');
insert into public.open_chat_rooms(id,title,description,category,owner_user_id,max_members)
 values('c4000000-0000-4000-8000-000000000001','B의 수다방','losing room','수다',pg_temp.aid('B'),10);
insert into public.open_chat_participants(room_id,user_id)
 values('c4000000-0000-4000-8000-000000000001',pg_temp.aid('B'));
insert into public.open_chat_messages(room_id,sender_user_id,message_type,content)
 values('c4000000-0000-4000-8000-000000000001',pg_temp.aid('B'),'text','B open chat message');
insert into public.notification_preferences(user_id,message_enabled)
 values(pg_temp.aid('A'),false),(pg_temp.aid('B'),true);
insert into public.support_threads(id,user_id) values
 ('c5000000-0000-4000-8000-000000000001',pg_temp.aid('A')),
 ('c5000000-0000-4000-8000-000000000002',pg_temp.aid('B'));
insert into public.support_messages(thread_id,sender_type,sender_user_id,body) values
 ('c5000000-0000-4000-8000-000000000001','user',pg_temp.aid('A'),'A support'),
 ('c5000000-0000-4000-8000-000000000002','user',pg_temp.aid('B'),'B support');
insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,product_id,
 point_amount,price_won,store,environment)
 values('merge-event','merge-store',pg_temp.aid('B'),'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX');

-- Establish an old B app session that must not survive the merge.
select pg_temp.claim('c1000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000003','google');
set local role authenticated;
select public.authorize_google_device_account(repeat('3',64),'android',repeat('c',64));
reset role;
insert into public.push_tokens(user_id,token,platform,auth_session_id)
 values(pg_temp.aid('B'),'ExponentPushToken[merge-losing-b]','android','c2000000-0000-4000-8000-000000000003');
select pg_temp.claim('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','phone','821055520001');
insert into pg_temp.merge_state values('ticketAB',public.begin_account_link_v2(repeat('1',64),'android',repeat('a',64),'google'));
select ok((select result->>'ticket' from pg_temp.merge_state where label='ticketAB') is not null,'M1 source supplies a fresh authenticated link ticket');
select pg_temp.claim('c1000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','google');
insert into pg_temp.merge_state values('mergedAB',public.finish_account_link(pg_temp.ticket('ticketAB'),repeat('1',64),'android',repeat('a',64)));
select is(pg_temp.aid('mergedAB'),pg_temp.aid('A'),'M1 current account A is deterministic survivor');
select is((select result->>'merged' from pg_temp.merge_state where label='mergedAB'),'true','M1 reports verified merge');
select is(public.current_account_id(),pg_temp.aid('A'),'M1 verified target session is rebound to A');
select is(public.my_point_balance(),8000::bigint,'M1/M5 points equal MAX 8000, not sum 11000');
select isnt(public.my_point_balance(),11000::bigint,'M2 points are never summed');
reset role;
select ok(not exists(select 1 from account_private.device_accounts where id=pg_temp.aid('B')),'M7 losing B is not active');
select ok((select nickname='병합A' from public.profiles where id=pg_temp.aid('A'))
 and not exists(select 1 from public.profiles where id=pg_temp.aid('B')),'M3 keeps A profile unchanged and deletes B profile');
select is((select count(*) from public.board_posts where author_id=pg_temp.aid('A') and id in(
 'c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002')),1::bigint,'M7 keeps only the survivor post');
select ok(exists(select 1 from public.board_comments where id='c3000000-0000-4000-8000-000000000003' and author_id=pg_temp.aid('A'))
 and not exists(select 1 from public.board_comments where id='c3000000-0000-4000-8000-000000000004'),
 'M5 keeps A comment and deletes B comment without ownership transfer');
select ok(exists(select 1 from public.chat_rooms where id='c3000000-0000-4000-8000-000000000015')
 and exists(select 1 from public.messages where room_id='c3000000-0000-4000-8000-000000000015' and sender_id=pg_temp.aid('A') and body='A message'),
 'M4 keeps the survivor conversation and message');
select ok(not exists(select 1 from public.chat_rooms where id='c3000000-0000-4000-8000-000000000013')
 and not exists(select 1 from public.messages where body='B message'),'M4/M8 deletes the losing conversation so it cannot appear for A');
select ok(exists(select 1 from public.point_purchase_receipts where provider_event_id='merge-event'
 and user_id is null and original_account_id=pg_temp.aid('B')
 and account_deleted_at is not null and raw_event='{}'::jsonb),
 'M7 keeps immutable original payer on the detached scrubbed purchase tombstone');
select is((select count(*) from account_private.account_identities where account_id=pg_temp.aid('A')
 and provider in('phone','google')),2::bigint,'M7 provider identities belong to survivor');
select is((select count(*) from account_private.sessions where account_id=pg_temp.aid('B')),0::bigint,'M7 losing app sessions are revoked');
select ok(not exists(select 1 from auth.sessions where id='c2000000-0000-4000-8000-000000000003'),'M7 old losing Auth session is revoked');
select ok(not exists(select 1 from public.push_tokens where token='ExponentPushToken[merge-losing-b]'),'M9 losing push token is removed');
select is((select merged_balance from account_private.account_merge_audit where losing_account_id=pg_temp.aid('B')),8000::bigint,'M7 merge audit records MAX balance');
select ok(jsonb_array_length((select losing_point_ledger from account_private.account_merge_audit
 where losing_account_id=pg_temp.aid('B')))>0,'M7 losing point ledger is retained for audit');
select is((select asset_counts->>'policy' from account_private.account_merge_audit where losing_account_id=pg_temp.aid('B')),
 'discard_losing_assets','merge audit records the losing-data deletion policy');
select ok(not exists(select 1 from public.open_chat_rooms where id='c4000000-0000-4000-8000-000000000001')
 and not exists(select 1 from public.open_chat_messages where content='B open chat message'),'losing open-chat room and messages are deleted');
select ok(exists(select 1 from public.notification_preferences where user_id=pg_temp.aid('A') and not message_enabled)
 and not exists(select 1 from public.notification_preferences where user_id=pg_temp.aid('B'))
 and exists(select 1 from public.support_messages where body='A support')
 and not exists(select 1 from public.support_messages where body='B support'),
 'survivor settings/support remain while losing settings/support are deleted');
select ok(not exists(select 1 from pg_constraint c where c.contype='f' and not c.convalidated),'M7 leaves no unvalidated foreign key');

-- M2/M6: reverse direction keeps the currently authenticated Kakao account;
-- equal balances remain 1000 rather than 2000.
select pg_temp.claim('c1000000-0000-4000-8000-000000000004','c2000000-0000-4000-8000-000000000004','phone','821055520004');
set local role authenticated;
insert into pg_temp.merge_state values('D',public.authorize_device_account_v2(repeat('4',64),'android',repeat('d',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'병합D',1990,'TEST','male');
select public.claim_account_welcome_points(); reset role;
update public.point_wallets set balance=1000 where user_id=pg_temp.aid('D');
select pg_temp.claim('c1000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000005','kakao');
set local role authenticated;
insert into pg_temp.merge_state values('E',public.authorize_kakao_device_account(repeat('5',64),'android',repeat('e',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'병합E',1990,'TEST','female');
select public.claim_account_welcome_points(); reset role;
update public.point_wallets set balance=1000 where user_id=pg_temp.aid('E');
select pg_temp.claim('c1000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000005','kakao');
set local role authenticated;
insert into pg_temp.merge_state values('ticketED',public.begin_account_link_v2(repeat('5',64),'android',repeat('e',64),'phone'));
select pg_temp.claim('c1000000-0000-4000-8000-000000000004','c2000000-0000-4000-8000-000000000004','phone','821055520004');
insert into pg_temp.merge_state values('mergedED',public.finish_account_link(pg_temp.ticket('ticketED'),repeat('5',64),'android',repeat('e',64)));
select is(pg_temp.aid('mergedED'),pg_temp.aid('E'),'M2 current Kakao E is survivor in reverse direction');
select is(public.my_point_balance(),1000::bigint,'M6 equal balances remain 1000');
reset role;
select ok(not exists(select 1 from account_private.device_accounts where id=pg_temp.aid('D')),'M2 verified losing phone account retires');

-- M4: without a link ticket, provider login only resolves its own identity.
select pg_temp.claim('c1000000-0000-4000-8000-000000000005','c2000000-0000-4000-8000-000000000006','kakao');
set local role authenticated;
insert into pg_temp.merge_state values('unverified',public.authorize_kakao_device_account(repeat('6',64),'android',repeat('f',64)));
select is((select result->>'merged' from pg_temp.merge_state where label='unverified'),null::text,'M4 normal resolver never reports merge');
reset role;
select is((select count(*) from account_private.account_merge_audit where survivor_account_id=pg_temp.aid('unverified')),0::bigint,'M4 inference creates no merge audit');

-- Losing user relationships are disposable under the final policy, so a block
-- between the two verified accounts is removed rather than blocking the merge.
select pg_temp.claim('c1000000-0000-4000-8000-000000000006','c2000000-0000-4000-8000-000000000007','phone','821055520006');
set local role authenticated;
insert into pg_temp.merge_state values('F',public.authorize_device_account_v2(repeat('7',64),'android',repeat('7',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'원자성F',1990,'TEST','male');
select public.claim_account_welcome_points();
insert into pg_temp.merge_state values('ticketFG',public.begin_account_link_v2(repeat('7',64),'android',repeat('7',64),'google'));
reset role;
select pg_temp.claim('c1000000-0000-4000-8000-000000000007','c2000000-0000-4000-8000-000000000008','google');
set local role authenticated;
insert into pg_temp.merge_state values('G',public.authorize_google_device_account(repeat('8',64),'android',repeat('8',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'원자성G',1990,'TEST','female');
select public.claim_account_welcome_points();
reset role;
insert into public.blocks(blocker_id,blocked_id) values(pg_temp.aid('F'),pg_temp.aid('G'));
select pg_temp.claim('c1000000-0000-4000-8000-000000000007','c2000000-0000-4000-8000-000000000008','google');
set local role authenticated;
insert into pg_temp.merge_state values('mergedFG',public.finish_account_link(
 pg_temp.ticket('ticketFG'),repeat('7',64),'android',repeat('7',64)));
reset role;
select is((select result->>'merged' from pg_temp.merge_state where label='mergedFG'),'true','losing relationship data does not block verified merge');
select ok(not exists(select 1 from account_private.device_accounts where id=pg_temp.aid('G')),'relationship merge retires losing G');
select is((select balance from public.point_wallets where user_id=pg_temp.aid('F')),100::bigint,'relationship merge keeps MAX equal balance');
select ok(not exists(select 1 from public.blocks where blocker_id=pg_temp.aid('F') or blocked_id=pg_temp.aid('F')),'losing relationship data is deleted');
select is((select count(*) from account_private.account_merge_audit where losing_account_id=pg_temp.aid('G')),1::bigint,'relationship merge is audited');

-- A portable provider-slot collision is still a real authentication conflict.
-- It must fail before either established account or its balance is mutated.
select pg_temp.claim('c1000000-0000-4000-8000-000000000008','c2000000-0000-4000-8000-000000000009','google');
set local role authenticated;
insert into pg_temp.merge_state values('H',public.authorize_google_device_account(repeat('9',64),'android',repeat('9',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'원자성H',1990,'TEST','female');
select public.claim_account_welcome_points();
reset role;
select alike(pg_temp.merge_error(format($sql$select account_private.merge_verified_accounts(%L,%L,%L,%L,'google')$sql$,
 pg_temp.aid('F'),pg_temp.aid('H'),'c2000000-0000-4000-8000-000000000007','c2000000-0000-4000-8000-000000000009')),
 '%account_merge_asset_conflict%','provider conflict reports explicit asset conflict');
select is((select count(*) from account_private.device_accounts where id in(pg_temp.aid('F'),pg_temp.aid('H'))),2::bigint,'provider conflict preserves both principals');
select is((select count(*) from public.point_wallets where user_id in(pg_temp.aid('F'),pg_temp.aid('H')) and balance=100),2::bigint,'provider conflict preserves both balances');
select is((select count(*) from account_private.account_identities where account_id in(pg_temp.aid('F'),pg_temp.aid('H'))),3::bigint,'provider conflict preserves identities');
select is((select count(*) from account_private.account_merge_audit where losing_account_id=pg_temp.aid('H')),0::bigint,'provider conflict writes no partial audit');

select is((select count(*) from account_private.account_recovery_aliases where reason='verified_account_merge'),3::bigint,'verified merges create three canonical aliases');
select ok(not exists(select 1 from account_private.account_identities i where i.account_id not in(
 select id from account_private.device_accounts)),'all moved identities have an active canonical principal');
select is((select count(*) from account_private.account_merge_audit),3::bigint,'only the three explicit verified flows merged');

select * from finish(true);
rollback;

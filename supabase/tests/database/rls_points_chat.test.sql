begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(33);

-- Fixed, rollback-only identities keep failures reproducible and never remain in the database.
-- Transport IDs intentionally differ from app IDs; catch accidental public.current_account_id() use.
insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select ('90000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  '82109000000'||n,now(),false,now(),now() from generate_series(1,3) n;
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash)
select ('10000000-0000-4000-8000-00000000000'||n)::uuid,('90000000-0000-4000-8000-00000000000'||n)::uuid,
  account_private.hash_phone('82109000000'||n),repeat(n::text,64) from generate_series(1,3) n;
update account_private.device_accounts set device_scope_hash=device_hash where id::text like '10000000-0000-4000-8000-%' and device_hash is not null;
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where id::text like '10000000-0000-4000-8000-%' and device_hash is not null;
insert into public.profiles(id,nickname,birth_year,region_code,gender,interests)
select ('10000000-0000-4000-8000-00000000000'||n)::uuid,'테스트'||n,1990,'TEST','male',array['대화'] from generate_series(1,3) n;
insert into auth.sessions(id,user_id)
select ('10000000-0000-4000-8000-00000000000'||n)::uuid,('90000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.sessions(session_id,user_id,account_id)
select ('10000000-0000-4000-8000-00000000000'||n)::uuid,('90000000-0000-4000-8000-00000000000'||n)::uuid,
 ('10000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;

insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
select id,device_hash,device_scope_hash,'web',true from account_private.device_accounts where id::text like '10000000-0000-4000-8000-%';
update account_private.sessions g set device_id=v.id from account_private.account_devices v where v.account_id=g.account_id and v.is_primary;

create or replace function pg_temp.run_error(statement text)
returns text language plpgsql as $$
begin
  execute statement;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

select results_eq(
  $$select user_id, balance from public.point_wallets
    where user_id::text like '10000000-0000-4000-8000-%' order by user_id$$,
  $$values
    ('10000000-0000-4000-8000-000000000001'::uuid, 0::bigint),
    ('10000000-0000-4000-8000-000000000002'::uuid, 0::bigint),
    ('10000000-0000-4000-8000-000000000003'::uuid, 0::bigint)$$,
  'new profiles start at zero before the account welcome claim'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);

select results_eq(
  $$select public.claim_account_welcome_points()$$,
  $$values (100::bigint)$$,
  'first account claim grants exactly 100 points'
);
select results_eq(
  $$select public.claim_account_welcome_points()$$,
  $$values (100::bigint)$$,
  'same account cannot receive welcome points twice'
);
select results_eq(
  $$select awarded, balance from public.claim_attendance_reward()$$,
  $$values (true, 150::bigint)$$,
  'first attendance claim grants 50 points'
);
select results_eq(
  $$select awarded, balance from public.claim_attendance_reward()$$,
  $$values (false, 150::bigint)$$,
  'attendance cannot be rewarded twice within 24 hours'
);

select ok(public.publish_conversation_card('수다', '첫 번째 자동화 테스트 톡', null, null) is not null, 'first talk card is published');
select is(public.my_point_balance(), 200::bigint, 'first talk write grants 50 points');
select ok(public.publish_conversation_card('친구', '두 번째 자동화 테스트 톡', null, null) is not null, 'second talk card is published');
select is(public.my_point_balance(), 200::bigint, 'second talk write within 24 hours grants no extra points');

reset role;
insert into public.conversation_cards(id, author_id, purpose, topic, interests, is_active, created_at, expires_at)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '수다', '포인트 차감 테스트 상대', '{}', true, now(), now() + interval '30 days');

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select ok(public.create_chat_request('20000000-0000-4000-8000-000000000001', '안') is not null, 'one-character chat request is created');
select is(public.my_point_balance(), 100::bigint, 'chat request atomically charges 100 points');
select results_eq(
  $$select receiver_id, opening_message from public.chat_requests
    where card_id = '20000000-0000-4000-8000-000000000001'::uuid and sender_id = public.current_account_id()$$,
  $$values ('10000000-0000-4000-8000-000000000002'::uuid, '안'::text)$$,
  'request is stored for the correct receiver'
);
select is(
  public.create_chat_request('20000000-0000-4000-8000-000000000001', '갱신한 신청입니다'),
  (select id from public.chat_requests where card_id = '20000000-0000-4000-8000-000000000001'::uuid and sender_id = public.current_account_id()),
  'resending refreshes the existing request instead of adding another row'
);
select is(public.my_point_balance(), 0::bigint, 'a refreshed request still charges 100 points');

reset role;
update public.point_wallets set balance = 50 where user_id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select is(
  pg_temp.run_error($$select public.create_chat_request('20000000-0000-4000-8000-000000000001', '잔액 부족 신청')$$),
  'insufficient_points',
  'insufficient balance rejects a chat request'
);
select results_eq(
  $$select balance, (select count(*) from public.chat_requests where card_id = '20000000-0000-4000-8000-000000000001'::uuid and sender_id = public.current_account_id())
    from public.point_wallets where user_id = public.current_account_id()$$,
  $$values (50::bigint, 1::bigint)$$,
  'failed request neither deducts points nor creates another request'
);

update public.profiles set avatar_url = 'https://example.invalid/my-photo.jpg' where id = public.current_account_id();
select is((select avatar_url from public.profiles where id = public.current_account_id()), 'https://example.invalid/my-photo.jpg', 'user can update own free profile photo field');
update public.profiles set avatar_url = 'https://example.invalid/intrusion.jpg' where id = '10000000-0000-4000-8000-000000000002';
reset role;
select is((select avatar_url from public.profiles where id = '10000000-0000-4000-8000-000000000002'), null, 'RLS prevents updating another profile photo');
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select alike(pg_temp.run_error($$update public.profiles set trust_score = 100 where id = public.current_account_id()$$), '%permission denied%', 'operator-owned profile fields reject app updates');

reset role;
update public.point_wallets set balance = 900 where user_id = '10000000-0000-4000-8000-000000000001';
update public.chat_requests set status = 'accepted', responded_at = now()
where card_id = '20000000-0000-4000-8000-000000000001' and sender_id = '10000000-0000-4000-8000-000000000001';
insert into public.chat_rooms(id, request_id)
select '30000000-0000-4000-8000-000000000001', id from public.chat_requests
where card_id = '20000000-0000-4000-8000-000000000001' and sender_id = '10000000-0000-4000-8000-000000000001';
insert into public.chat_members(room_id, user_id) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');
insert into public.messages(room_id, sender_id, body, created_at) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '최근 메시지', now()),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '31일 전 메시지', now() - interval '31 days');

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select is((select count(*) from public.messages where room_id = '30000000-0000-4000-8000-000000000001'), 1::bigint, 'room member sees only the recent 30-day message window');
select lives_ok($$insert into public.messages(room_id, sender_id, body) values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '정상 전송')$$, 'room member can send as self');
select alike(pg_temp.run_error($$insert into public.messages(room_id, sender_id, body) values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '발신자 위조')$$), '%row-level security%', 'room member cannot spoof another sender');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000003"}', true);
select is((select count(*) from public.chat_rooms where id = '30000000-0000-4000-8000-000000000001'), 0::bigint, 'third party cannot read another room');
select is((select count(*) from public.messages where room_id = '30000000-0000-4000-8000-000000000001'), 0::bigint, 'third party cannot read another room messages');
select alike(pg_temp.run_error($$insert into public.messages(room_id, sender_id, body) values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', '침입 메시지')$$), '%row-level security%', 'third party cannot send into another room');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select lives_ok($$insert into storage.objects(bucket_id, name) values ('chat-images', '30000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/test.jpg')$$, 'room member can upload into own chat image folder');
select alike(pg_temp.run_error($$insert into storage.objects(bucket_id, name) values ('chat-images', '30000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/spoof.jpg')$$), '%row-level security%', 'member cannot upload into another sender folder');
select is((select count(*) from storage.objects where bucket_id = 'chat-images' and name like '30000000-0000-4000-8000-000000000001/%'), 1::bigint, 'room member can read chat image metadata');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000003"}', true);
select alike(pg_temp.run_error($$insert into storage.objects(bucket_id, name) values ('chat-images', '30000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000003/intruder.jpg')$$), '%row-level security%', 'third party cannot upload into another room');
select is((select count(*) from storage.objects where bucket_id = 'chat-images' and name like '30000000-0000-4000-8000-000000000001/%'), 0::bigint, 'third party cannot read chat image metadata');

reset role;
insert into public.blocks(blocker_id, blocked_id) values ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select alike(pg_temp.run_error($$insert into public.messages(room_id, sender_id, body) values ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '차단 후 메시지')$$), '%row-level security%', 'blocked users cannot send messages');

reset role;
update public.chat_rooms set closed_at = now() where id = '30000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"10000000-0000-4000-8000-000000000001"}', true);
select is((select count(*) from storage.objects where bucket_id = 'chat-images' and name like '30000000-0000-4000-8000-000000000001/%'), 0::bigint, 'closed rooms no longer expose chat image metadata');
select is((select count(*) from public.point_wallets), 1::bigint, 'wallet RLS exposes only the current user wallet');

select * from finish();
rollback;

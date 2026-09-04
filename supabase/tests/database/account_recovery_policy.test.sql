begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(26);
create temporary table recovery_alias_baseline(value bigint);
insert into pg_temp.recovery_alias_baseline select count(*) from account_private.account_recovery_aliases;

create function pg_temp.audit_uid(slot integer) returns uuid language sql immutable as $$
  select ('94000000-0000-4000-8000-'||lpad(slot::text,12,'0'))::uuid
$$;
create function pg_temp.audit_aid(slot integer) returns uuid language sql immutable as $$
  select ('95000000-0000-4000-8000-'||lpad(slot::text,12,'0'))::uuid
$$;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select pg_temp.audit_uid(slot),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  '8210555'||lpad(slot::text,4,'0'),now(),false,now(),now()
from generate_series(1,15) slot;
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
select pg_temp.audit_aid(slot),pg_temp.audit_uid(slot),repeat(to_hex(slot),64),repeat('d',63)||substr(to_hex(slot),1,1),'phone',repeat('e',63)||substr(to_hex(slot),1,1)
from generate_series(1,14) slot;
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select pg_temp.audit_aid(slot),pg_temp.audit_uid(slot),'phone',repeat(to_hex(slot),64)
from generate_series(1,14) slot;

select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(1)),'discardable','technical phone principal is discardable');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(1),'기기지갑이력',1990,'TEST','male');
with released_wallet as (
  insert into public.device_point_wallets(device_hash,balance)
  values(repeat('1',64),999) returning id
)
insert into public.device_wallet_bindings(wallet_id,user_id,released_at,recovery_reason)
select id,pg_temp.audit_aid(1),now(),'reinstall' from released_wallet;
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(1)),'discardable','released legacy wallet history does not block recovery');
with active_wallet as (
  insert into public.device_point_wallets(device_hash,balance)
  values(repeat('2',64),0) returning id
)
insert into public.device_wallet_bindings(wallet_id,user_id,recovery_reason)
select id,pg_temp.audit_aid(1),'reinstall' from active_wallet;
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(1)),'discardable','matching active legacy wallet does not block recovery');
update public.device_point_wallets set balance=1 where device_hash=repeat('2',64);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(1)),'wallet_binding','active legacy wallet mismatch still blocks recovery');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(2),'무료계정',1990,'TEST','male');
insert into public.point_transactions(user_id,amount,reason) values
  (pg_temp.audit_aid(2),100,'welcome_account'),(pg_temp.audit_aid(2),50,'reward_attendance');
update public.point_wallets set balance=150 where user_id=pg_temp.audit_aid(2);
insert into public.point_reward_claims(user_id,reward_type,claimed_at)
values(pg_temp.audit_aid(2),'attendance',now());
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(2)),'discardable','profile plus exact free rewards remains discardable');
insert into public.point_transactions(user_id,amount,reason,reference_id)
values(pg_temp.audit_aid(2),-100,'chat_request',gen_random_uuid());
update public.point_wallets set balance=50 where user_id=pg_temp.audit_aid(2);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(2)),'point_spent','spending points blocks automatic retirement');
select is(account_private.phone_recovery_rejection_reason(pg_temp.audit_aid(2)),'point_spent','internal audit exposes the exact non-PII rejection reason');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(3),'구매계정',1990,'TEST','male');
insert into public.point_purchase_receipts(provider_event_id,store_transaction_id,user_id,product_id,point_amount,price_won,store,environment)
values('audit-event-3','audit-tx-3',pg_temp.audit_aid(3),'kr.ingtalk.points.3000',3000,3000,'TEST_STORE','SANDBOX');
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(3)),'purchase_exists','purchase receipt blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender) values
  (pg_temp.audit_aid(4),'대화계정',1990,'TEST','male'),
  (pg_temp.audit_aid(5),'상대계정',1990,'TEST','female');
with card as (
  insert into public.conversation_cards(author_id,purpose,topic) values(pg_temp.audit_aid(5),'수다','감사 테스트 대화 주제') returning id
), request_row as (
  insert into public.chat_requests(card_id,sender_id,receiver_id,opening_message,status)
  select id,pg_temp.audit_aid(4),pg_temp.audit_aid(5),'감사 메시지','accepted' from card returning id
), room_row as (
  insert into public.chat_rooms(request_id) select id from request_row returning id
)
insert into public.messages(room_id,sender_id,body) select id,pg_temp.audit_aid(4),'보존해야 할 메시지' from room_row;
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(4)),'user_activity','message activity blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender,introduction)
values(pg_temp.audit_aid(6),'소개계정',1990,'TEST','male','보존해야 할 자기소개');
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(6)),'profile_activity','custom profile blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(7),'설정계정',1990,'TEST','male');
insert into public.notification_preferences(user_id,message_enabled) values(pg_temp.audit_aid(7),false);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(7)),'custom_settings','custom settings block automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(14),'수다방알림설정',1990,'TEST','female');
insert into public.notification_preferences(user_id,open_chat_enabled) values(pg_temp.audit_aid(14),false);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(14)),'custom_settings','open-chat notification settings block automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(8),'파일계정',1990,'TEST','male');
insert into storage.objects(bucket_id,name) values('avatars',pg_temp.audit_aid(8)::text||'/audit.jpg');
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(8)),'storage_exists','phone-owned storage blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(9),'유료포인트',1990,'TEST','male');
insert into public.point_transactions(user_id,amount,reason) values(pg_temp.audit_aid(9),10,'admin_adjustment');
update public.point_wallets set balance=10 where user_id=pg_temp.audit_aid(9);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(9)),'admin_adjustment_exists','admin adjustment blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(10),'불일치계정',1990,'TEST','male');
update public.point_wallets set balance=1 where user_id=pg_temp.audit_aid(10);
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(10)),'ledger_mismatch','wallet and ledger mismatch blocks automatic retirement');

insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(pg_temp.audit_aid(11),'광고대기',1990,'TEST','male');
insert into account_private.rewarded_ad_claims(account_id,scope_hash) values(pg_temp.audit_aid(11),repeat('f',64));
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(11)),'pending_reward','pending rewarded-ad callback blocks automatic retirement');

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
values(pg_temp.audit_aid(12),pg_temp.audit_uid(13),'google',repeat('a',64));
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(12)),'identity_conflict','social-protected account is never disposable');

insert into public.profiles(id,nickname,birth_year,region_code,gender,welcome_points_claimed)
values(pg_temp.audit_aid(13),'레거시기준',1990,'TEST','male',true);
update public.point_wallets set balance=1000 where user_id=pg_temp.audit_aid(13);
insert into account_private.point_wallet_historical_baselines(account_id,amount,source)
values(pg_temp.audit_aid(13),1000,'migration_024_opening_balance');
select is(account_private.phone_recovery_disposition(pg_temp.audit_aid(13)),'discardable','verified migration 024 baseline is accounting-consistent bootstrap value');

select ok(account_private.phone_transport_unambiguous(pg_temp.audit_uid(14)),'confirmed phone without pending changes is unambiguous');
-- Use the unbound Auth fixture for transport-state mutation. Bound identities
-- are intentionally protected from direct phone changes by the production trigger.
update auth.users set phone_change='82109990000' where id=pg_temp.audit_uid(15);
select ok(not account_private.phone_transport_unambiguous(pg_temp.audit_uid(15)),'own pending phone change blocks phone identity');
update auth.users set phone_change=null where id=pg_temp.audit_uid(15);
update auth.users set phone_change=(select phone from auth.users where id=pg_temp.audit_uid(14)) where id=pg_temp.audit_uid(15);
select ok(not account_private.phone_transport_unambiguous(pg_temp.audit_uid(14)),'another Auth row pending the same phone blocks phone identity');
select is(account_private.identity_hash(pg_temp.audit_uid(14),'phone'),null,'ambiguous phone transport produces no app identity hash');

select ok(not has_table_privilege('authenticated','account_private.account_recovery_aliases','select'),'clients cannot read recovery aliases');
select ok(not has_function_privilege('authenticated','account_private.phone_recovery_disposition(uuid)','execute'),'clients cannot execute recovery classification');
select ok(not has_function_privilege('anon','account_private.phone_transport_unambiguous(uuid)','execute'),'anonymous clients cannot inspect phone transitions');
select is((select count(*) from account_private.account_recovery_aliases),(select value from pg_temp.recovery_alias_baseline),'recovery classification does not create aliases');

select * from finish();
rollback;

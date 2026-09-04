begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(30);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('9b000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.login(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',pg_temp.uid(n),'role','authenticated','session_id',pg_temp.uid(n+500),
    'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
create temporary table tap_output(line text);
grant all on pg_temp.tap_output to authenticated;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,email,email_confirmed_at,is_anonymous,created_at,updated_at) values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821011112222',now(),null,null,false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'google-payer@example.invalid',now(),false,now(),now()),
  (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(4),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821033334444',now(),null,null,false,now(),now()),
  (pg_temp.uid(5),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'both@example.invalid',now(),false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821099991111',now(),null,null,false,now(),now());
insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
  (gen_random_uuid(),pg_temp.uid(2),'google','payer-google','{"sub":"payer-google","email":"google-payer@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(3),'kakao','123456789','{"sub":"123456789"}'),
  (gen_random_uuid(),pg_temp.uid(5),'google','both-google','{"sub":"both-google","email":"both@example.invalid","email_verified":true}');
insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),
  (pg_temp.uid(103),pg_temp.uid(3)),(pg_temp.uid(104),pg_temp.uid(4)),
  (pg_temp.uid(105),pg_temp.uid(5)),(pg_temp.uid(106),pg_temp.uid(1)),
  (pg_temp.uid(191),pg_temp.uid(91));
insert into public.profiles(id,nickname,birth_year,region_code,gender,status) values
  (pg_temp.uid(101),'전화결제자',1990,'TEST','male','active'),
  (pg_temp.uid(102),'구글결제자',1990,'TEST','female','active'),
  (pg_temp.uid(103),'카카오결제자',1990,'TEST','male','active'),
  (pg_temp.uid(104),'복합결제자',1990,'TEST','female','suspended'),
  (pg_temp.uid(105),'현재통합계정',1990,'TEST','female','active'),
  (pg_temp.uid(106),'과거원본계정',1990,'TEST','male','active'),
  (pg_temp.uid(191),'일반사용자',1990,'TEST','male','active');
insert into account_private.account_devices(id,account_id,device_hash,device_scope_hash,platform,is_primary)
values(pg_temp.uid(192),pg_temp.uid(191),repeat('9a',32),repeat('9b',32),'android',true);
insert into auth.sessions(id,user_id) values(pg_temp.uid(591),pg_temp.uid(91));
insert into account_private.sessions(session_id,user_id,account_id,device_id)
values(pg_temp.uid(591),pg_temp.uid(91),pg_temp.uid(191),pg_temp.uid(192));
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash,linked_at) values
  (pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'),now()-interval '4 days'),
  (pg_temp.uid(102),pg_temp.uid(2),'google',account_private.identity_hash(pg_temp.uid(2),'google'),now()-interval '3 days'),
  (pg_temp.uid(103),pg_temp.uid(3),'kakao',account_private.identity_hash(pg_temp.uid(3),'kakao'),now()-interval '2 days'),
  (pg_temp.uid(104),pg_temp.uid(4),'phone',account_private.identity_hash(pg_temp.uid(4),'phone'),now()-interval '2 days'),
  (pg_temp.uid(104),pg_temp.uid(5),'google',account_private.identity_hash(pg_temp.uid(5),'google'),now()-interval '1 day'),
  (pg_temp.uid(191),pg_temp.uid(91),'phone',account_private.identity_hash(pg_temp.uid(91),'phone'),now());
insert into account_private.account_recovery_aliases(retired_account_id,canonical_account_id,reason)
values(pg_temp.uid(106),pg_temp.uid(105),'verified_account_merge');

insert into public.point_purchase_receipts(
  id,provider_event_id,store_transaction_id,user_id,original_account_id,product_id,point_amount,price_won,store,environment,status,
  unrecovered_points,purchased_at,refunded_at,raw_event,purchase_currency,purchase_amount,purchase_country_code,account_deleted_at,created_at)
values
  (pg_temp.uid(201),'payer-event-1','payer-phone-transaction-111111',pg_temp.uid(101),pg_temp.uid(101),'kr.ingtalk.points.3000',3000,3000,'PLAY_STORE','PRODUCTION','credited',0,now()-interval '5 hours',null,'{"private":"phone"}','KRW',3000,'KR',null,now()-interval '5 hours'),
  (pg_temp.uid(202),'payer-event-2','payer-google-transaction-222222',pg_temp.uid(102),pg_temp.uid(102),'kr.ingtalk.points.5000',5000,5000,'PLAY_STORE','PRODUCTION','credited',0,now()-interval '4 hours',null,'{"private":"google"}','KRW',5000,'KR',null,now()-interval '4 hours'),
  (pg_temp.uid(203),'payer-event-3','payer-kakao-transaction-333333',pg_temp.uid(103),pg_temp.uid(103),'kr.ingtalk.points.10000',10000,10000,'APP_STORE','SANDBOX','refunded',1000,now()-interval '3 hours',now()-interval '1 hour','{"private":"kakao"}','KRW',10000,'KR',null,now()-interval '3 hours'),
  (pg_temp.uid(204),'payer-event-4','payer-both-transaction-444444',pg_temp.uid(104),pg_temp.uid(104),'kr.ingtalk.points.30000',30000,30000,'PLAY_STORE','SANDBOX','credited',0,now()-interval '2 hours',null,'{}','KRW',30000,'KR',null,now()-interval '2 hours'),
  (pg_temp.uid(205),'payer-event-5','payer-merged-transaction-555555',pg_temp.uid(106),pg_temp.uid(106),'kr.ingtalk.points.50000',50000,50000,'PLAY_STORE','SANDBOX','credited',0,now()-interval '1 hour',null,'{}','KRW',50000,'KR',null,now()-interval '1 hour'),
  (pg_temp.uid(206),'payer-event-6','payer-deleted-transaction-666666',null,pg_temp.uid(107),'kr.ingtalk.points.100000',100000,99000,'PLAY_STORE','SANDBOX','refunded',5000,now(),now(),'{}','KRW',99000,'KR',now(),now());

insert into tap_output select ok(not has_function_privilege('anon','public.admin_list_point_purchases(text,text,integer)','EXECUTE'),'anonymous cannot list payer identity data');
insert into tap_output select ok(not has_function_privilege('authenticated','account_private.admin_purchase_payer_summary(uuid)','EXECUTE'),'authenticated cannot call private payer helper');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.users','SELECT'),'authenticated cannot read Auth users');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.identities','SELECT'),'authenticated cannot read Auth identities');

set local role authenticated;
select pg_temp.login(91);
insert into tap_output select is(pg_temp.error($$select * from public.admin_list_point_purchases(null,null,200)$$),'admin_required','ordinary user cannot list payment identities');
select pg_temp.login(90);

insert into tap_output select is((select payer#>>'{phone,status}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'active','phone payer has active phone');
insert into tap_output select is((select payer#>>'{phone,phone}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'821011112222','phone payer resolves authoritative Auth phone');
insert into tap_output select ok((select (payer#>>'{phone,verified_at}')::timestamptz is not null from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'phone verification time included');
insert into tap_output select is((select payer#>>'{google,email}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(202)),'google-payer@example.invalid','Google payer resolves authoritative identity email');
insert into tap_output select is((select payer#>>'{kakao,status}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(203)),'active','Kakao payer connection included');
insert into tap_output select ok((select (payer#>>'{kakao,verified_at}')::timestamptz is not null from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(203)),'Kakao verification time included');
insert into tap_output select is((select payer#>>'{phone,status}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(204)),'active','multi-provider payer includes phone');
insert into tap_output select is((select payer#>>'{google,email}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(204)),'both@example.invalid','multi-provider payer includes Google');
insert into tap_output select is((select payer->>'account_status' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(204)),'suspended','current account status included');
insert into tap_output select is((select payer->>'original_account_id' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(205)),pg_temp.uid(106)::text,'merged receipt original account reference remains unchanged');
insert into tap_output select is((select payer->>'canonical_account_id' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(205)),pg_temp.uid(105)::text,'merged receipt resolves current canonical account');
insert into tap_output select is((select payer->>'canonical_nickname' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(205)),'현재통합계정','merged receipt shows canonical nickname separately');
insert into tap_output select is((select payer->>'merged' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(205)),'true','merged relation is explicit');
insert into tap_output select ok((select user_id is null and payer->>'original_account_id'=pg_temp.uid(107)::text and payer->>'account_status'='deleted' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(206)),'deleted receipt preserves only immutable original account identifier');
insert into tap_output select is((select payer#>>'{phone,status}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(206)),'none','deleted receipt has safe phone fallback');
insert into tap_output select is((select payer#>>'{google,status}' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(206)),'none','deleted receipt has safe Google fallback');
insert into tap_output select is((select count(*) from public.admin_list_point_purchases(null,'refunded',200)),2::bigint,'existing status filter remains effective');
insert into tap_output select is((select count(*) from public.admin_list_point_purchases(null,null,2)),2::bigint,'existing result limit remains effective');
insert into tap_output select is((select receipt_id from public.admin_list_point_purchases(null,null,1)),pg_temp.uid(206),'existing newest-first order remains effective');
insert into tap_output select is((select payment_provider from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'revenuecat','payment provider included');
insert into tap_output select ok((select point_amount=3000 and purchase_amount=3000 and purchase_currency='KRW' and store='PLAY_STORE' and environment='PRODUCTION' and status='credited' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'existing payment and point fields remain unchanged');
insert into tap_output select is((select transaction_reference from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'paye…111111','transaction reference remains masked');
insert into tap_output select ok((select row_to_json(result)::text not like '%payer-phone-transaction-111111%' and row_to_json(result)::text not like '%"private":"phone"%' from public.admin_list_point_purchases(null,null,200) result where receipt_id=pg_temp.uid(201)),'raw transaction and provider payload remain private');
insert into tap_output select is((select payer->>'nickname' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(201)),'전화결제자','payment A is not mixed with another payer');
insert into tap_output select is((select payer->>'nickname' from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(202)),'구글결제자','payment B is not mixed with payment A payer');

insert into tap_output select * from finish();
select line from tap_output;
rollback;

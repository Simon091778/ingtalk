begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(56);
create function pg_temp.uid(n integer) returns uuid language sql as $$select ('85000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.login(n integer,session_number integer default 0) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.uid(n),'role','authenticated','session_id',pg_temp.uid(session_number),
    'amr',jsonb_build_array(jsonb_build_object('method',case when n>=4 then 'password' else 'otp' end,'timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
create temporary table ops_result(value jsonb);
grant all on pg_temp.ops_result to authenticated;
insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select pg_temp.uid(n),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','82109985'||lpad(n::text,4,'0'),now(),false,now(),now() from generate_series(1,7) n;
insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(4),'reviewer',true),(pg_temp.uid(5),'moderator',true),(pg_temp.uid(6),'owner',true),(pg_temp.uid(7),'owner',false);
insert into account_private.device_accounts(id,auth_user_id) values(pg_temp.uid(11),pg_temp.uid(1)),(pg_temp.uid(12),pg_temp.uid(2));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(pg_temp.uid(11),'관리테스트',1990,'TEST','male'),(pg_temp.uid(12),'다른계정',1990,'TEST','female');
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
values(pg_temp.uid(11),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'));
insert into account_private.account_devices(id,account_id,device_hash,device_scope_hash,platform,is_primary,created_at) values
  (pg_temp.uid(21),pg_temp.uid(11),'secret-key-a','shared-secret-scope','android',true,now()-interval '3 days'),
  (pg_temp.uid(22),pg_temp.uid(11),'secret-key-b','other-secret-scope','ios',false,now()-interval '2 days'),
  (pg_temp.uid(23),pg_temp.uid(12),'secret-key-c','shared-secret-scope','android',true,now()-interval '1 day');
insert into auth.sessions(id,user_id) values(pg_temp.uid(31),pg_temp.uid(1)),(pg_temp.uid(32),pg_temp.uid(1)),(pg_temp.uid(33),pg_temp.uid(2));
insert into account_private.sessions(session_id,user_id,account_id,device_id) values
  (pg_temp.uid(31),pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(21)),
  (pg_temp.uid(32),pg_temp.uid(1),pg_temp.uid(11),pg_temp.uid(22)),
  (pg_temp.uid(33),pg_temp.uid(2),pg_temp.uid(12),pg_temp.uid(23));
insert into public.point_reward_claims(user_id,reward_type,claimed_at) values(pg_temp.uid(11),'attendance',now()-interval '2 hours');
insert into account_private.device_reward_claims(scope_hash,reward_type,claimed_at) values('shared-secret-scope','attendance',now()-interval '1 hour');
insert into account_private.rewarded_ad_claims(token,account_id,scope_hash,created_at,expires_at,processed_at,awarded) values
  (pg_temp.uid(41),pg_temp.uid(11),'shared-secret-scope',now(),now()+interval '24 hours',null,false),
  (pg_temp.uid(42),pg_temp.uid(11),'shared-secret-scope',now()-interval '1 minute',now()+interval '24 hours',now(),true),
  (pg_temp.uid(43),pg_temp.uid(11),'shared-secret-scope',now()-interval '2 minutes',now()+interval '24 hours',now(),false),
  (pg_temp.uid(44),pg_temp.uid(11),'shared-secret-scope',now()-interval '2 days',now()-interval '1 day',null,false),
  (pg_temp.uid(45),pg_temp.uid(12),'shared-secret-scope',now(),now()+interval '24 hours',null,false);
insert into public.rewarded_ad_verifications(provider,transaction_id,user_id,awarded,verification_payload)
values('admob','private-transaction',pg_temp.uid(11),true,'{"private":"private-payload"}');
insert into account_private.account_merge_audit(
  id,survivor_account_id,losing_account_id,source_session_id,verified_session_id,verified_provider,
  survivor_balance,losing_balance,merged_balance,losing_point_ledger,asset_counts,created_at)
values(pg_temp.uid(61),pg_temp.uid(11),pg_temp.uid(12),pg_temp.uid(62),pg_temp.uid(63),'google',
  100,300,300,'[{"reference_id":"private-ledger-reference"}]',
  '{"policy":"discard_losing_assets","posts":2,"comments":3,"messages":4,"purchases":1,"conversation_cards":5,"open_chat_messages":6}',now());
insert into public.point_purchase_receipts(
  id,provider_event_id,store_transaction_id,user_id,original_account_id,product_id,point_amount,price_won,store,environment,status,
  unrecovered_points,purchased_at,raw_event,purchase_currency,purchase_amount,purchase_country_code,account_deleted_at)
values
  (pg_temp.uid(51),'private-event-1','full-private-transaction-123456',pg_temp.uid(11),pg_temp.uid(11),'kr.ingtalk.points.3000',3000,3000,'PLAY_STORE','SANDBOX','credited',0,now(),'{"private":"provider-payload"}','KRW',3000,'KR',null),
  (pg_temp.uid(52),'private-event-2','deleted-private-transaction-654321',null,pg_temp.uid(99),'kr.ingtalk.points.5000',5000,5000,'PLAY_STORE','SANDBOX','refunded',100,now()-interval '1 day','{}','KRW',5000,'KR',now());

select ok(not has_function_privilege('anon','public.admin_get_account_operations(uuid)','EXECUTE'),'anonymous cannot read');
select ok(not has_function_privilege('anon','public.admin_revoke_device_sessions(uuid,uuid,text)','EXECUTE'),'anonymous cannot revoke');
select ok(not has_function_privilege('anon','public.admin_list_account_merges(text,integer)','EXECUTE'),'anonymous cannot list merge audit');
select ok(not has_function_privilege('anon','public.admin_list_point_purchases(text,text,integer)','EXECUTE'),'anonymous cannot list purchase evidence');
set local role authenticated; select pg_temp.login(1,31);
select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(11))$$),'admin_required','ordinary user cannot inspect even own account via admin');
select is(pg_temp.error($$select public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),'test')$$),'admin_role_required','ordinary user cannot revoke');
select is(pg_temp.error($$select * from public.admin_list_account_merges(null,200)$$),'admin_required','ordinary user cannot list account merges');
select is(pg_temp.error($$select * from public.admin_list_point_purchases(null,null,200)$$),'admin_required','ordinary user cannot list purchase evidence');
select pg_temp.login(7);
select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(11))$$),'account_unlock_required','inactive admin denied by account gate');
select pg_temp.login(4);
select is(public.current_account_id(),pg_temp.uid(4),'password admin passes app account gate');
insert into pg_temp.ops_result select public.admin_get_account_operations(pg_temp.uid(11));
select is((select value->>'account_id' from pg_temp.ops_result),pg_temp.uid(11)::text,'read scoped to selected app account');
select is((select jsonb_array_length(value->'devices') from pg_temp.ops_result),2,'only selected account devices');
select is((select value#>>'{identities,0,provider}' from pg_temp.ops_result),'phone','linked provider visible');
select is((select value#>>'{identities,0,active}' from pg_temp.ops_result),'true','active identity detected');
select is((select value#>>'{phone,status}' from pg_temp.ops_result),'active','admin account detail includes active phone status');
select is((select value#>>'{phone,phone}' from pg_temp.ops_result),'821099850001','admin account detail includes authoritative Auth phone');
select is((select value#>>'{devices,0,active_sessions}' from pg_temp.ops_result),'1','authorized session count');
select is((select value#>>'{devices,0,rewards,0,available}' from pg_temp.ops_result),'false','shared device reward cooldown');
select is((select (value#>>'{devices,0,rewards,0,next_available_at}')::timestamptz from pg_temp.ops_result),now()+interval '23 hours','later of account and device cooldown');
select is((select (value#>>'{devices,1,rewards,0,next_available_at}')::timestamptz from pg_temp.ops_result),now()+interval '22 hours','other device still limited by account');
select is((select value#>>'{devices,0,rewards,1,available}' from pg_temp.ops_result),'true','unclaimed activity available');
select is((select jsonb_array_length(value->'ad_claims') from pg_temp.ops_result),4,'other account ad claims excluded');
select is((select value#>>'{ad_claims,0,status}' from pg_temp.ops_result),'pending','pending is not a grant');
select is((select value#>>'{ad_claims,1,status}' from pg_temp.ops_result),'awarded','awarded status');
select is((select value#>>'{ad_claims,2,status}' from pg_temp.ops_result),'denied','denied status');
select is((select value#>>'{ad_claims,3,status}' from pg_temp.ops_result),'expired','expired status');
select ok((select value::text !~ 'secret|private-payload|private-transaction|identity_hash|auth_user_id|session_id|verification_payload' and value::text not like '%'||pg_temp.uid(41)::text||'%' from pg_temp.ops_result),'private credentials and ticket omitted');
select is((select count(*) from public.admin_list_account_merges('관리테스트',200)),1::bigint,'reviewer can search merge history by survivor nickname');
select is((select survivor_nickname from public.admin_list_account_merges(null,200) where merge_id=pg_temp.uid(61)),'관리테스트','merge history identifies surviving profile');
select is((select asset_policy from public.admin_list_account_merges(null,200) where merge_id=pg_temp.uid(61)),'discard_losing_assets','merge asset policy visible');
select is((select deleted_posts from public.admin_list_account_merges(null,200) where merge_id=pg_temp.uid(61)),2,'deleted asset count visible');
select is((select point_ledger_entries from public.admin_list_account_merges(null,200) where merge_id=pg_temp.uid(61)),1,'losing ledger count visible');
select ok((select row_to_json(result)::text not like '%private-ledger-reference%' from public.admin_list_account_merges(null,200) result where merge_id=pg_temp.uid(61)),'merge audit omits private ledger and session details');
select is((select count(*) from public.admin_list_point_purchases('private-transaction',null,200)),2::bigint,'reviewer can list purchase evidence');
select is((select nickname from public.admin_list_point_purchases('관리테스트',null,200) where receipt_id=pg_temp.uid(51)),'관리테스트','purchase search resolves active nickname');
select is((select transaction_reference from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(51)),'full…123456','transaction reference is masked');
select ok((select row_to_json(result)::text not like '%provider-payload%' and row_to_json(result)::text not like '%full-private-transaction-123456%' from public.admin_list_point_purchases(null,null,200) result where receipt_id=pg_temp.uid(51)),'purchase result omits raw payload and full transaction identifier');
select ok((select user_id is null and payer->>'original_account_id'=pg_temp.uid(99)::text and account_deleted_at is not null from public.admin_list_point_purchases(null,null,200) where receipt_id=pg_temp.uid(52)),'anonymized purchase tombstone retains immutable original payer');
select is((select count(*) from public.admin_list_point_purchases('private-transaction','refunded',200)),1::bigint,'purchase status filter works');
select is(pg_temp.error($$select * from public.admin_list_point_purchases(null,'invalid',200)$$),'invalid_status_filter','invalid purchase status rejected');
select is(pg_temp.error($$select public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),'test')$$),'admin_role_required','reviewer cannot mutate');
select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(99))$$),'user_not_found','missing user handled');
select pg_temp.login(5);
select is(pg_temp.error($$select public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),null)$$),'invalid_admin_note','null reason rejected');
select is(pg_temp.error($$select public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),' ')$$),'invalid_admin_note','blank reason rejected');
select is(pg_temp.error($$select public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(23),'test')$$),'device_not_found','cross-account device rejected');
select is(public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),'고객 요청')->>'revoked_sessions','1','moderator can revoke selected device');
select pg_temp.login(6);
select is(public.admin_revoke_device_sessions(pg_temp.uid(11),pg_temp.uid(21),'재시도')->>'revoked_sessions','0','repeat is harmless');
reset role;
select is((select count(*) from auth.sessions where id in(pg_temp.uid(31),pg_temp.uid(32),pg_temp.uid(33))),2::bigint,'other device and account auth sessions preserved');
select is((select count(*) from account_private.sessions where session_id=pg_temp.uid(31)),0::bigint,'app grant also revoked');
select is((select count(*) from public.moderation_actions where target_user_id=pg_temp.uid(11) and action='revoke_device_sessions' and note='고객 요청' and admin_user_id=pg_temp.uid(5)),1::bigint,'audit records actor target and reason');
select is((select claimed_at from account_private.device_reward_claims where scope_hash='shared-secret-scope' and reward_type='attendance'),now()-interval '1 hour','cooldown preserved');
select is((select count(*) from account_private.account_devices where account_id=pg_temp.uid(11)),2::bigint,'recovery device bindings preserved');
select is((select count(*) from public.point_transactions where user_id=pg_temp.uid(11)),0::bigint,'no unverified point grants');
set local role authenticated; select pg_temp.login(1,31);
select is(public.current_account_id(),null::uuid,'revoked JWT cannot access app account');
select alike(pg_temp.error($$select public.authorize_device_account_v2(repeat('a1',32),'android',repeat('b2',32))$$),'%verified_phone_required%','revoked JWT cannot recreate session grant');
select pg_temp.login(1,32);
select is(public.current_account_id(),pg_temp.uid(11),'other device remains authorized');
select * from finish();
rollback;

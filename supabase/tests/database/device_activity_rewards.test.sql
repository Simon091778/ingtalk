begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(64);
create temporary table reward_state(label text primary key,result jsonb);
grant all on pg_temp.reward_state to authenticated,service_role;
create function pg_temp.uid(n integer) returns uuid language sql as $$select ('83000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.aid(k text) returns uuid language sql as $$select (result->>'account_id')::uuid from pg_temp.reward_state where label=k$$;
create function pg_temp.payload(k text) returns jsonb language sql as $$select jsonb_build_object('custom_data',result->>'custom_data') from pg_temp.reward_state where label=k$$;
create function pg_temp.session(n integer,slot integer default 1) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.uid(n),'role','authenticated',
    'phone',case when n in (1,4) then '+82109873'||lpad(n::text,4,'0') else '' end,
    'session_id',('84000000-0000-4000-8000-'||lpad((n*10+slot)::text,12,'0')),
    'amr',jsonb_build_array(jsonb_build_object('method',case when n in (1,4) then 'otp' else 'oauth' end,
      'timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select pg_temp.uid(n),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  case when n=2 then 'activity-google@example.invalid' end,case when n=2 then now() end,
  case when n in (1,4) then '82109873'||lpad(n::text,4,'0') end,case when n in (1,4) then now() end,false,now(),now()
from generate_series(1,4) n;
insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
  (gen_random_uuid(),pg_temp.uid(2),'google','activity-google','{"sub":"activity-google","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(3),'kakao','90009873','{"sub":"90009873","provider_id":"90009873","email":""}');
insert into auth.sessions(id,user_id)
select ('84000000-0000-4000-8000-'||lpad((n*10+s)::text,12,'0'))::uuid,pg_temp.uid(n)
from generate_series(1,4) n cross join generate_series(1,3) s;

select ok(not has_table_privilege('authenticated','account_private.device_reward_claims','SELECT'),'device cooldowns are private');
select ok(not has_table_privilege('authenticated','account_private.device_reward_claims','INSERT'),'client cannot forge device cooldowns');
select ok(not has_function_privilege('authenticated','account_private.credit_activity_reward(uuid,text,text[],uuid)','EXECUTE'),'client cannot choose a scope or self credit');
select ok(not has_function_privilege('authenticated','public.award_daily_action(text,uuid)','EXECUTE'),'writing rewards require real content action');
select ok(not has_function_privilege('anon','public.prepare_rewarded_ad_claim()','EXECUTE'),'anonymous cannot prepare an ad claim');
select ok(not has_table_privilege('authenticated','account_private.rewarded_ad_claims','SELECT'),'client cannot enumerate reward tickets');

select pg_temp.session(3); set local role authenticated;
insert into pg_temp.reward_state values('kakao',public.authorize_kakao_device_account(repeat('a1',32),'android',repeat('c3',32)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'활동카카오',1990,'TEST','male');
select is(public.claim_account_welcome_points(),100::bigint,'Kakao welcome stays unchanged');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (true,150::bigint)','first attendance credits 50');
select ok(public.publish_conversation_card('수다','활동 보상 테스트 이야기',null,null) is not null,'first talk is published');
select is(public.my_point_balance(),200::bigint,'talk credits 50');
insert into pg_temp.reward_state values('post',jsonb_build_object('id',public.create_board_post('활동 테스트','오늘 즐거운 하루 보내세요',null)));
select is(public.my_point_balance(),250::bigint,'post credits 50');
select ok(public.create_board_comment((select (result->>'id')::uuid from pg_temp.reward_state where label='post'),'좋은 하루 보내세요') is not null,'first comment is published');
select is(public.my_point_balance(),300::bigint,'comment credits 50');
insert into pg_temp.reward_state values('ad-a',public.prepare_rewarded_ad_claim());
select is(public.prepare_rewarded_ad_claim()->>'token',(select result->>'token' from pg_temp.reward_state where label='ad-a'),'pending ticket is reused');
select is(public.my_rewarded_ad_claim_status((select (result->>'token')::uuid from pg_temp.reward_state where label='ad-a')),'pending','unverified ad does not earn points');
select is(public.my_point_balance(),300::bigint,'preparing ad never credits points');

-- App deletion changes the installation key, but Android reinstall scope is stable.
select pg_temp.session(2);
insert into pg_temp.reward_state values('google',public.authorize_google_device_account(repeat('b2',32),'android',repeat('c3',32)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'활동구글',1990,'TEST','male');
select is(public.claim_account_welcome_points(),0::bigint,'Google welcome cannot repeat after reinstall');
select ok(pg_temp.aid('google')<>pg_temp.aid('kakao'),'independent accounts are not merged');
select results_eq('select available,next_available_at from public.my_attendance_status()', 'values (false,now()+interval ''24 hours'')','Google sees device attendance cooldown and exact deadline');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (false,0::bigint)','Google cannot duplicate attendance');
select ok(public.publish_conversation_card('수다','두 번째 계정에서도 이야기해요',null,null) is not null,'talk still publishes during reward cooldown');
select ok(public.create_board_post('다른 계정 글','글쓰기 자체는 계속 가능합니다',null) is not null,'post still publishes during reward cooldown');
select ok(public.create_board_comment((select (result->>'id')::uuid from pg_temp.reward_state where label='post'),'댓글도 작성할 수 있어요') is not null,'comment still publishes during reward cooldown');
select is(public.my_point_balance(),0::bigint,'all three content rewards are denied on shared device');
insert into pg_temp.reward_state values('ad-b',public.prepare_rewarded_ad_claim());
select is(public.my_rewarded_ad_claim_status((select (result->>'token')::uuid from pg_temp.reward_state where label='ad-a')),'unavailable','other account cannot read original ticket');
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('kakao'),'test-device','a1',pg_temp.payload('ad-a'))$$,'values (true,350::bigint)','delayed SSV credits original Kakao after switching to Google');
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('google'),'test-device','b1',pg_temp.payload('ad-b'))$$,'values (false,0::bigint)','Google SSV on same device is denied');
select alike(pg_temp.error($$select public.credit_verified_rewarded_ad(pg_temp.aid('google'),'test-device','wrong',pg_temp.payload('ad-a'))$$),'%invalid_rewarded_ad_claim%','ticket cannot be transferred to another account');
set local role authenticated;
select is(public.my_rewarded_ad_claim_status((select (result->>'token')::uuid from pg_temp.reward_state where label='ad-b')),'denied','UI can distinguish denial from a successful reward');
select results_eq('select available from public.my_rewarded_ad_status()','values (false)','Google ad status includes device cooldown');
select is(public.prepare_rewarded_ad_claim()->>'available','false','no new ad ticket while device on cooldown');

-- A different account on a genuinely different device is unaffected.
select pg_temp.session(4);
insert into pg_temp.reward_state values('other',public.authorize_device_account_v2(repeat('d4',32),'android',repeat('e5',32)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'별도기기',1990,'TEST','male');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (true,50::bigint)','other physical device has its own allowance');
insert into pg_temp.reward_state values('ad-other',public.prepare_rewarded_ad_claim());
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('other'),'test-device','other',pg_temp.payload('ad-other'))$$,'values (true,100::bigint)','other device gets separate ad reward');

-- The same Google account on another device still cannot repeat an account reward.
set local role authenticated; select pg_temp.session(2,2);
insert into pg_temp.reward_state values('google-other',public.authorize_google_device_account(repeat('f6',32),'android',repeat('e5',32)));
select is(public.current_account_id(),pg_temp.aid('google'),'Google cross-device account unchanged');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (false,0::bigint)','second device shared with other account is also blocked');

-- Exactly 24 hours, not midnight and not a lifetime ban. Failed attempts do not
-- move timestamps. Both account and device checks must be satisfied.
reset role;
update public.point_reward_claims set claimed_at=now()-interval '24 hours' where user_id in(pg_temp.aid('kakao'),pg_temp.aid('other'));
update account_private.device_reward_claims set claimed_at=now()-interval '24 hours'
 where scope_hash in(select device_scope_hash from account_private.account_devices where account_id in(pg_temp.aid('kakao'),pg_temp.aid('other')));
set local role authenticated; select pg_temp.session(2);
select results_eq('select available from public.my_attendance_status()','values (true)','device reward becomes available exactly at 24h');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (true,50::bigint)','Google can earn next period attendance');
select ok(public.publish_conversation_card('수다','다음 날 새롭게 이야기해요',null,null) is not null,'next period talk succeeds');
select ok(public.create_board_post('다음 날 글','다음 보상 시간에 작성하는 글입니다',null) is not null,'next period post succeeds');
select ok(public.create_board_comment((select (result->>'id')::uuid from pg_temp.reward_state where label='post'),'다음 날 인사드립니다') is not null,'next period comment succeeds');
select is(public.my_point_balance(),200::bigint,'all four non-ad rewards renewed once');
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('google'),'test-device','replay-denied',pg_temp.payload('ad-b'))$$,'values (false,200::bigint)','a denied ticket cannot be recycled after cooldown');
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('kakao'),'test-device','a1',pg_temp.payload('ad-a'))$$,'values (false,350::bigint)','transaction replay stays denied after cooldown');
set local role authenticated;
insert into pg_temp.reward_state values('ad-b-next',public.prepare_rewarded_ad_claim());
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('google'),'test-device','b2',pg_temp.payload('ad-b-next'))$$,'values (true,250::bigint)','fresh next-period ad grants 50');
set local role authenticated; select pg_temp.session(2,2);
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (false,250::bigint)','account cooldown prevents double rewards across different devices');
select results_eq('select available from public.my_rewarded_ad_status()','values (false)','account ad cooldown also spans devices');

select pg_temp.session(3,3);
select is(public.authorize_kakao_device_account(repeat('d4',32),'android',repeat('e5',32))->>'account_id',pg_temp.aid('kakao')::text,'Kakao can use another registered device');
insert into pg_temp.reward_state values('ad-expired',public.prepare_rewarded_ad_claim());
select is((select result->>'available' from pg_temp.reward_state where label='ad-expired'),'true','new ticket checks the viewing device, not every historical device');
reset role;
update account_private.rewarded_ad_claims set expires_at=now()-interval '1 second' where token=(select (result->>'token')::uuid from pg_temp.reward_state where label='ad-expired');
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('kakao'),'test-device','expired',pg_temp.payload('ad-expired'))$$,'values (false,350::bigint)','expired ad ticket cannot grant points');
set local role authenticated;
select is(public.my_rewarded_ad_claim_status((select (result->>'token')::uuid from pg_temp.reward_state where label='ad-expired')),'expired','expired ticket is reported accurately');

-- Keep device history even when the awarded profile/account is removed.
reset role;
delete from account_private.device_accounts where id=pg_temp.aid('google');
select ok(exists(select 1 from account_private.device_reward_claims h join account_private.account_devices v on v.device_scope_hash=h.scope_hash where v.account_id=pg_temp.aid('kakao') and h.reward_type='attendance' and h.claimed_at=now()),'device ledger survives deletion of rewarded account');
set local role authenticated; select pg_temp.session(3,2);
select is(public.authorize_kakao_device_account(repeat('c7',32),'android',repeat('c3',32))->>'account_id',pg_temp.aid('kakao')::text,'Kakao returns after another reinstall');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (false,350::bigint)','account deletion and reinstall cannot reset device cooldown');
select is(public.my_point_balance(),350::bigint,'original wallet is unchanged by Google activity');

-- Existing APK SSV remains supported, with conservative all-device checks.
set local role service_role;
select results_eq($$select awarded,balance from public.credit_verified_rewarded_ad(pg_temp.aid('kakao'),'test-device','legacy','{"custom_data":"ingtalk_rewarded_50"}')$$,'values (false,350::bigint)','legacy APK cannot bypass shared-device ad restriction');
reset role;
select is((select count(*) from account_private.device_reward_claims where reward_type='attendance' and claimed_at=now()),1::bigint,'denials do not extend or propagate cooldown to other devices');
select pg_temp.session(1); set local role authenticated;
insert into pg_temp.reward_state values('phone',public.authorize_device_account_v2(repeat('c7',32),'android',repeat('c3',32)));
select isnt(public.current_account_id(),pg_temp.aid('kakao'),'different phone on the same stable scope creates a new canonical account');
insert into public.profiles(id,nickname,birth_year,region_code,gender)
values(public.current_account_id(),'새전화계정',1990,'TEST','male');
select is(public.claim_account_welcome_points(),0::bigint,'new phone account cannot repeat device welcome');
select results_eq('select awarded,balance from public.claim_attendance_reward()','values (false,0::bigint)','new phone account cannot repeat device attendance');
select ok(public.publish_conversation_card('수다','전화 계정에서도 이야기해요',null,null) is not null,'phone account talk succeeds');
select ok(public.create_board_post('전화 계정 글','모든 로그인 수단에 같은 규칙입니다',null) is not null,'phone account post succeeds');
select ok(public.create_board_comment((select (result->>'id')::uuid from pg_temp.reward_state where label='post'),'안녕하세요 반갑습니다') is not null,'phone account comment succeeds');
select is(public.my_point_balance(),0::bigint,'new phone account cannot repeat three device content rewards');
select is(public.prepare_rewarded_ad_claim()->>'available','false','new phone account cannot repeat device ad reward');
select * from finish();
rollback;

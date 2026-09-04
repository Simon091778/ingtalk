begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(54);
create temporary table google_state(label text primary key,result jsonb);
grant all on pg_temp.google_state to authenticated,service_role;
create function pg_temp.google_id(k text) returns uuid language sql as $$select (result->>'account_id')::uuid from pg_temp.google_state where label=k$$;
create function pg_temp.google_session(slot integer,owner_number integer default 1,method text default 'oauth',age_minutes integer default 0) returns void language plpgsql as $$
declare uid text:='61000000-0000-4000-8000-00000000000'||owner_number;
begin
  perform set_config('request.jwt.claim.sub',uid,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated',
    'session_id','62000000-0000-4000-8000-00000000000'||slot,
    'amr',jsonb_build_array(jsonb_build_object('method',method,'timestamp',extract(epoch from now()-make_interval(mins=>age_minutes))::bigint)))::text,true);
end $$;
create function pg_temp.google_error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at)
select ('61000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'google-test-'||n||'@example.invalid',now(),false,now(),now() from generate_series(1,2) n;
insert into auth.identities(id,user_id,provider,provider_id,identity_data,created_at,updated_at)
select gen_random_uuid(),('61000000-0000-4000-8000-00000000000'||n)::uuid,'google','google-test-sub-'||n,
  jsonb_build_object('sub','google-test-sub-'||n,'email_verified',true),now(),now() from generate_series(1,2) n;
insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
values('61000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821098700003',now(),false,now(),now());
insert into auth.sessions(id,user_id)
select ('62000000-0000-4000-8000-00000000000'||n)::uuid,('61000000-0000-4000-8000-00000000000'||case when n=7 then 2 when n=8 then 3 else 1 end)::uuid from generate_series(1,9) n;
select ok(not has_function_privilege('anon','public.authorize_google_device_account(text,text,text)','EXECUTE'),'anonymous cannot authorize Google');
select ok(not has_function_privilege('authenticated','account_private.google_identity_hash(uuid)','EXECUTE'),'Google mapping hash remains private');
select ok(not has_table_privilege('authenticated','account_private.device_login_events','SELECT'),'cross-account login rate history is not readable by clients');
select pg_temp.google_session(1); set local role authenticated;
select is(public.current_account_id(),null::uuid,'Google OAuth alone cannot read app data');
select alike(pg_temp.google_error('select public.my_point_balance()'),'%account_unlock_required%','Google without a device grant cannot read points');
select alike(pg_temp.google_error($$select public.authorize_device_account(repeat('a',64))$$),'%verified_phone_required%','Google cannot use phone authorization');
select alike(pg_temp.google_error($$select public.authorize_google_device_account('short','android',repeat('1',64))$$),'%invalid_device_secret%','Google requires a strong device key');
insert into pg_temp.google_state values('A',public.authorize_google_device_account(repeat('a',64),'android',repeat('1',64)));
select is((select result->>'created' from pg_temp.google_state where label='A'),'true','Google creates its own device principal');
select ok(public.current_account_id()<>auth.uid(),'Google app ID differs from Auth ID');
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'구글테스트',1990,'TEST','male');
select is(public.claim_account_welcome_points(),100::bigint,'Google receives one welcome award');
select public.register_account_push_token('ExpoPushToken[google-A]','android');
reset role;
update public.point_wallets set balance=745 where user_id=pg_temp.google_id('A');
select is((select count(*) from public.active_account_push_tokens(pg_temp.google_id('A'))),1::bigint,'Google push token resolves its device principal');
select pg_temp.google_session(1); set local role authenticated;
select is(public.authorize_google_device_account(repeat('b',64),'android',repeat('2',64))->>'error','reauthenticate_required','same JWT cannot switch accounts');
select pg_temp.google_session(2);
insert into pg_temp.google_state values('B',public.authorize_google_device_account(repeat('b',64),'android',repeat('2',64)));
select is(public.current_account_id(),pg_temp.google_id('A'),'same Google on new phone uses the existing app account');
select is((select result->>'created' from pg_temp.google_state where label='B'),'false','second phone does not create a new principal');
select is((select result->>'restored' from pg_temp.google_state where label='B'),'true','second phone reports restoration');

select is(public.claim_account_welcome_points(),745::bigint,'new Google device retains balance without repeating welcome award');
select is((select count(*) from public.point_wallets where user_id=pg_temp.google_id('A')),1::bigint,'second phone reads the same wallet through RLS');
select is((select nickname from public.profiles where id=public.current_account_id()),'구글테스트','second phone keeps the same profile');
select public.register_account_push_token('ExpoPushToken[google-B]','android');
select pg_temp.google_session(4,1,'oauth',60);
select is(public.authorize_google_device_account(repeat('d',64),'ios',repeat('4',64))->>'error','fresh_google_verification_required','unknown device requires recent Google OAuth');
select pg_temp.google_session(2);
select is(public.authorize_google_device_account(repeat('a',64),'android',repeat('1',64))->>'error','reauthenticate_required','same JWT cannot switch registered devices within one account');
select pg_temp.google_session(3,1,'oauth',60);
select is(public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))->>'error','fresh_google_verification_required','old OAuth cannot rotate a reinstall key');
select pg_temp.google_session(3);
select is(public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))->>'restored','true','same Google and device restores after reinstall');
select is(public.my_point_balance(),745::bigint,'restored wallet retains its original points');
select pg_temp.google_session(1);
select is(public.current_account_id(),null::uuid,'reinstall revokes old session grants');
select pg_temp.google_session(2);
select is(public.current_account_id(),pg_temp.google_id('A'),'reinstall on phone A does not revoke phone B');
reset role;
select is((select count(*) from public.active_account_push_tokens(pg_temp.google_id('A'))),1::bigint,'only the reinstalled device push grant is revoked');
set local role authenticated;
select pg_temp.google_session(4);
select is(public.authorize_google_device_account(repeat('c',64),'web',null)->>'error','device_binding_mismatch','web cannot bypass a native device binding');
select pg_temp.google_session(4,1,'otp');
select alike(pg_temp.google_error($$select public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))$$),'%verified_google_required%','email OTP cannot claim a Google device');
select pg_temp.google_session(7,2);
insert into pg_temp.google_state values('other',public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64)));
select is((select result->>'created' from pg_temp.google_state where label='other'),'true','different Google identity starts independently on the same physical device');
select ok(public.current_account_id()<>pg_temp.google_id('A'),'shared device never selects the previous Google wallet');
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'별도구글',1990,'TEST','male');
select is(public.claim_account_welcome_points(),0::bigint,'shared device cannot repeat the welcome award under another Google');
select is((select count(*) from public.point_wallets where user_id=pg_temp.google_id('A')),0::bigint,'new Google cannot read previous account wallet');
select pg_temp.google_session(8,3);
select alike(pg_temp.google_error($$select public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))$$),'%verified_google_required%','phone identity cannot invoke Google authorization');
select set_config('request.jwt.claims',jsonb_set(jsonb_set(auth.jwt(),'{phone}','"821098700003"'),'{amr}',jsonb_build_array(jsonb_build_object('method','otp','timestamp',extract(epoch from now())::bigint)))::text,true);
insert into pg_temp.google_state values('phone',public.authorize_device_account(repeat('c',64)));
select is((select result->>'created' from pg_temp.google_state where label='phone'),'true','phone login creates its own exact legacy-device account');
reset role;
insert into account_private.device_registrations(phone_hash,scope_hash)
select 'scope-limit-test-'||n,account_private.device_scope(repeat('c',64),'android',repeat('1',64)) from generate_series(1,3) n;
insert into auth.sessions(id,user_id) values
 ('62000000-0000-4000-8000-000000000010','61000000-0000-4000-8000-000000000003'),
 ('62000000-0000-4000-8000-000000000011','61000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','61000000-0000-4000-8000-000000000003','role','authenticated',
 'session_id','62000000-0000-4000-8000-000000000010','phone','821098700003','amr',jsonb_build_array(jsonb_build_object(
 'method','otp','timestamp',extract(epoch from now())::bigint)))::text,true);
select is(public.authorize_device_account_v2(repeat('c',64),'android',repeat('1',64))->>'error','device_creation_rate_limited','shared device creation limit spans providers');
reset role; delete from account_private.device_registrations where phone_hash like 'scope-limit-test-%';
set local role authenticated;
select set_config('request.jwt.claim.sub','61000000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','61000000-0000-4000-8000-000000000003','role','authenticated',
 'session_id','62000000-0000-4000-8000-000000000011','phone','821098700003','amr',jsonb_build_array(jsonb_build_object(
 'method','otp','timestamp',extract(epoch from now())::bigint)))::text,true);
select is(public.authorize_device_account_v2(repeat('c',64),'android',repeat('1',64))->>'created','true','phone login creates a new exact pair instead of choosing scope peers');
reset role;
insert into account_private.device_login_events(scope_hash) select account_private.device_scope(repeat('c',64),'android',repeat('1',64)) from generate_series(1,20);
select pg_temp.google_session(4); set local role authenticated;
select is(public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))->>'error','account_switch_rate_limited','rapid new login sessions are limited across identities');
select pg_temp.google_session(3);
select is(public.authorize_google_device_account(repeat('c',64),'android',repeat('1',64))->>'account_id',pg_temp.google_id('A')::text,'refresh of existing session works at switch limit');
select is(public.my_point_balance(),745::bigint,'returning to original Google keeps all original points');
reset role;
update auth.users set email='changed-google-email@example.invalid' where id='61000000-0000-4000-8000-000000000001';
select pg_temp.google_session(3); set local role authenticated;
select is(public.current_account_id(),pg_temp.google_id('A'),'Google email change does not change stable subject ownership');
reset role;
update auth.users set banned_until=now()+interval '1 day' where id='61000000-0000-4000-8000-000000000001';
select is(public.current_account_id(),null::uuid,'banned Google loses access');
update auth.users set banned_until=null where id='61000000-0000-4000-8000-000000000001';
select alike(pg_temp.google_error($$insert into auth.identities(id,user_id,provider,provider_id,identity_data) values(gen_random_uuid(),'61000000-0000-4000-8000-000000000001','kakao','12345','{"sub":"12345"}')$$),'%kakao_identity_conflict%','provider-level Kakao merge is rejected before damaging Google');
delete from auth.identities where user_id='61000000-0000-4000-8000-000000000001' and provider='kakao';
select is(public.current_account_id(),pg_temp.google_id('A'),'original identity remains intact after removing conflicting identity');
-- Existing duplicate accounts are preserved; never choose an arbitrary wallet.
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash)
values('63000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',account_private.google_identity_hash('61000000-0000-4000-8000-000000000001'),repeat('8',64),'google',repeat('8',64));
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where id='63000000-0000-4000-8000-000000000001';
insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
values('63000000-0000-4000-8000-000000000001',repeat('8',64),repeat('8',64),'web',true);
select pg_temp.google_session(5); set local role authenticated;
select is(public.authorize_google_device_account(repeat('d',64),'ios',repeat('4',64))->>'error','account_resolution_required','ambiguous historical Google accounts do not auto-merge');
select is(public.current_account_id(),null::uuid,'ambiguous Google account receives no app grant');
select pg_temp.google_session(2);
select is(public.authorize_google_device_account(repeat('b',64),'android',repeat('2',64))->>'account_id',pg_temp.google_id('A')::text,'known legacy device still selects its own existing account');
reset role;
select is((select count(*) from account_private.account_identities where auth_user_id='61000000-0000-4000-8000-000000000001'),2::bigint,'ambiguous identities are preserved unchanged');
delete from account_private.device_accounts where id='63000000-0000-4000-8000-000000000001';
-- A secondary device's history must survive cleanup while the account exists.
update account_private.device_enrollment_history set retain_until=now()-interval '1 day'
 where scope_hash=(select device_scope_hash from account_private.account_devices where account_id=pg_temp.google_id('A') and not is_primary);
select public.run_retention_cleanup();
select is((select count(*) from account_private.device_enrollment_history h join account_private.account_devices v on v.device_scope_hash=h.scope_hash where v.account_id=pg_temp.google_id('A')),2::bigint,'retention protects all registered devices');
select is(public.delete_device_account_data(pg_temp.google_id('A'),'61000000-0000-4000-8000-000000000001')->>'delete_auth_identity','true','shared account deletion schedules its now-unused Google identity');
select pg_temp.google_session(2); set local role authenticated;
select is(public.current_account_id(),null::uuid,'account deletion revokes every device');
reset role;
select is((select count(*) from account_private.account_devices where account_id=pg_temp.google_id('A')),0::bigint,'all shared device bindings are deleted');
select is((select count(*) from account_private.device_enrollment_history where blocked_until>now()),2::bigint,'deletion cooldown covers both phones');
select pg_temp.google_session(9); set local role authenticated;
select is(public.authorize_google_device_account(repeat('f',64),'android',repeat('6',64))->>'error','account_deletion_pending','pending deletion cannot race Google creation');
reset role;
select ok(not exists(select 1 from public.point_wallets where user_id=pg_temp.google_id('A')),'deleted Google points are removed');
select * from finish();
rollback;

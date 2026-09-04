begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(15);
create temporary table ks(label text primary key,result jsonb);
grant all on pg_temp.ks to authenticated,service_role;
create function pg_temp.aid(k text) returns uuid language sql as $$select (result->>'account_id')::uuid from pg_temp.ks where label=k$$;
create function pg_temp.claim(uid uuid,sid uuid,method text,phone_value text default null) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','session_id',sid,
  'phone',phone_value,'amr',jsonb_build_array(jsonb_build_object('method',method,
  'timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at) values
 ('d1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
 ('d1000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now());
insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
 values('d1000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055530003',now(),false,now(),now());
insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
 (gen_random_uuid(),'d1000000-0000-4000-8000-000000000001','kakao','77000001','{"sub":"77000001","provider_id":"77000001"}'),
 (gen_random_uuid(),'d1000000-0000-4000-8000-000000000002','kakao','77000002','{"sub":"77000002","provider_id":"77000002"}');
insert into auth.sessions(id,user_id) values
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001'),
 ('d2000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001'),
 ('d2000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000002'),
 ('d2000000-0000-4000-8000-000000000004','d1000000-0000-4000-8000-000000000003');

select ok(not has_function_privilege('anon','public.authorize_kakao_device_account(text,text,text)','EXECUTE'),'anonymous cannot authorize Kakao');
select ok(not has_table_privilege('authenticated','account_private.account_identities','SELECT'),'Kakao mapping remains private');
select pg_temp.claim('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','oauth');
set local role authenticated;
insert into pg_temp.ks values('K1',public.authorize_kakao_device_account(repeat('1',64),'android',repeat('a',64)));
select is((select result->>'created' from pg_temp.ks where label='K1'),'true','Kakao creates one account');
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'카카오계정',1990,'TEST','male');
select public.claim_account_welcome_points();
select pg_temp.claim('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000002','oauth');
insert into pg_temp.ks values('K2',public.authorize_kakao_device_account(repeat('2',64),'android',repeat('b',64)));
select is(pg_temp.aid('K2'),pg_temp.aid('K1'),'same numeric Kakao subject recovers cross-device');
select is((select result->>'restored' from pg_temp.ks where label='K2'),'true','Kakao recovery is reported');
reset role;
select is((select count(*) from account_private.account_identities where account_id=pg_temp.aid('K1') and provider='kakao'),1::bigint,'one Kakao owner remains');
select is((select identity_hash from account_private.account_identities where account_id=pg_temp.aid('K1') and provider='kakao'),
 account_private.kakao_identity_hash('d1000000-0000-4000-8000-000000000001'),'Kakao hash uses provider subject');
select is(account_private.kakao_identity_hash('d1000000-0000-4000-8000-000000000001'),
 account_private.hash_phone('kakao-sub-v1:77000001'),'nickname and email are excluded from the Kakao canonical hash');

select pg_temp.claim('d1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000003','oauth');
set local role authenticated;
insert into pg_temp.ks values('OTHER',public.authorize_kakao_device_account(repeat('3',64),'android',repeat('c',64)));
select isnt(pg_temp.aid('OTHER'),pg_temp.aid('K1'),'different numeric Kakao subject creates a different account');
reset role;
select is((select count(distinct account_id) from account_private.account_identities where provider='kakao'
 and auth_user_id in('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002')),2::bigint,'distinct Kakao subjects remain independent');

-- Established Phone explicitly reauthenticates K1: verified merge is allowed.
select pg_temp.claim('d1000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000004','otp','821055530003');
set local role authenticated;
insert into pg_temp.ks values('PHONE',public.authorize_device_account_v2(repeat('4',64),'android',repeat('d',64)));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'전화계정',1990,'TEST','female');
select public.claim_account_welcome_points();
insert into pg_temp.ks values('TICKET',public.begin_account_link_v2(repeat('4',64),'android',repeat('d',64),'kakao'));
select pg_temp.claim('d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','oauth');
insert into pg_temp.ks values('MERGED',public.finish_account_link((select result->>'ticket' from pg_temp.ks where label='TICKET'),repeat('4',64),'android',repeat('d',64)));
select is(pg_temp.aid('MERGED'),pg_temp.aid('PHONE'),'fresh Kakao proof merges into current Phone account');
select is((select result->>'merged' from pg_temp.ks where label='MERGED'),'true','Kakao established merge is explicit');
reset role;
select ok(not exists(select 1 from account_private.device_accounts where id=pg_temp.aid('K1')),'old Kakao canonical is retired after verified merge');
select is((select count(*) from account_private.account_identities where account_id=pg_temp.aid('PHONE') and provider='kakao'),1::bigint,'Kakao identity belongs to survivor');
select ok(exists(select 1 from account_private.account_merge_audit where losing_account_id=pg_temp.aid('K1')),'Kakao merge is audited');

select * from finish(true);
rollback;

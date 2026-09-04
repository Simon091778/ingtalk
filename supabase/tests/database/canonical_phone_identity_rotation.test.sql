begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(26);

create temporary table policy_state(label text primary key,result jsonb);
grant all on pg_temp.policy_state to authenticated,service_role;
create function pg_temp.aid(k text) returns uuid language sql as $$
 select (result->>'account_id')::uuid from pg_temp.policy_state where label=k
$$;
create function pg_temp.phone_claim(uid uuid,sid uuid,phone_value text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated',
  'session_id',sid,'phone',phone_value,'amr',jsonb_build_array(jsonb_build_object(
   'method','otp','timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.oauth_claim(uid uuid,sid uuid) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated',
  'session_id',sid,'amr',jsonb_build_array(jsonb_build_object(
   'method','oauth','timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
create function pg_temp.attempt_phone_duplicate(target_account uuid,target_hash text)
returns void language plpgsql as $$
begin
 update account_private.account_identities
 set identity_hash=target_hash
 where account_id=target_account and provider='phone';
 set constraints account_private.enforce_single_phone_owner_deferred immediate;
end $$;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at) values
 ('b1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055510001',now(),false,now(),now()),
 ('b1000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055510002',now(),false,now(),now());
insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,is_anonymous,created_at,updated_at) values
 ('b1000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pair-google@example.invalid',now(),false,now(),now()),
 ('b1000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now());
insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
 (gen_random_uuid(),'b1000000-0000-4000-8000-000000000003','google','pair-google-sub','{"sub":"pair-google-sub","email_verified":true}'),
 (gen_random_uuid(),'b1000000-0000-4000-8000-000000000004','kakao','99112233','{"sub":"99112233","provider_id":"99112233"}');
insert into auth.sessions(id,user_id)
select ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n<=5 then 'b1000000-0000-4000-8000-000000000001'::uuid
  when n<=8 then 'b1000000-0000-4000-8000-000000000002'::uuid
  when n<=10 then 'b1000000-0000-4000-8000-000000000003'::uuid
  else 'b1000000-0000-4000-8000-000000000004'::uuid end
from generate_series(1,12) n;

-- P1: same device + same phone recovers the exact account.
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','821055510001');
set local role authenticated;
insert into pg_temp.policy_state values('A',public.authorize_device_account_v2(repeat('1',64),'android',repeat('a',64)));
select is((select result->>'created' from pg_temp.policy_state where label='A'),'true','P1 creates A');
reset role;
select ok(exists(select 1 from account_private.phone_device_bindings where account_id=pg_temp.aid('A')),'P1 stores exact pair');
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002','821055510001');
set local role authenticated;
insert into pg_temp.policy_state values('A2',public.authorize_device_account_v2(repeat('2',64),'android',repeat('a',64)));
select is(pg_temp.aid('A2'),pg_temp.aid('A'),'P1 reinstall returns A');
select is((select result->>'restored' from pg_temp.policy_state where label='A2'),'true','P1 reports reinstall recovery');
reset role;

-- P2: same device + different phone creates B without rotating A.
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000006','821055510002');
set local role authenticated;
insert into pg_temp.policy_state values('B',public.authorize_device_account_v2(repeat('3',64),'android',repeat('a',64)));
select is((select result->>'created' from pg_temp.policy_state where label='B'),'true','P2 creates B');
select isnt(pg_temp.aid('B'),pg_temp.aid('A'),'P2 B differs from A');
reset role;
select ok(exists(select 1 from account_private.device_accounts where id=pg_temp.aid('A')),'P2 preserves A');
select is((select count(distinct account_id) from account_private.phone_device_bindings where
 device_scope_hash=account_private.hash_phone('reinstall-v1:android:'||repeat('a',64))),2::bigint,'P2 scope has two independent pairs');

-- P3/P4: another device creates a new account and becomes the sole active
-- owner of the same phone; the prior account remains as detached history.
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000003','821055510001');
set local role authenticated;
insert into pg_temp.policy_state values('C',public.authorize_device_account_v2(repeat('4',64),'android',repeat('b',64)));
select is((select result->>'created' from pg_temp.policy_state where label='C'),'true','P3 creates C');
select isnt(pg_temp.aid('C'),pg_temp.aid('A'),'P3 same phone does not recover A cross-device');
reset role;
select ok((select count(distinct account_id)=1 and min(account_id::text)::uuid=pg_temp.aid('C')
  from account_private.account_identities where provider='phone'
    and identity_hash=account_private.hash_phone('821055510001'))
  and exists(select 1 from account_private.phone_identity_history
    where account_id=pg_temp.aid('A') and identity_hash=account_private.hash_phone('821055510001')),
  'P3 C is sole active owner and A is detached history');
select alike(pg_temp.error(format($sql$select pg_temp.attempt_phone_duplicate(%L,%L)$sql$,
  pg_temp.aid('B'),account_private.hash_phone('821055510001'))),
  '%phone_identity_conflict%','P3 deferred guard rejects a second canonical phone owner');
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000007','821055510002');
set local role authenticated;
insert into pg_temp.policy_state values('D',public.authorize_device_account_v2(repeat('5',64),'android',repeat('c',64)));
select is((select result->>'created' from pg_temp.policy_state where label='D'),'true','P4 different device and phone creates D');
select ok(pg_temp.aid('D') not in(pg_temp.aid('A'),pg_temp.aid('B'),pg_temp.aid('C')),'P4 D is independent');

-- P5/P6: a fresh OTP on a proven historical exact pair may make that pair the
-- sole current owner again; no timestamp or balance heuristic is used.
reset role;
insert into auth.sessions(id,user_id) values
 ('b2000000-0000-4000-8000-000000000004','b1000000-0000-4000-8000-000000000001');
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000004','821055510001');
set local role authenticated;
insert into pg_temp.policy_state values('A3',public.authorize_device_account_v2(repeat('6',64),'android',repeat('a',64)));
select is(pg_temp.aid('A3'),pg_temp.aid('A'),'P5 Device A returns A');
reset role;
insert into auth.sessions(id,user_id) values
 ('b2000000-0000-4000-8000-000000000005','b1000000-0000-4000-8000-000000000001');
select pg_temp.phone_claim('b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000005','821055510001');
set local role authenticated;
insert into pg_temp.policy_state values('C2',public.authorize_device_account_v2(repeat('7',64),'android',repeat('b',64)));
select is(pg_temp.aid('C2'),pg_temp.aid('C'),'P6 Device B returns C');
reset role;
select ok(not has_table_privilege('authenticated','account_private.phone_device_bindings','SELECT'),'pair map is private');
select ok(not has_function_privilege('authenticated','account_private.authorize_phone_device_pair(text,text,text)','EXECUTE'),'pair resolver is private');

-- S1: Google and S2: Kakao retain portable cross-device recovery.
select pg_temp.oauth_claim('b1000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000009');
set local role authenticated;
insert into pg_temp.policy_state values('G1',public.authorize_google_device_account(repeat('8',64),'android',repeat('d',64)));
select is((select result->>'created' from pg_temp.policy_state where label='G1'),'true','S1 creates Google account');
select pg_temp.oauth_claim('b1000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000010');
insert into pg_temp.policy_state values('G2',public.authorize_google_device_account(repeat('9',64),'android',repeat('e',64)));
select is(pg_temp.aid('G2'),pg_temp.aid('G1'),'S1 Google recovers cross-device');
select is((select result->>'restored' from pg_temp.policy_state where label='G2'),'true','S1 reports recovery');
reset role;
select is((select count(distinct account_id) from account_private.account_identities where provider='google'
 and auth_user_id='b1000000-0000-4000-8000-000000000003'),1::bigint,'S1 Google has one owner');
select pg_temp.oauth_claim('b1000000-0000-4000-8000-000000000004','b2000000-0000-4000-8000-000000000011');
set local role authenticated;
insert into pg_temp.policy_state values('K1',public.authorize_kakao_device_account(repeat('a',64),'android',repeat('f',64)));
select is((select result->>'created' from pg_temp.policy_state where label='K1'),'true','S2 creates Kakao account');
select pg_temp.oauth_claim('b1000000-0000-4000-8000-000000000004','b2000000-0000-4000-8000-000000000012');
insert into pg_temp.policy_state values('K2',public.authorize_kakao_device_account(repeat('b',64),'android',repeat('0',64)));
select is(pg_temp.aid('K2'),pg_temp.aid('K1'),'S2 Kakao recovers cross-device');
select is((select result->>'restored' from pg_temp.policy_state where label='K2'),'true','S2 reports recovery');
reset role;
select is((select count(distinct account_id) from account_private.account_identities where provider='kakao'
 and auth_user_id='b1000000-0000-4000-8000-000000000004'),1::bigint,'S2 Kakao has one owner');

select * from finish(true);
rollback;

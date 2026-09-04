begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(26);
create temporary table ps(label text primary key,result jsonb);
grant all on pg_temp.ps to authenticated,service_role;
create function pg_temp.aid(k text) returns uuid language sql as $$select (result->>'account_id')::uuid from pg_temp.ps where label=k$$;
create function pg_temp.claim(uid uuid,sid uuid,phone_value text,age_seconds integer default 0,method text default 'otp') returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','session_id',sid,
  'phone',phone_value,'amr',jsonb_build_array(jsonb_build_object('method',method,
  'timestamp',extract(epoch from now())::bigint-age_seconds)))::text,true);
end $$;
create function pg_temp.err(statement text) returns text language plpgsql as $$begin execute statement; return null; exception when others then return sqlerrm; end$$;
insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at) values
 ('e1000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055540001',now(),false,now(),now()),
 ('e1000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055540002',now(),false,now(),now()),
 ('e1000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','821055540003',now(),false,now(),now());
insert into auth.sessions(id,user_id) values
 ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001'),
 ('e2000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001'),
 ('e2000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000001'),
 ('e2000000-0000-4000-8000-000000000004','e1000000-0000-4000-8000-000000000002'),
 ('e2000000-0000-4000-8000-000000000005','e1000000-0000-4000-8000-000000000002'),
 ('e2000000-0000-4000-8000-000000000006','e1000000-0000-4000-8000-000000000003');

select ok(not has_table_privilege('authenticated','account_private.phone_device_bindings','SELECT'),'phone pair mapping is private');
select ok(not has_function_privilege('authenticated','account_private.authorize_phone_device_pair(text,text,text)','EXECUTE'),'pair resolver is private');
select ok(not has_function_privilege('authenticated','public.delete_device_account_data(uuid,uuid)','EXECUTE'),'account deletion remains service-only');
select pg_temp.claim('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','821055540001',3600);
set local role authenticated;
select is(public.authorize_device_account_v2(repeat('1',64),'android',repeat('a',64))->>'error','fresh_phone_verification_required','new pair needs fresh OTP');
select pg_temp.claim('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','821055540001',0,'password');
select is(public.authorize_device_account_v2(repeat('1',64),'android',repeat('a',64))->>'error','fresh_phone_verification_required','password does not replace phone OTP');
select pg_temp.claim('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','821055540001');
select alike(pg_temp.err($$select public.authorize_device_account_v2('short','android',repeat('a',64))$$),'%invalid_device_secret%','invalid device secret fails closed');
select alike(pg_temp.err($$select public.authorize_device_account_v2(repeat('1',64),'android',null)$$),'%invalid_reinstall_identity%','missing native scope fails closed');
insert into pg_temp.ps values('A',public.authorize_device_account_v2(repeat('1',64),'android',repeat('a',64)));
select is((select result->>'created' from pg_temp.ps where label='A'),'true','fresh exact pair creates A');
insert into public.profiles(id,nickname,birth_year,region_code,gender) values(public.current_account_id(),'전화A',1990,'TEST','male');
select is(public.claim_account_welcome_points(),100::bigint,'A receives one welcome grant');
reset role;
update public.point_wallets set balance=725 where user_id=pg_temp.aid('A');
select pg_temp.claim('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002','821055540001');
set local role authenticated;
insert into pg_temp.ps values('A2',public.authorize_device_account_v2(repeat('2',64),'android',repeat('a',64)));
select is(pg_temp.aid('A2'),pg_temp.aid('A'),'same phone-device pair restores A');
select is(public.my_point_balance(),725::bigint,'pair recovery preserves wallet');
select is(public.claim_account_welcome_points(),725::bigint,'pair recovery cannot duplicate welcome');
reset role;

select pg_temp.claim('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003','821055540001');
set local role authenticated;
insert into pg_temp.ps values('B',public.authorize_device_account_v2(repeat('3',64),'android',repeat('b',64)));
select isnt(pg_temp.aid('B'),pg_temp.aid('A'),'same phone on another device creates B');
select is((select result->>'created' from pg_temp.ps where label='B'),'true','cross-device phone account is newly created');
select is((select count(*) from public.point_wallets where user_id=pg_temp.aid('A')),0::bigint,'B cannot read A wallet through RLS');
reset role;

select pg_temp.claim('e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000004','821055540002');
set local role authenticated;
insert into pg_temp.ps values('C',public.authorize_device_account_v2(repeat('4',64),'android',repeat('a',64)));
select isnt(pg_temp.aid('C'),pg_temp.aid('A'),'different phone on same device creates C');
select is((select result->>'created' from pg_temp.ps where label='C'),'true','different phone creates a new principal instead of rotation');
reset role;
select is((select count(distinct account_id) from account_private.phone_device_bindings where
 device_scope_hash=account_private.hash_phone('reinstall-v1:android:'||repeat('a',64))),2::bigint,'server records both same-device phone pairs');
select ok((select count(distinct account_id)=1 and min(account_id::text)::uuid=pg_temp.aid('B')
 from account_private.account_identities where provider='phone'
 and identity_hash=account_private.hash_phone('821055540001'))
 and exists(select 1 from account_private.phone_identity_history where account_id=pg_temp.aid('A')
 and identity_hash=account_private.hash_phone('821055540001')),
 'new-device OTP makes B the sole active phone owner and detaches A to history');

select public.delete_device_account_data(pg_temp.aid('C'),'e1000000-0000-4000-8000-000000000002');
select ok(not exists(select 1 from account_private.phone_device_bindings where account_id=pg_temp.aid('C')),'deletion cascades exact pair');
select pg_temp.claim('e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000005','821055540002');
set local role authenticated;
select is(public.authorize_device_account_v2(repeat('5',64),'android',repeat('a',64))->>'error','account_deletion_pending','deleted Auth identity cannot recreate an app account');
reset role;
select ok(exists(select 1 from account_private.device_accounts where id=pg_temp.aid('A')),'deleting C never deletes A');

-- A verified merge can leave a historical transport row after its exact pair
-- binding and identity move elsewhere. That row is not an active owner and
-- must not make a successful OTP look invalid on the next authorization.
reset role;
insert into account_private.device_accounts(
 id,auth_user_id,phone_hash,device_hash,auth_provider,device_scope_hash,
 reinstall_platform,reinstall_hash)
values(
 'e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003',
 account_private.hash_phone('821055540003'),repeat('8',64),'phone',
 account_private.hash_phone('reinstall-v1:android:'||repeat('c',64)),
 'android',account_private.hash_phone('reinstall-v1:android:'||repeat('c',64)));
insert into account_private.account_devices(
 account_id,device_hash,device_scope_hash,platform,is_primary)
values(
 'e3000000-0000-4000-8000-000000000001',repeat('8',64),
 account_private.hash_phone('reinstall-v1:android:'||repeat('c',64)),'android',true);
select pg_temp.claim('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000006','821055540003');
set local role authenticated;
insert into pg_temp.ps values('D',public.authorize_device_account_v2(repeat('9',64),'android',repeat('c',64)));
select is((select result->>'created' from pg_temp.ps where label='D'),'true','stale transport tuple no longer rejects a verified OTP');
select isnt(pg_temp.aid('D'),'e3000000-0000-4000-8000-000000000001'::uuid,'stale unbound account is never reclaimed implicitly');
reset role;
select ok(exists(select 1 from account_private.device_accounts where id='e3000000-0000-4000-8000-000000000001'),'stale historical account remains untouched');
select ok(exists(select 1 from account_private.phone_device_bindings where account_id=pg_temp.aid('D')),'new canonical account owns the exact phone-device pair');

select * from finish(true);
rollback;

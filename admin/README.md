# 잉톡 운영센터

모바일 앱과 분리된 운영자 전용 웹페이지입니다. 브라우저에는 Supabase `service_role` 키를 절대 넣지 않습니다.

## 1. 데이터베이스 준비

Supabase SQL Editor에서 순서대로 실행합니다.

1. `supabase/migrations/202608190035_chat_user_reports.sql`
2. `supabase/migrations/202608190036_profile_and_function_security.sql`
3. `supabase/migrations/202608190037_admin_console.sql`

## 2. 최초 최고 관리자 생성

Supabase Dashboard의 `Authentication → Users → Add user`에서 이메일/비밀번호 운영자 계정을 하나 만들고 이메일을 자동 확인 처리합니다.

그 다음 SQL Editor에서 이메일을 실제 운영자 이메일로 바꿔 실행합니다.

```sql
insert into public.admin_users(user_id, role)
select id, 'owner'
from auth.users
where email = 'admin@example.com'
on conflict (user_id) do update
set role = 'owner', is_active = true;
```

일반 운영자를 추가할 때는 역할을 `reviewer` 또는 `moderator`로 바꿉니다.

## 3. 환경변수

`admin/.env.example`을 `admin/.env`로 복사하고 모바일 앱의 `.env`와 동일한 Supabase 프로젝트 값을 넣습니다. 변수 이름은 다음처럼 다릅니다.

```env
VITE_SUPABASE_URL=https://프로젝트-REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=게시가능한-키
```

`SUPABASE_SERVICE_ROLE_KEY`는 입력하지 않습니다.

## 4. 실행

프로젝트 루트에서 실행합니다.

```powershell
npm run admin
```

터미널에 표시된 `http://localhost:5173` 주소를 PC 브라우저에서 엽니다.

프로덕션 빌드 검사는 다음 명령으로 실행합니다.

```powershell
npm run admin:build
```

## 역할

- `reviewer`: 신고 확인, 검토 시작, 기각, 처리 완료
- `moderator`: reviewer 권한 + 기간 정지, 복구, 포인트 조정
- `owner`: moderator 권한 + 영구 정지

모든 운영 조치는 `moderation_actions` 테이블에 변경 전후 상태와 함께 기록됩니다.

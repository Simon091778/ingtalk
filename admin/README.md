# 잉톡 운영센터

모바일 앱과 분리된 운영자 전용 웹페이지입니다. 브라우저에는 Supabase `service_role` 키를 절대 넣지 않습니다.

## 1. 데이터베이스 준비

프로젝트의 `supabase/migrations`를 번호 순서대로 적용합니다. 기존 운영 DB에는
이미 적용된 마이그레이션을 다시 실행하지 않습니다.

로그인·보상 관리에는 계정/기기/보상 스키마(099~109)와
`202608280110_admin_account_operations.sql`이 필요합니다. **110은 코드에 추가된
마이그레이션이며 운영 적용은 별도로 진행해야 합니다.** DB 적용 후 관리자 웹을
빌드·배포합니다. 모바일 앱 재빌드는 필요하지 않습니다.

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

- `reviewer`: 신고 확인, 검토 시작, 기각, 처리 완료, 로그인·기기·보상 상태 조회
- `moderator`: reviewer 권한 + 기간 정지, 복구, 포인트 조정, 기기 로그인 세션 종료
- `owner`: moderator 권한 + 영구 정지

모든 운영 조치는 `moderation_actions` 테이블에 변경 전후 상태와 함께 기록됩니다.

## 로그인·보상 관리

2026-08-28 운영 DB에 마이그레이션 110을 적용했고, 운영 웹은
https://ingtalk.vercel.app/admin/ 에 배포했다. 로그인 후 조회는 운영자 계정이 필요하다.
배포 아티팩트에는 공개 Supabase 키만 포함하며 서비스 권한 키는 포함하지 않는다.
`npm run admin:build`는 `/admin/` 기준 경로로 생성한다.

공개 사이트 파일 준비 및 배포 후 검증:

```powershell
npm run admin:build
node scripts/package-admin-site.mjs
node scripts/build-github-site.mjs
node scripts/check-release-site.mjs --live
```

마지막 명령은 실제 배포가 완료된 뒤 실행한다. 사이트 생성은 기존 관리자 아티팩트를 유지한다.
EAS 빌드 업로드에 관리자 `.env`나 서비스 권한 키를 포함하지 않는다.

**이용자 관리 → 이용자 선택 → 로그인·보상**에서 확인합니다.

- 휴대폰/Google/카카오 연결 시각과 현재 인증 연결의 유효 여부
- 등록 기기, 플랫폼, 최초 등록 여부, 허용된 앱 세션 수
- 기기별 출석·톡·게시글·댓글·광고 50P 보상의 최근 수령 시각과 다음 수령 가능 시각
- 최근 30건의 광고 요청 상태(대기/지급/미지급/만료)와 서버 검증 기록
- 사유를 남긴 기기별 로그아웃. 감사 기록에서 `기기 로그아웃`으로 필터링 가능

로그아웃은 선택한 앱 계정·기기에 연결된 Auth 세션을 종료합니다. 다음 서버 요청부터
접근이 차단되며 재인증이 필요합니다. 기기 등록, 계정 연결, 포인트, 보상 제한은 삭제하지
않습니다. 실제 접속 여부나 기기 모델/전화번호를 추정하지 않습니다.

광고 확인 대기는 시청 완료 증거가 아닙니다. 서명 검증 실패는 `admob-reward` 로그에서
조사합니다. 관리자 API에 광고 강제 승인, 보상 제한 초기화, 인증 수단 강제 연결/병합은
없습니다. 검증 후 필요한 수동 포인트 조정은 기존 포인트 조정 기능을 사용합니다.

SMS 템플릿(`ingtalk code is {{ .Code }}.`)은 Supabase Authentication의 Phone 설정에서
관리합니다. Expo Go 표시, 화면 전환/스와이프, 포인트 복구 안내 문구는 앱 코드에 속합니다.
이를 바꾸는 서비스 권한 키나 임의 코드 실행 기능을 관리자 브라우저에 추가하지 않습니다.

개인 식별 해시, 기기 비밀값, Auth 세션 ID, 광고 티켓/서명/원본 검증 데이터는 반환하지 않습니다.
광고 요청의 12자리 참조값은 티켓의 해시이며 인증이나 보상 요청에 사용할 수 없습니다.

### 검증

```powershell
npm run admin:test
npm run admin:build
node scripts/prepare-phone-auth-preflight.mjs --migration=202608280110_admin_account_operations.sql
npx --no-install supabase@2.114.0 db query --linked --file .expo/phone-auth-preflight/admin_account_operations.test.sql
```

마지막 명령은 연결된 DB에서 합성 이용자 데이터와 새 함수를 트랜잭션 안에서 시험한 뒤
롤백합니다. 운영 마이그레이션 적용이나 실제 이용자 로그아웃을 수행하지 않습니다.

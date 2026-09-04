# 잉톡 운영센터

모바일 앱과 분리된 운영자 전용 웹페이지입니다. 브라우저에는 Supabase `service_role` 키를 절대 넣지 않습니다.

## 1. 데이터베이스 준비

프로젝트의 `supabase/migrations`를 번호 순서대로 적용합니다. 기존 운영 DB에는
이미 적용된 마이그레이션을 다시 실행하지 않습니다.

로그인·보상 관리에는 계정/기기/보상 스키마(099~109)와
`202608280110_admin_account_operations.sql`이 필요합니다. 계정 통합·구매 증빙
조회에는 `202609010007_admin_account_history.sql`이 필요합니다. 두 마이그레이션은
운영 DB에 적용되어 있습니다. 사용자 상세의 현재 휴대전화 조회에는
`202609020003_admin_account_phone.sql`이 필요합니다. 관리자 웹 변경에는 모바일 앱
재빌드가 필요하지 않습니다.

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

- `reviewer`: 신고 확인, 검토 시작, 기각, 처리 완료, 로그인·기기·보상 상태 및 콘텐츠 조회
- `moderator`: reviewer 권한 + 기간 정지, 복구, 포인트 조정, 기기 로그인 세션 종료, 수다방·톡쓰기·게시판 운영 조치
- `owner`: moderator 권한 + 영구 정지

모든 운영 조치는 `moderation_actions` 테이블에 변경 전후 상태와 함께 기록됩니다.

## 계정·결제 이력

`계정·결제 이력`은 모든 관리자 역할에 읽기 전용으로 제공됩니다.

- 검증된 계정 통합: 유지된 canonical 계정, 종료 계정, 인증수단, 통합 전후 포인트,
  삭제된 일반 자산 수와 적용 정책
- 구매 증빙: 상품·포인트·실제 결제 통화, 스토어/환경, 지급·환불, 계정 삭제 또는
  통합에 따른 익명화 상태와 마스킹된 거래 참조

인증 원문, 기기/identity 해시, Auth 세션 ID, 결제사의 원본 payload 및 전체 거래번호는
관리자 브라우저에도 반환하지 않습니다. 계정 통합 실행·취소와 구매 상태 변경 기능도
제공하지 않습니다.

## 콘텐츠 관리

`콘텐츠 관리`에서는 수다방, 톡쓰기와 익명게시판을 통합 검색합니다.

- 수다방: 방·참여자·차단·최근 메시지 조회, 방 종료와 전원 퇴장, 참여자 퇴장/재입장 차단/해제, 메시지 삭제
- 톡쓰기: 작성자·상태·만료 시각 조회, 발견 목록 비활성화와 재활성화
- 익명게시판: 게시글·댓글과 실제 작성 계정 조회, 게시글·댓글 삭제

검토자는 조회만 가능하고 운영자 이상만 조치할 수 있습니다. 조치에는 2자 이상의 사유와 브라우저 재확인이 필요하며 감사 기록에 변경 전후 상태가 저장됩니다.

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

이용자 관리의 단일 검색창은 닉네임 부분 일치, 계정 ID 기존 일치 방식, 현재 활성
휴대전화번호의 한국 형식 정규화 검색과 현재 활성 Google 이메일의 대소문자 무시
완전일치를 지원합니다. 검색어는 URL이나 감사 로그에 저장하지 않으며 검색 결과 목록에는
전화번호·이메일을 추가로 노출하지 않습니다.

- 현재 유효한 휴대전화번호 전체, Google 기본 이메일 전체, 카카오 연결 상태와 세 인증수단의 인증일시
- 등록 기기, 플랫폼, 최초 등록 여부, 허용된 앱 세션 수
- 기기별 출석·톡·게시글·댓글·광고 50P 보상의 최근 수령 시각과 다음 수령 가능 시각
- 최근 30건의 광고 요청 상태(대기/지급/미지급/만료)와 서버 검증 기록
- 사유를 남긴 기기별 로그아웃. 감사 기록에서 `기기 로그아웃`으로 필터링 가능

휴대전화 원문은 별도 앱 테이블에 복제하지 않고 관리자 상세 조회 시 현재 활성 phone
identity가 가리키는 `auth.users.phone`에서만 읽습니다. 일반 앱 사용자에게는 이 조회가
허용되지 않으며, 폐기 이력이나 복수 후보가 있으면 번호를 임의 선택하지 않습니다.

Google 이메일 원문도 일반 앱 테이블에 복제하지 않습니다. 현재 canonical account에
정확히 하나만 활성 연결된 Google identity의 `auth.identities.identity_data.email`을
관리자 상세 조회 안에서만 읽습니다. stale·복수 후보 또는 이메일 누락은 원문을 임의로
선택하지 않고 확인 불가로 표시합니다.

휴대전화·Google·카카오의 인증일시는 현재 활성 identity의 `linked_at`이며 최근 로그인
시각이 아닙니다. 식별정보와 시각은 같은 identity에서 함께 결정하고 관리자 화면에서는
`Asia/Seoul` 기준으로 표시합니다. stale·복수 후보에서는 시각도 임의 선택하지 않습니다.

로그아웃은 선택한 앱 계정·기기에 연결된 Auth 세션을 종료합니다. 다음 서버 요청부터
접근이 차단되며 재인증이 필요합니다. 기기 등록, 계정 연결, 포인트, 보상 제한은 삭제하지
않습니다. 실제 접속 여부나 기기 모델/전화번호를 추정하지 않습니다.

광고 확인 대기는 시청 완료 증거가 아닙니다. 서명 검증 실패는 `admob-reward` 로그에서
조사합니다. 관리자 API에 광고 강제 승인, 보상 제한 초기화, 인증 수단 강제 연결/병합은
없습니다. 검증 후 필요한 수동 포인트 조정은 기존 포인트 조정 기능을 사용합니다.

SMS 템플릿(`ingtalk code is {{ .Code }}.`)은 Supabase Authentication의 Phone 설정에서
관리합니다. Expo Go 표시, 화면 전환/스와이프, 포인트 복구 안내 문구는 앱 코드에 속합니다.
이를 바꾸는 서비스 권한 키나 임의 코드 실행 기능을 관리자 브라우저에 추가하지 않습니다.

관리자에게 명시적으로 표시하는 휴대전화번호와 Google 이메일을 제외한 개인 식별 해시, 기기 비밀값, Auth 세션 ID, 광고 티켓/서명/원본 검증 데이터는 반환하지 않습니다.
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

# 잉톡

관심사와 대화 목적을 먼저 보여주고, 양쪽이 동의한 뒤 1:1 대화를 시작하는 성인용 소셜 채팅 MVP입니다.

## 현재 구현

- 발견 화면과 대화 목적 필터
- 대화 카드 작성 UX
- 대화 요청 시뮬레이션
- 채팅 목록 및 프로필/신뢰도 화면
- Supabase 미설정 시 데모 데이터 모드
- iOS 첫 실행 시 앱 추적 투명성(ATT) 권한 요청 및 선택 상태 표시
- 첫 실행 동의 화면에서 선택한 경우 iOS/Android 알림 권한 요청
- 회원가입 없는 Supabase 익명 인증과 닉네임·나이·성별·관심사 온보딩
- 프로필, 대화 카드, 요청, 방, 메시지, 차단, 신고 스키마
- 참여자 중심 RLS 정책과 원자적 대화 수락 함수

## 실행

1. Node.js 20 이상과 pnpm 또는 npm을 설치합니다.
2. `pnpm install`을 실행합니다.
3. `.env.example`을 `.env`로 복사하고 Supabase 값을 입력합니다.
4. `supabase/migrations/202608130001_initial_schema.sql`을 Supabase SQL Editor에서 실행합니다.
5. `pnpm start`로 Expo를 시작합니다.

익명 프로필을 사용하려면 Supabase Dashboard의 Authentication 설정에서 **Allow anonymous
sign-ins**를 활성화하고 `supabase/migrations/202608180002_guest_profiles.sql`도 실행해야 합니다.
익명 사용자는 앱 삭제, 로그아웃 또는 기기 변경 후 동일 계정으로 복구할 수 없습니다.

거리 표시를 사용하려면 Supabase에서 PostGIS 확장을 활성화한 뒤
`supabase/migrations/202608180003_location_distance.sql`을 실행합니다. 정확한 좌표는 다른
사용자에게 공개되지 않으며, 앱에는 100m 단위로 반올림한 거리만 전달됩니다.

실제 1:1 채팅을 사용하려면 `supabase/migrations/202608180004_chat_flow.sql`을 실행합니다.
대화 요청 생성과 수락·거절은 보안 RPC로만 처리되며, 수락 시 채팅방과 두 참여자가 원자적으로
생성됩니다. 메시지는 Postgres에 저장되고 Supabase Realtime으로 상대방에게 전달됩니다.

Supabase 값 없이 실행하면 제품 흐름을 볼 수 있는 데모 모드로 시작합니다.

## iOS 추적 권한

앱이 활성화된 첫 실행에 iOS ATT 시스템 권한을 요청합니다. 사용자의 선택은 iOS가 기억하며,
거부해도 앱의 핵심 기능은 제한되지 않습니다. `내 정보 > 광고 추적 권한`에서 현재 상태를
확인할 수 있습니다. 실제 광고 식별자 수집이나 광고 네트워크 전송은 아직 구현하지 않았습니다.

Expo Go에서는 Expo Go 앱 자체의 권한 상태가 사용되므로 잉톡 전용 문구와 최초 설치 동작을
정확히 검증하려면 새 Development Build 또는 TestFlight 빌드가 필요합니다.

## 다음 개발 순서

1. 휴대전화/OTP 인증과 성인 확인
2. 실제 프로필 온보딩 및 사진 업로드
3. 대화 카드 CRUD와 요청 수락 연결
4. Realtime 메시지 구독과 푸시 알림
5. 신고 관리자 화면과 자동 moderation

> 프로덕션 적용 전에는 개인정보·위치정보·청소년 보호 정책에 대한 법률 검토와 RLS 보안 테스트가 필요합니다.

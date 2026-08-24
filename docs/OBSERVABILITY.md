# 잉톡 오류 수집 및 운영 로그

## 구성 범위

- 앱 예외와 네이티브 크래시: Sentry
- Auth, Postgres, Storage, Realtime, Edge Function 오류: Supabase Logs Explorer
- 신고 처리, 이용 정지, 복구, 포인트 조정: `moderation_actions` 감사 기록

앱 오류와 운영자 감사 기록은 목적과 접근 권한이 다르므로 서로 다른 저장소에서 관리한다.

## Sentry 프로젝트 연결

1. Sentry에서 React Native 프로젝트를 만든다.
2. EAS의 development, preview, production 환경에 아래 변수를 등록한다.

| 이름 | 가시성 | 설명 |
| --- | --- | --- |
| `EXPO_PUBLIC_SENTRY_DSN` | Plain text | 앱이 오류를 전송할 공개 DSN |
| `EXPO_PUBLIC_APP_ENV` | Plain text | 각 환경에 development, preview, production 입력 |
| `SENTRY_ORG` | Plain text | Sentry 조직 slug |
| `SENTRY_PROJECT` | Plain text | Sentry 프로젝트 slug |
| `SENTRY_AUTH_TOKEN` | Sensitive | EAS 빌드 소스맵 업로드 전용 토큰 |

`SENTRY_AUTH_TOKEN`은 `EXPO_PUBLIC_` 접두사를 붙이지 않고 Git이나 앱 코드에 넣지 않는다.

## 빌드와 확인

환경변수를 등록한 후 새 development build를 만든다.

```powershell
npx eas-cli build --profile development --platform android
```

테스트 기기에서 네트워크를 끊은 상태로 메시지 전송, 사진 업로드 등을 시도한 뒤 Sentry Issues에서 `feature`, `operation`, `app_environment`, `app_version`, `platform` 태그를 확인한다.

## 개인정보 보호 원칙

공통 로거는 키 이름에 token, key, password, secret, message, body, content, latitude, longitude, uri, url이 포함된 값을 필터링한다. 사용자 연결에는 Supabase 익명 사용자 ID만 사용한다.

다음 값은 오류 컨텍스트나 `console` 출력에 추가하지 않는다.

- 채팅, 게시글, 댓글 본문
- 정확한 위도와 경도
- 사진 로컬 URI와 서명 URL
- 인증 토큰, 쿠키, 서비스 계정 키
- 연락처, 이메일, 전화번호

## 운영 확인 순서

1. Sentry Issues에서 앱 오류와 영향을 받은 버전을 확인한다.
2. 같은 시간대 Supabase Logs Explorer에서 Auth/API/Postgres/Storage/Realtime/Function 로그를 확인한다.
3. 사용자 제재나 포인트 조정 문제라면 관리자 페이지의 감사 기록을 확인한다.
4. 수정 후 preview 빌드에서 재현 테스트를 하고 production에 반영한다.

## 장애 우선순위

- P0: 앱 실행 불가, 데이터 손실, 포인트 중복 지급, 계정 탈퇴 실패
- P1: 로그인, 메시지, 대화 신청, 사진 업로드, 푸시 기능의 반복 실패
- P2: 일부 화면 표시 오류 또는 일시적인 재시도로 복구되는 오류

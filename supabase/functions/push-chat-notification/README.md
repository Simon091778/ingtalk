# 대화 푸시 알림 배포

1. `npx supabase db push`
2. `npx supabase functions deploy push-chat-notification`
3. Supabase Dashboard → Database → Webhooks에서 Webhook을 생성합니다.
   - Table: `public.push_notifications`
   - Event: `INSERT`
   - Type: Supabase Edge Function
   - Function: `push-chat-notification`
   - HTTP header: service-role 인증 헤더 사용
4. Expo의 Enhanced Push Security를 사용하는 경우 `EXPO_ACCESS_TOKEN` secret도 등록합니다.

Expo Go가 아닌 EAS development build 또는 production build에서 실제 원격 푸시를 시험해야 합니다.

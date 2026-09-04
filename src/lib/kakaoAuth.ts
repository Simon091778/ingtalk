import type { SupabaseClient } from '@supabase/supabase-js'
import { SOCIAL_REDIRECTS, signInWithSocialProvider, socialCallbackCode } from './socialAuth'
export const KAKAO_REDIRECT = SOCIAL_REDIRECTS.kakao
export const kakaoCallbackCode = (callback: string) => socialCallbackCode(callback, 'kakao')
export function signInWithKakao(target: SupabaseClient, isActive: () => boolean = () => true,
  consumeForLink?: (verifiedClient: SupabaseClient) => Promise<void>, signal?: AbortSignal) {
  return signInWithSocialProvider('kakao', target, isActive, consumeForLink, signal)
}

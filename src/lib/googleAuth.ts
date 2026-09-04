import type { SupabaseClient } from '@supabase/supabase-js'
import { SOCIAL_REDIRECTS, signInWithSocialProvider, socialCallbackCode } from './socialAuth'
export { accountProvider } from './authProviders'
export const GOOGLE_REDIRECT = SOCIAL_REDIRECTS.google
export const googleCallbackCode = (callback: string) => socialCallbackCode(callback, 'google')
export function signInWithGoogle(target: SupabaseClient, isActive: () => boolean = () => true,
  consumeForLink?: (verifiedClient: SupabaseClient) => Promise<void>, signal?: AbortSignal) {
  return signInWithSocialProvider('google', target, isActive, consumeForLink, signal)
}

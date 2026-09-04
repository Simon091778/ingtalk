import type { User } from '@supabase/supabase-js'

export const LOGIN_PROVIDERS = ['phone', 'google', 'kakao'] as const
export type LoginProvider = typeof LOGIN_PROVIDERS[number]
export type SocialProvider = Exclude<LoginProvider, 'phone'>
// Routing only. The server independently validates the real provider identity.
export function accountProvider(user: Pick<User, 'app_metadata' | 'identities'>): LoginProvider {
  for (const provider of ['kakao', 'google'] as const) {
    if (user.identities?.some(identity => identity.provider === provider) || user.app_metadata?.provider === provider) return provider
  }
  return 'phone'
}

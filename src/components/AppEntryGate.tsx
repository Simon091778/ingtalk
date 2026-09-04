import { type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { PhoneAuthGate } from './PhoneAuthGate'
import { RegionalSelector } from './RegionalSettings'
import { AppStartupScreen } from './AppStartupScreen'

// Choose the display language before mounting authentication or private app hooks.
export function AppEntryGate({ children }: { children: ReactNode }) {
  const i18n = useI18n()
  // I18nProvider combines saved preferences with installation-local completion
  // markers. Keychain preferences alone must not skip setup after reinstall.
  if (!i18n.ready) return <AppStartupScreen language={i18n.language} />
  if (!i18n.hasSelected) return <RegionalSelector onboarding />
  return <PhoneAuthGate language={i18n.language} renderPreviousStep={onContinue => <RegionalSelector onboarding onContinue={onContinue} />}>{children}</PhoneAuthGate>
}

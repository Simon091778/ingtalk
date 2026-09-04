import { addAppBreadcrumb } from './observability'

export type PhoneAuthDiagnosticEvent =
  | 'PHONE_AUTH_OTP_REQUEST_START'
  | 'PHONE_AUTH_OTP_REQUEST_SUCCESS'
  | 'PHONE_AUTH_OTP_REQUEST_FAILURE'
  | 'PHONE_AUTH_VERIFY_START'
  | 'PHONE_AUTH_VERIFY_SUCCESS'
  | 'PHONE_AUTH_VERIFY_FAILURE'
  | 'PHONE_AUTH_SESSION_AVAILABLE'
  | 'PHONE_AUTH_ACCOUNT_RESOLVE_START'
  | 'PHONE_AUTH_ACCOUNT_RESOLVE_SUCCESS'
  | 'PHONE_AUTH_ACCOUNT_RESOLVE_FAILURE'
  | 'PHONE_AUTH_LOGIN_COMPLETE'

type SafeDetails = {
  platform?: string
  provider?: string
  errorCode?: string
}

function safeDetails(details?: SafeDetails) {
  if (!details) return undefined
  const errorCode = details.errorCode && /^[a-z0-9_]{1,64}$/i.test(details.errorCode)
    ? details.errorCode
    : details.errorCode ? 'unclassified' : undefined
  return { ...details, errorCode }
}

// These events intentionally contain no phone, OTP, token, user/account ID,
// reinstall identifier, device secret, or other personal data. They remain in
// release logcat so a Play-installed build can distinguish Auth from account
// bootstrap without enabling general verbose logging.
export function logPhoneAuthDiagnostic(event: PhoneAuthDiagnosticEvent, details?: SafeDetails) {
  const sanitized = safeDetails(details)
  addAppBreadcrumb(event.toLowerCase(), sanitized)
  if (sanitized) console.info(`[PHONE_AUTH_QA] ${event}`, sanitized)
  else console.info(`[PHONE_AUTH_QA] ${event}`)
}

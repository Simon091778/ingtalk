import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Sentry from '@sentry/react-native'
import type { ComponentType } from 'react'
import { Platform } from 'react-native'

type LogValue = string | number | boolean | null | undefined
export type ErrorContext = Record<string, LogValue>

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim()
const environment = process.env.EXPO_PUBLIC_APP_ENV?.trim() || (__DEV__ ? 'development' : 'production')
const blockedKey = /(authorization|cookie|password|secret|token|key|message|body|content|latitude|longitude|uri|url)/i
const expectedError = /(insufficient_points|request_already_exists|cannot_request_self|card_not_available|users_blocked|report_already_exists|permission denied|cancelled|canceled)/i

let initialized = false

function safeValue(key: string, value: LogValue): string | number | boolean | null {
  if (blockedKey.test(key)) return '[Filtered]'
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value ?? null
  return value.length > 160 ? `${value.slice(0, 157)}...` : value
}

function sanitize(context: ErrorContext = {}) {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [key, safeValue(key, value)]))
}

function asError(reason: unknown) {
  if (reason instanceof Error) return reason
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    return new Error(String(reason.message))
  }
  return new Error(String(reason))
}

export function initializeObservability() {
  if (initialized) return
  initialized = true

  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment,
    sendDefaultPii: false,
    enableAutoSessionTracking: true,
    tracesSampleRate: environment === 'production' ? 0.05 : 0,
    beforeSend(event) {
      if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined
      return event
    },
    initialScope: {
      tags: {
        app_environment: environment,
        app_version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown',
        platform: Platform.OS,
      },
    },
  })
}

export function identifyAnonymousUser(userId: string | null | undefined) {
  Sentry.setUser(userId ? { id: userId } : null)
}

export function addAppBreadcrumb(message: string, context: ErrorContext = {}) {
  Sentry.addBreadcrumb({ category: 'app', message, level: 'info', data: sanitize(context) })
}

export function captureAppError(reason: unknown, feature: string, operation: string, context: ErrorContext = {}) {
  const error = asError(reason)
  if (expectedError.test(error.message)) {
    Sentry.addBreadcrumb({
      category: 'expected_error',
      message: `${feature}:${operation}`,
      level: 'warning',
      data: sanitize({ ...context, errorCode: error.message.slice(0, 80) }),
    })
    if (__DEV__) console.warn(`[${feature}:${operation}:expected]`, error.message)
    return
  }

  Sentry.withScope(scope => {
    scope.setTag('feature', feature)
    scope.setTag('operation', operation)
    scope.setContext('operation', sanitize(context))
    Sentry.captureException(error)
  })

  if (__DEV__) console.error(`[${feature}:${operation}]`, error, sanitize(context))
}

export function wrapWithErrorMonitoring<T extends ComponentType<Record<string, never>>>(component: T) {
  return Sentry.wrap(component)
}

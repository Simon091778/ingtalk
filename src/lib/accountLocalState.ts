const marker = 'ingtalk.local-account.v1'
const privateDraftKeys = [
  'ingtalk.guest-profile.v1',
  'ingtalk.last-sent-request-message.v1',
  'ingtalk.last-published-talk-card.v1',
]

// These drafts predate phone accounts. Never let a new principal inherit them.
export function activateLocalAccount(accountId: string) {
  if (localStorage.getItem(marker) === accountId) return
  for (const key of privateDraftKeys) localStorage.removeItem(key)
  localStorage.setItem(marker, accountId)
}

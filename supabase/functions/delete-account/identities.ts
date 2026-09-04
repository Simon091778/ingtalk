// Service-created IDs only. Never accept deletion IDs from a request body.
export function deletionOrder(ids: unknown, callerId: string): string[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) {
    throw new Error('invalid_deletion_response')
  }
  // Keep the caller authenticated until other identities have been removed, so
  // a failed Auth deletion can be retried with the same authorized caller.
  return [...new Set<string>(ids)].sort((a, b) => Number(a === callerId) - Number(b === callerId))
}

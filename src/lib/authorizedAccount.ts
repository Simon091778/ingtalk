import { createContext, useContext } from 'react'

// Mount-scoped ID obtained by PhoneAuthGate from server device authorization.
// Not a persisted permission cache: the gate unmounts it on logout/account change
// or failed validation. Every data request still passes the existing server RLS.
export const AuthorizedAccountContext = createContext<string | null>(null)
export const useAuthorizedAccountId = () => useContext(AuthorizedAccountContext)

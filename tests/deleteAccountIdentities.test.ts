import { deletionOrder } from '../supabase/functions/delete-account/identities'
const caller = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
test('deletes the linked identity first and caller last, only once each', () => {
  expect(deletionOrder([caller, other, caller], caller)).toEqual([other, caller])
})

test('three-provider deletion keeps the Kakao caller until all other identities are deleted', () => {
  const third = '10000000-0000-4000-8000-000000000003'
  expect(deletionOrder([caller, other, third], caller)).toEqual([other, third, caller])
})
test('shared identities omitted by the database are not inferred or deleted', () => {
  expect(deletionOrder([other], caller)).toEqual([other])
  expect(deletionOrder([], caller)).toEqual([])
})
test.each([undefined, null, {}, ['not-a-uuid']])('rejects malformed service deletion payload %j', input => {
  expect(() => deletionOrder(input, caller)).toThrow('invalid_deletion_response')
})

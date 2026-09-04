import { createRefreshQueue } from '../refreshQueue'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('overlapping callers wait for a trailing read containing the newest data', async () => {
  const first = deferred<number>()
  const second = deferred<number>()
  const task = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const queue = createRefreshQueue(task)
  const a = queue.run()
  await Promise.resolve()
  const b = queue.run()
  const c = queue.run()
  expect(task).toHaveBeenCalledTimes(1)
  first.resolve(1)
  await Promise.resolve()
  await Promise.resolve()
  expect(task).toHaveBeenCalledTimes(2)
  second.resolve(2)
  expect(await Promise.all([a, b, c])).toEqual([2, 2, 2])
})

test('cancel invalidates in-flight state writes and drops queued work', async () => {
  const response = deferred<number>()
  const apply = jest.fn()
  const task = jest.fn(async (isCurrent: () => boolean) => {
    const data = await response.promise
    if (isCurrent()) apply(data)
  })
  const queue = createRefreshQueue(task)
  const pending = queue.run()
  await Promise.resolve()
  queue.run()
  queue.cancel()
  response.resolve(1)
  await pending
  expect(apply).not.toHaveBeenCalled()
  expect(task).toHaveBeenCalledTimes(1)
  await queue.run()
  expect(apply).toHaveBeenCalledWith(1)
})

test('failure unlocks refresh and an event arriving during a failed read is retried', async () => {
  const first = deferred<number>()
  const task = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(3)
  const queue = createRefreshQueue(task)
  const pending = queue.run()
  await Promise.resolve()
  queue.run()
  first.reject(new Error('temporary'))
  expect(await pending).toBe(2)
  await expect(queue.run()).rejects.toThrow('offline')
  expect(await queue.run()).toBe(3)
})

test('cancel before the scheduled read starts does not execute it', async () => {
  const task = jest.fn().mockResolvedValue(1)
  const queue = createRefreshQueue(task)
  const pending = queue.run()
  queue.cancel()
  await pending
  expect(task).not.toHaveBeenCalled()
  expect(await queue.run()).toBe(1)
})

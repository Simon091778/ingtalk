const values = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => { values.set(key, String(value)) }),
    removeItem: jest.fn((key: string) => { values.delete(key) }),
    clear: jest.fn(() => { values.clear() }),
  },
})

beforeEach(() => {
  values.clear()
  jest.clearAllMocks()
})

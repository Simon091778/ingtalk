import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'

// Native sessions are never stored in SQLite/localStorage. Chunking avoids
// platform limits; publish the manifest only after every chunk is persisted.
type Manifest = { version: 1; id: string; count: number }
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
const chunkSize = 1000
let queue: Promise<unknown> = Promise.resolve()
const keyFor = (key: string) => `ingtalk.auth.v2.${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`
const parse = (value: string | null): Manifest | null => {
  try {
    const m = JSON.parse(value ?? 'null')
    return m?.version === 1 && typeof m.id === 'string' && /^[a-f0-9-]+$/i.test(m.id) && Number.isInteger(m.count) && m.count > 0 && m.count < 100 ? m : null
  } catch { return null }
}
const serialize = <T,>(task: () => Promise<T>): Promise<T> => {
  const result = queue.then(task, task)
  queue = result.catch(() => {})
  return result
}
async function clearChunks(key: string, manifest: Manifest | null) {
  if (manifest) await Promise.all(Array.from({ length: manifest.count }, (_, i) => SecureStore.deleteItemAsync(`${key}.${manifest.id}.${i}`, options)))
}

export const secureAuthStorage = {
  getItem(key: string): Promise<string | null> {
    return serialize(async () => {
      if (Platform.OS === 'web') return localStorage.getItem(key)
      const root = keyFor(key)
      const manifest = parse(await SecureStore.getItemAsync(root, options))
      if (!manifest) return null
      const parts = await Promise.all(Array.from({ length: manifest.count }, (_, i) => SecureStore.getItemAsync(`${root}.${manifest.id}.${i}`, options)))
      if (parts.some(part => part === null)) return null
      try { return JSON.parse(parts.join('')) as string } catch { return null }
    })
  },
  setItem(key: string, value: string): Promise<void> {
    return serialize(async () => {
      if (Platform.OS === 'web') { localStorage.setItem(key, value); return }
      const root = keyFor(key)
      const previous = parse(await SecureStore.getItemAsync(root, options))
      const encoded = JSON.stringify(value).replace(/[^\x00-\x7F]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      const next: Manifest = { version: 1, id: Crypto.randomUUID(), count: Math.max(1, Math.ceil(encoded.length / chunkSize)) }
      if (next.count >= 100) throw new Error('session_too_large')
      try {
        for (let i = 0; i < next.count; i++) await SecureStore.setItemAsync(`${root}.${next.id}.${i}`, encoded.slice(i * chunkSize, (i + 1) * chunkSize), options)
        await SecureStore.setItemAsync(root, JSON.stringify(next), options)
      } catch (error) { await clearChunks(root, next).catch(() => {}); throw error }
      await clearChunks(root, previous).catch(() => {})
      // Do not import legacy anonymous sessions, but remove their old plaintext.
      localStorage.removeItem(key)
    })
  },
  removeItem(key: string): Promise<void> {
    return serialize(async () => {
      if (Platform.OS === 'web') { localStorage.removeItem(key); return }
      const root = keyFor(key)
      const previous = parse(await SecureStore.getItemAsync(root, options))
      await SecureStore.deleteItemAsync(root, options)
      await clearChunks(root, previous)
      localStorage.removeItem(key)
    })
  },
}

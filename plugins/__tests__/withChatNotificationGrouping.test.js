const { configureManifest } = require('../withChatNotificationGrouping')

const makeManifest = () => ({ manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' }, service: [{ $: { 'android:name': 'other.Service' } }] }] } })

it('replaces both default native paths, without exporting receivers or changing unrelated services', () => {
  const result = configureManifest(makeManifest())
  const app = result.manifest.application[0]
  expect(app.service).toContainEqual({ $: { 'android:name': 'other.Service' } })
  for (const [type, name] of [['service', 'ExpoFirebaseMessagingService'], ['receiver', 'NotificationsService']]) {
    expect(app[type]).toContainEqual({ $: { 'android:name': `expo.modules.notifications.service.${name}`, 'tools:node': 'remove' } })
    expect(app[type].find(item => item.$['android:name'].startsWith('kr.ingtalk.')).$['android:exported']).toBe('false')
  }
  const actions = app.receiver[1]['intent-filter'][0].action.map(item => item.$['android:name'])
  expect(actions).toContain('expo.modules.notifications.NOTIFICATION_EVENT')
  expect(actions).toContain('android.intent.action.BOOT_COMPLETED')
  expect(actions).toContain('android.intent.action.MY_PACKAGE_REPLACED')
})

it('is idempotent when prebuild runs again', () => {
  const once = configureManifest(makeManifest())
  const snapshot = JSON.stringify(once)
  expect(JSON.stringify(configureManifest(once))).toBe(snapshot)
})

it('does not register any iOS mods', () => {
  const plugin = require('../withChatNotificationGrouping')
  const config = plugin({ name: 'Test', slug: 'test' })
  expect(Object.keys(config.mods)).toEqual(['android'])
})

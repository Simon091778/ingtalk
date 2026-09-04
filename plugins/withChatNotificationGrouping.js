const fs = require('node:fs/promises')
const path = require('node:path')
const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins')

const namespace = 'kr.ingtalk.notifications'
const sourceFiles = ['ChatFirebaseMessagingService.kt', 'ChatNotificationsService.kt', 'ChatPresentationDelegate.kt']

function configureManifest(manifest) {
  manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools'
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)
  const replace = (type, oldName, newName, actions) => {
    app[type] = (app[type] || []).filter(item => ![oldName, newName].includes(item.$['android:name']))
    app[type].push({ $: { 'android:name': oldName, 'tools:node': 'remove' } })
    app[type].push({
      $: { 'android:name': newName, 'android:exported': 'false' },
      'intent-filter': [{ action: actions.map(name => ({ $: { 'android:name': name } })) }],
    })
  }
  replace('service', 'expo.modules.notifications.service.ExpoFirebaseMessagingService', `${namespace}.ChatFirebaseMessagingService`, ['com.google.firebase.MESSAGING_EVENT'])
  replace('receiver', 'expo.modules.notifications.service.NotificationsService', `${namespace}.ChatNotificationsService`, [
    'expo.modules.notifications.NOTIFICATION_EVENT', 'android.intent.action.BOOT_COMPLETED',
    'android.intent.action.REBOOT', 'android.intent.action.QUICKBOOT_POWERON',
    'com.htc.intent.action.QUICKBOOT_POWERON', 'android.intent.action.MY_PACKAGE_REPLACED',
  ])
  return manifest
}

function withChatNotificationGrouping(config) {
  config = withAndroidManifest(config, mod => {
    mod.modResults = configureManifest(mod.modResults)
    return mod
  })
  config = withAppBuildGradle(config, mod => {
    // expo-notifications' implementation dependencies are not on the app compile classpath.
    const marker = '// ingtalk-chat-notification-dependencies'
    if (!mod.modResults.contents.includes(marker)) {
      // Expo exposes notification classes via its api dependencies, including when
      // autolinking selects a prebuilt AAR instead of an :expo-notifications project.
      mod.modResults.contents += `\n${marker}\ndependencies {\n    implementation 'com.google.firebase:firebase-messaging:24.0.1'\n    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3'\n}\n`
    }
    return mod
  })
  return withDangerousMod(config, ['android', async mod => {
    const { version } = require('expo-notifications/package.json')
    if (!version.startsWith('0.32.')) throw new Error('Revalidate Android chat grouping against the upgraded expo-notifications native APIs.')
    const target = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/java', ...namespace.split('.'))
    await fs.mkdir(target, { recursive: true })
    await Promise.all(sourceFiles.map(file => fs.copyFile(path.join(__dirname, 'android', file), path.join(target, file))))
    return mod
  }])
}

module.exports = withChatNotificationGrouping
module.exports.configureManifest = configureManifest

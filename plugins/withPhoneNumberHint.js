const fs = require('node:fs/promises')
const path = require('node:path')
const { withAppBuildGradle, withDangerousMod, withMainApplication } = require('expo/config-plugins')

const namespace = 'kr.ingtalk.phonehint'
const packageRegistration = `add(${namespace}.PhoneNumberHintPackage())`

function registerPackage(source) {
  if (source.includes(packageRegistration)) return source
  const anchor = /PackageList\(this\)\.packages\.apply\s*\{/
  if (!anchor.test(source)) throw new Error('Revalidate Phone Number Hint registration against the new MainApplication template.')
  return source.replace(anchor, match => `${match}\n              ${packageRegistration}`)
}

function addDependency(source) {
  const marker = '// ingtalk-phone-number-hint-dependency'
  let result = source.includes(marker) ? source : `${source}\n${marker}\ndependencies {\n    implementation 'com.google.android.gms:play-services-auth:22.0.0'\n}\n`
  const smsMarker = '// ingtalk-sms-consent-dependency'
  // Expo SDK 54 uses Kotlin 2.1. 18.3.1 contains Kotlin 2.3 metadata and
  // fails :app:compileDebugKotlin. 18.2.0 retains the SMS User Consent API.
  const smsDependency = "implementation 'com.google.android.gms:play-services-auth-api-phone:18.2.0'"
  if (!result.includes(smsMarker)) result += `\n${smsMarker}\ndependencies {\n    ${smsDependency}\n}\n`
  else result = result.replace(/(\/\/ ingtalk-sms-consent-dependency\s*dependencies\s*\{\s*)implementation\s+['"]com\.google\.android\.gms:play-services-auth-api-phone:[^'"]+['"]/, `$1${smsDependency}`)
  return result
}

function withPhoneNumberHint(config) {
  config = withMainApplication(config, mod => {
    if (mod.modResults.language !== 'kt') throw new Error('Phone Number Hint requires the Expo Kotlin MainApplication template.')
    mod.modResults.contents = registerPackage(mod.modResults.contents)
    return mod
  })
  config = withAppBuildGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') throw new Error('Revalidate Phone Number Hint Gradle configuration.')
    mod.modResults.contents = addDependency(mod.modResults.contents)
    return mod
  })
  return withDangerousMod(config, ['android', async mod => {
    const target = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/java', ...namespace.split('.'))
    await fs.mkdir(target, { recursive: true })
    for (const file of ['PhoneNumberHintModule.kt', 'PhoneNumberHintPackage.kt', 'SmsConsentModule.kt']) {
      await fs.copyFile(path.join(__dirname, 'android', file), path.join(target, file))
    }
    return mod
  }])
}

module.exports = withPhoneNumberHint
module.exports.registerPackage = registerPackage
module.exports.addDependency = addDependency

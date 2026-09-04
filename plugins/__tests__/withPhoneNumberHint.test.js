const { registerPackage, addDependency } = require('../withPhoneNumberHint')

it('registers the custom module alongside other packages and is idempotent', () => {
  const source = 'override fun getPackages(): List<ReactPackage> = PackageList(this).packages.apply {\n  add(OtherPackage())\n}'
  const result = registerPackage(source)
  expect(result).toContain('add(kr.ingtalk.phonehint.PhoneNumberHintPackage())')
  expect(result).toContain('add(OtherPackage())')
  expect(registerPackage(result)).toBe(result)
})

it('fails clearly instead of silently dropping registration if the template changes', () => {
  expect(() => registerPackage('override fun getPackages() = emptyList()')).toThrow('Revalidate')
})

it('keeps other Gradle dependencies and adds Google identity only once', () => {
  const result = addDependency('dependencies { implementation("other:library:1.0") }')
  expect(result).toContain('other:library:1.0')
  expect(result).toContain("implementation 'com.google.android.gms:play-services-auth:22.0.0'")
  expect(result).toContain("implementation 'com.google.android.gms:play-services-auth-api-phone:18.2.0'")
  expect(addDependency(result)).toBe(result)
})

it('adds SMS consent when a previously generated project already has the phone hint dependency', () => {
  const previous = "// ingtalk-phone-number-hint-dependency\ndependencies { implementation 'com.google.android.gms:play-services-auth:22.0.0' }"
  const updated = addDependency(previous)
  expect(updated.match(/play-services-auth:22.0.0/g)).toHaveLength(1)
  expect(updated.match(/play-services-auth-api-phone:18.2.0/g)).toHaveLength(1)
  expect(addDependency(updated)).toBe(updated)
})

it('updates an already generated SMS dependency to the Kotlin-compatible version', () => {
  const previous = "dependencies { implementation 'other:library:1.0' }\n// ingtalk-sms-consent-dependency\ndependencies {\n    implementation 'com.google.android.gms:play-services-auth-api-phone:18.3.1'\n}"
  const updated = addDependency(previous)
  expect(updated).toContain("implementation 'other:library:1.0'")
  expect(updated).not.toContain('auth-api-phone:18.3.1')
  expect(updated.match(/play-services-auth-api-phone:18.2.0/g)).toHaveLength(1)
  expect(addDependency(updated)).toBe(updated)
})

it('does not add phone, contacts or SMS permissions and does not register iOS mods', () => {
  const plugin = require('../withPhoneNumberHint')
  const config = plugin({ name: 'Test', slug: 'test' })
  expect(Object.keys(config.mods)).toEqual(['android'])
  expect(Object.keys(config.mods.android).sort()).toEqual(['appBuildGradle', 'dangerous', 'mainApplication'])
  expect(config.android?.permissions).toBeUndefined()
})

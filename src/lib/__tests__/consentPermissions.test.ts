import * as Location from 'expo-location'
import { requestConsentPermissions } from '../consentPermissions'

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}))

describe('requestConsentPermissions', () => {
  it('선택 권한을 모두 끄면 OS 권한을 요청하지 않는다', async () => {
    await requestConsentPermissions({ location: false, notifications: false })
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled()
  })

  it('위치를 선택하면 위치 권한만 요청할 수 있다', async () => {
    await requestConsentPermissions({ location: true, notifications: false })
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1)
  })
})

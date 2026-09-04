import { fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { ProfileSectionTabs } from '../ProfileSectionTabs'
import { mainTabListTopGap, mainTabSegmentButtonStyle, mainTabSegmentStyle } from '../../lib/mainTabLayout'

jest.mock('../../i18n', () => ({ useI18n: () => ({ language: 'ko' }) }))

test('shows three localized profile sections and reports selection', () => {
  const onSelect = jest.fn()
  render(<ProfileSectionTabs selected="profile" onSelect={onSelect} />)

  expect(screen.getByRole('tab', { name: '프로필' }).props.accessibilityState).toEqual({ selected: true })
  expect(screen.getByRole('tab', { name: '계정' }).props.accessibilityState).toEqual({ selected: false })
  expect(screen.getByRole('tab', { name: '고객지원' }).props.accessibilityState).toEqual({ selected: false })

  fireEvent.press(screen.getByRole('tab', { name: '계정' }))
  expect(onSelect).toHaveBeenCalledWith('account')

  expect(StyleSheet.flatten(screen.getByTestId('profile-section-tabs').props.style)).toMatchObject({
    ...mainTabSegmentStyle,
    width: '100%',
    marginBottom: mainTabListTopGap,
  })
  expect(StyleSheet.flatten(screen.getByRole('tab', { name: '프로필' }).props.style)).toMatchObject(mainTabSegmentButtonStyle)
})

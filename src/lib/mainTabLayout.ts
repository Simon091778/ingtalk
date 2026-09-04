/** Shared left/right inset for primary-tab controls and list content. */
export const mainTabListHorizontalInset = 20

/** Shared vertical gap between the last tab control and the first list item. */
export const mainTabListTopGap = 16

/** Shared frame and button geometry for the secondary tabs below a main-tab header. */
export const mainTabSegmentStyle = {
  padding: 4,
  borderRadius: 14,
  flexDirection: 'row',
} as const

export const mainTabSegmentButtonStyle = {
  flex: 1,
  alignItems: 'center',
  paddingVertical: 9,
  borderRadius: 11,
} as const

/** Shared visual frame for the five primary bottom-tab headers. */
export const mainTabHeaderSpacing = {
  paddingHorizontal: mainTabListHorizontalInset,
  paddingTop: 18,
  paddingBottom: 14,
} as const

/** Shared typography for the title at the top-left of each primary bottom tab. */
export const mainTabTitleStyle = {
  color: '#1F2937',
  fontSize: 25,
  lineHeight: 32,
  fontWeight: '900',
  letterSpacing: -0.4,
} as const

/** Shared typography for the supporting line below a primary tab title. */
export const mainTabSubtitleStyle = {
  fontSize: 12,
  lineHeight: 17,
  fontWeight: '700',
  marginTop: 3,
} as const

/** Shared shape for actions displayed at the right of a primary tab header. */
export const mainTabHeaderActionStyle = {
  height: 40,
  borderRadius: 13,
  alignItems: 'center',
  justifyContent: 'center',
} as const

/** Shared typography for text actions displayed in a primary tab header. */
export const mainTabHeaderActionTextStyle = {
  fontSize: 13,
  lineHeight: 18,
  fontWeight: '900',
} as const

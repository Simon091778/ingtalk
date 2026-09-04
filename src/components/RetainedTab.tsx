import { memo, useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'

/** Lifetime is bounded by the authenticated app. Hidden screens must pause their own effects. */
export const RetainedTab = memo(function RetainedTab({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  if (!active && !visited) return null
  return <View collapsable={false} style={{ flex: 1, display: active ? 'flex' : 'none' }} pointerEvents={active ? 'auto' : 'none'} accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>{children}</View>
}, (previous, next) => !previous.active && !next.active)

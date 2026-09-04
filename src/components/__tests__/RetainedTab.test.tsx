import { useEffect, useState } from 'react'
import { fireEvent, render } from '@testing-library/react-native'
import { Button, Text, View } from 'react-native'
import { RetainedTab } from '../RetainedTab'

test('lazy visits preserve state and authenticated owner replacement discards it', () => {
  const mounted = jest.fn(), disposed = jest.fn()
  function Content() {
    const [value, setValue] = useState(0)
    useEffect(() => { mounted(); return disposed }, [])
    return <><Text>{value}</Text><Button title="increment" onPress={() => setValue(v => v + 1)} /></>
  }
  const tree = (active: boolean, account = 'first') => <View><View key={account}><RetainedTab active={active}><Content /></RetainedTab></View></View>
  const screen = render(tree(false))
  expect(mounted).not.toHaveBeenCalled()
  screen.rerender(tree(true))
  fireEvent.press(screen.getByText('increment'))
  screen.rerender(tree(false))
  expect(disposed).not.toHaveBeenCalled()
  screen.rerender(tree(true))
  expect(screen.getByText('1')).toBeTruthy()
  expect(mounted).toHaveBeenCalledTimes(1)
  screen.rerender(tree(true, 'second'))
  expect(screen.getByText('0')).toBeTruthy()
  expect(disposed).toHaveBeenCalledTimes(1)
  screen.unmount()
  expect(disposed).toHaveBeenCalledTimes(2)
})

test('hidden parent updates do not render retained content, and return receives latest props', () => {
  const renders = jest.fn()
  function Content({ value }: { value: string }) { renders(value); return <Text>{value}</Text> }
  const tree = (active: boolean, value: string) => <RetainedTab active={active}><Content value={value} /></RetainedTab>
  const screen = render(tree(true, 'first'))
  screen.rerender(tree(false, 'first'))
  const count = renders.mock.calls.length
  screen.rerender(tree(false, 'latest'))
  expect(renders).toHaveBeenCalledTimes(count)
  screen.rerender(tree(true, 'latest'))
  expect(screen.getByText('latest')).toBeTruthy()
})

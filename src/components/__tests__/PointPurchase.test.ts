import { pointProducts } from '../../lib/pointProducts'

describe('point purchase catalog', () => {
  it('uses the approved point and KRW package values', () => {
    expect(pointProducts.map(({ points, priceWon }) => [points, priceWon])).toEqual([
      [3000, 3300],
      [5000, 5500],
      [10000, 11000],
      [30000, 33000],
      [50000, 55000],
      [100000, 99000],
    ])
  })

  it('uses unique store product identifiers', () => {
    expect(new Set(pointProducts.map(item => item.id)).size).toBe(pointProducts.length)
  })
})

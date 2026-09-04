import { getAccountId } from '../lib/phoneAuth'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../i18n/localizedUi'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { captureAppError } from '../lib/observability'
import { supabase } from '../lib/supabase'
import { pointProducts, type PointProduct } from '../lib/pointProducts'
import { useI18n } from '../i18n'

type StoreProduct = {
  identifier: string
  priceString?: string
  currencyCode?: string
}

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient
const publicApiKey = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_APPLE_API_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_GOOGLE_API_KEY,
})?.trim()

export function PointPurchase({ onClose, onBalanceChanged, embeddedIos = false }: { onClose: () => void; onBalanceChanged: (balance: number) => void; embeddedIos?: boolean }) {
  const i18n = useI18n()
  const insets = useSafeAreaInsets()
  const [products, setProducts] = useState<StoreProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [buyingId, setBuyingId] = useState<string | null>(null)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const productMap = useMemo(() => new Map(products.map(product => [product.identifier, product])), [products])

  useEffect(() => {
    let active = true
    const load = async () => {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
        setSetupMessage('결제는 iPhone 또는 Android 앱에서 이용할 수 있어요.')
        setLoading(false)
        return
      }
      if (isExpoGo) {
        setSetupMessage('결제는 개발 빌드 또는 스토어에서 설치한 앱에서 이용할 수 있어요.')
        setLoading(false)
        return
      }
      if (!publicApiKey) {
        setSetupMessage('결제 서비스 키가 아직 등록되지 않았어요.')
        setLoading(false)
        return
      }
      if (!supabase) {
        setSetupMessage('서버 연결 후 결제를 이용할 수 있어요.')
        setLoading(false)
        return
      }
      try {
        const accountId = await getAccountId(supabase)
        if (!accountId) throw new Error('authentication_required')
        if (!active) return
        const { default: Purchases, PRODUCT_CATEGORY } = await import('react-native-purchases')
        if (!active) return
        if (!(await Purchases.isConfigured())) Purchases.configure({ apiKey: publicApiKey, appUserID: accountId })
        else await Purchases.logIn(accountId)
        const loaded = await Purchases.getProducts(pointProducts.map(item => item.id), PRODUCT_CATEGORY.NON_SUBSCRIPTION)
        if (!active) return
        setProducts(loaded)
        if (!loaded.length) setSetupMessage('스토어에 등록된 포인트 상품을 찾지 못했어요.')
      } catch (error) {
        captureAppError(error, 'payments', 'load_products')
        if (active) setSetupMessage('결제 상품을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const refreshBalance = async () => {
    if (!supabase) return
    for (const delay of [800, 1600, 3000, 5000]) {
      await new Promise(resolve => setTimeout(resolve, delay))
      const { data, error } = await supabase.rpc('my_point_balance')
      if (!error && data != null) onBalanceChanged(Number(data))
    }
  }

  const purchase = async (item: PointProduct) => {
    const product = productMap.get(item.id)
    if (!product || buyingId) return
    setBuyingId(item.id)
    try {
      if (!supabase) throw new Error('authentication_required')
      const accountId = await getAccountId(supabase)
      if (!accountId) throw new Error('authentication_required')
      const { default: Purchases } = await import('react-native-purchases')
      if (await Purchases.getAppUserID() !== accountId) await Purchases.logIn(accountId)
      await Purchases.purchaseStoreProduct(product as never)
      Alert.alert('결제가 완료됐어요', '스토어 확인 후 포인트가 자동으로 충전됩니다. 잠시만 기다려 주세요.')
      void refreshBalance()
    } catch (error) {
      const purchaseError = error as { userCancelled?: boolean; message?: string }
      if (!purchaseError.userCancelled) {
        captureAppError(error, 'payments', 'purchase', { productId: item.id })
        Alert.alert('결제하지 못했어요', purchaseError.message || '잠시 후 다시 시도해 주세요.')
      }
    } finally {
      setBuyingId(null)
    }
  }

  return <SafeAreaView edges={embeddedIos ? [] : ['top', 'bottom']} style={[styles.safe, embeddedIos && { paddingBottom: insets.bottom }]}>
    <View style={styles.header}>
      <Pressable style={styles.headerButton} hitSlop={10} onPress={onClose}><Text style={styles.close}>닫기</Text></Pressable>
      <Text style={styles.title}>포인트 충전</Text>
      <View style={styles.headerButton} />
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.intro}><Text style={styles.introTitle}>필요한 만큼 충전하세요</Text><Text style={styles.introText}>구매한 포인트는 대화 신청과 프로필 정보 수정에 사용할 수 있어요</Text></View>
      <View style={styles.notice}><Text style={styles.noticeText}>{i18n.language === 'ko'
        ? 'Google 또는 카카오 계정으로 인증해 두면, 앱을 다시 설치해도 같은 계정으로 포인트를 복구할 수 있어요.'
        : 'Verify with your Google or Kakao account to restore your points with the same account, even after reinstalling the app.'}</Text></View>
      {loading && <View style={styles.loading}><ActivityIndicator color="#D94F70" /><Text style={styles.loadingText}>결제 상품을 확인하고 있어요</Text></View>}
      {setupMessage && <View style={styles.notice}><Text style={styles.noticeText}>{setupMessage}</Text></View>}
      <View style={styles.products}>
        {pointProducts.map(item => {
          const storeProduct = productMap.get(item.id)
          const disabled = !storeProduct || buyingId !== null
          const koreanReferencePrice = i18n.language === 'ko'
            ? `${item.priceWon.toLocaleString('ko-KR')}원`
            : `₩${item.priceWon.toLocaleString('en-US')}`
          const displayPrice = storeProduct?.priceString?.trim() || (i18n.country === 'KR'
            ? koreanReferencePrice
            : loading
              ? (i18n.language === 'ko' ? '가격 확인 중…' : 'Loading price…')
              : (i18n.language === 'ko' ? '스토어 가격 확인 필요' : 'Store price unavailable'))
          const isKrwPrice = (i18n.country === 'KR' && !storeProduct)
            || storeProduct?.currencyCode === 'KRW'
            || /[₩원]/.test(storeProduct?.priceString ?? '')
          return <Pressable key={item.id} testID={`point-product-${item.points}`} disabled={disabled} onPress={() => void purchase(item)} style={({ pressed }) => [styles.product, disabled && styles.productDisabled, pressed && !disabled && styles.productPressed]}>
            <Text style={styles.points}>{item.points.toLocaleString(i18n.language === 'ko' ? 'ko-KR' : 'en-US')}P</Text>
            <View style={styles.priceSide}><View style={styles.priceLabel}><Text style={styles.price}>{displayPrice}</Text>{isKrwPrice && <Text style={styles.vatLabel}>(VAT 포함)</Text>}</View><Text style={styles.arrow}>{buyingId === item.id ? '결제 중…' : '›'}</Text></View>
          </Pressable>
        })}
      </View>
      <Text style={styles.footnote}>결제는 Apple App Store 또는 Google Play에서 처리됩니다. 실제 청구 금액은 결제 확인 화면의 현지 통화 가격을 기준으로 합니다.</Text>
    </ScrollView>
  </SafeAreaView>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFF9F5' },
  header: { minHeight: 58, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#EEE7E2' },
  headerButton: { width: 76, minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' },
  close: { color: '#D94F70', fontSize: 16, fontWeight: '900' },
  title: { color: '#2D2025', fontSize: 17, fontWeight: '900' },
  content: { padding: 18, paddingBottom: 40 },
  intro: { padding: 18, borderRadius: 20, backgroundColor: '#4A2634' },
  introTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  introText: { color: '#F8DCE5', fontSize: 12, lineHeight: 19, marginTop: 7 },
  loading: { alignItems: 'center', paddingVertical: 22 },
  loadingText: { color: '#8E7680', fontSize: 12, marginTop: 8 },
  notice: { backgroundColor: '#FFF0E9', borderRadius: 14, padding: 13, marginTop: 14 },
  noticeText: { color: '#9A3412', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  products: { gap: 10, marginTop: 16 },
  product: { minHeight: 68, paddingHorizontal: 17, borderRadius: 17, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EEDDE3', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  productDisabled: { opacity: 0.58 },
  productPressed: { backgroundColor: '#FFF3F6', transform: [{ scale: 0.995 }] },
  points: { color: '#3B1F2B', fontSize: 18, fontWeight: '900' },
  priceSide: { flexDirection: 'row', alignItems: 'center' },
  priceLabel: { alignItems: 'flex-end' },
  price: { color: '#6F5962', fontSize: 14, fontWeight: '800' },
  vatLabel: { color: '#9A8A91', fontSize: 9, marginTop: 2 },
  arrow: { width: 50, color: '#D94F70', fontSize: 19, fontWeight: '900', textAlign: 'right' },
  footnote: { color: '#9C8C92', fontSize: 10, lineHeight: 16, marginTop: 18 },
})

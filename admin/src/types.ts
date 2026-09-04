export type AdminRole = 'reviewer' | 'moderator' | 'owner'
export type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed'

export type AdminIdentity = {
  user_id: string
  email: string
  role: AdminRole
}

export type DashboardStats = {
  open_reports: number
  reviewing_reports: number
  urgent_reports: number
  suspended_users: number
  actions_today: number
}

export type EvidenceMessage = {
  id: number
  sender_id: string
  body: string
  created_at: string
}

export type ReportItem = {
  id: string
  target_type: string
  reason: string
  details: string
  priority: 'normal' | 'high' | 'urgent'
  status: ReportStatus
  created_at: string
  reviewed_at: string | null
  review_note: string | null
  room_id: string | null
  reported_user_id: string
  reported_nickname: string
  reported_status: string
  suspended_until: string | null
  reporter_nickname: string
  content_snapshot: EvidenceMessage[] | Record<string, unknown>
}

export type UserSummary = {
  user_id: string
  nickname: string
  gender: string | null
  birth_year: number
  status: string
  suspended_until: string | null
  created_at: string
  updated_at: string
  point_balance: number
  talk_count: number
  post_count: number
  comment_count: number
  report_count: number
  action_count: number
}

export type UserProfileDetail = {
  id: string
  nickname: string
  gender: string | null
  birth_year: number
  region_code: string
  introduction: string
  avatar_url: string | null
  status: string
  trust_score: number
  is_verified: boolean
  suspended_until: string | null
  suspension_reason: string | null
  created_at: string
  updated_at: string
  point_balance: number
}

export type UserDetail = {
  profile: UserProfileDetail
  talks: Array<{
    id: string
    purpose: string
    topic: string
    is_active: boolean
    created_at: string
    expires_at: string
    location_captured_at: string | null
  }>
  posts: Array<{ id: string; title: string; body: string; image_url: string | null; view_count: number; created_at: string }>
  comments: Array<{ id: string; body: string; created_at: string; post_id: string; post_title: string }>
  reports: Array<{ id: string; reason: string; priority: string; status: string; details: string; created_at: string; reviewed_at: string | null; review_note: string | null }>
  actions: Array<{ id: number; action: string; note: string; before_state: unknown; after_state: unknown; created_at: string; admin_email: string | null }>
  point_transactions: Array<{ id: number; amount: number; reason: string; created_at: string }>
}

export type AdminOperator = { user_id: string; email: string; role: AdminRole; is_active: boolean }

export type AuditEvent = {
  id: number
  admin_user_id: string
  admin_email: string
  admin_role: AdminRole | null
  action: string
  note: string
  target_user_id: string | null
  target_nickname: string | null
  report_id: string | null
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
  point_amount: number | null
  created_at: string
}

export type AdminChatRequest = {
  request_id: string
  sender_id: string
  sender_nickname: string
  receiver_id: string
  receiver_nickname: string
  request_status: string
  opening_message: string
  source_topic: string
  board_post_id: string | null
  room_id: string | null
  room_closed_at: string | null
  created_at: string
  responded_at: string | null
  withdrawn_at: string | null
}

export type AdminChatRoom = {
  room_id: string
  request_id: string
  sender_id: string
  sender_nickname: string
  receiver_id: string
  receiver_nickname: string
  room_status: 'active' | 'deleted'
  live_message_count: number
  backup_message_count: number
  deleted_message_count: number
  created_at: string
  closed_at: string | null
  last_message_at: string | null
}

export type AdminMessageBackup = {
  original_message_id: number
  room_id: string
  sender_id: string
  sender_nickname: string | null
  body: string
  moderation_state: string
  message_created_at: string
  backed_up_at: string
  deleted_from_live_at: string | null
  deleted_by_user_id: string | null
  deletion_action: 'delete' | 'block' | null
}

export type SupportThreadSummary = {
  thread_id: string
  user_id: string
  nickname: string
  status: 'open' | 'closed'
  last_message: string | null
  last_sender_type: 'user' | 'admin' | null
  unread_by_admin: boolean
  last_message_at: string
  created_at: string
  updated_at: string
}

export type SupportMessage = {
  message_id: number
  sender_type: 'user' | 'admin'
  sender_user_id: string
  sender_label: string
  body: string
  created_at: string
}

export type AdminOpenChatRoom = {
  room_id: string; title: string; category: string; room_status: 'active' | 'closed'
  owner_user_id: string | null; owner_nickname: string | null; member_count: number; max_members: number
  message_count: number; report_count: number; created_at: string; last_user_message_at: string
  inactivity_warning_at: string | null; closed_at: string | null; closed_reason: string | null
}

export type AdminOpenChatDetail = {
  room: {
    id: string; title: string; description: string; notice: string; category: string; region: string | null
    tags: string[]; status: 'active' | 'closed'; owner_user_id: string | null; owner_nickname: string | null
    max_members: number; created_at: string; updated_at: string; last_user_message_at: string
    inactivity_warning_at: string | null; closed_at: string | null; closed_reason: string | null
    cover_storage_path: string | null
  }
  participants: Array<{ user_id: string; nickname: string; account_status: string; joined_at: string; is_owner: boolean }>
  bans: Array<{ user_id: string; nickname: string | null; created_at: string }>
  messages: Array<{
    id: number; sender_user_id: string | null; sender_nickname: string | null; message_type: 'text' | 'system' | 'audio' | 'image'
    content: string | null; audio_storage_path: string | null; audio_duration_ms: number | null
    image_storage_path: string | null; image_width: number | null; image_height: number | null
    reply_to_message_id: number | null; created_at: string; report_count: number
  }>
}

export type AdminPublicContent = {
  content_kind: 'talk' | 'post'; content_id: string; author_id: string; author_nickname: string
  title: string; body: string; content_status: 'active' | 'inactive'; country_code: string
  created_at: string; expires_at: string | null; comment_count: number; report_count: number
}

export type AdminBoardComment = {
  comment_id: string; author_id: string; author_nickname: string; anonymous_name: string
  body: string; parent_id: string | null; created_at: string
}
export interface AccountOperations {
  account_id: string
  checked_at: string
  profile_active: boolean
  phone: { status: 'active' | 'detached' | 'none' | 'unavailable'; phone: string | null; verified_at: string | null; detached_at?: string | null; detach_reason?: string | null }
  google: { status: 'active' | 'none' | 'unavailable'; email: string | null; verified_at: string | null }
  kakao: { status: 'active' | 'none' | 'unavailable'; verified_at: string | null }
  identities: Array<{ provider: string; linked_at: string; active: boolean }>
  devices: Array<{
    id: string; platform: string; is_primary: boolean; created_at: string; active_sessions: number
    rewards: Array<{ type: string; account_claimed_at: string | null; device_claimed_at: string | null; available: boolean; next_available_at: string | null }>
  }>
  ad_claims: Array<{ reference: string; device_id: string | null; created_at: string; expires_at: string; processed_at: string | null; status: 'pending' | 'awarded' | 'denied' | 'expired' }>
  verifications: Array<{ id: number; provider: string; awarded: boolean; verified_at: string }>
}

export type AdminAccountMerge = {
  merge_id: string; survivor_account_id: string; survivor_nickname: string | null; losing_account_id: string
  verified_provider: 'phone' | 'google' | 'kakao'; survivor_balance: number; losing_balance: number; merged_balance: number
  asset_policy: 'discard_losing_assets' | 'legacy_transfer' | string
  deleted_posts: number; deleted_comments: number; deleted_messages: number; deleted_purchases: number
  deleted_conversation_cards: number; deleted_open_chat_messages: number; point_ledger_entries: number; created_at: string
}

export type AdminPointPurchase = {
  receipt_id: string; user_id: string | null; nickname: string | null; product_id: string
  payer: {
    original_account_id: string | null; operational_account_id: string | null; canonical_account_id: string | null
    nickname: string | null; canonical_nickname: string | null
    account_status: string; canonical_account_status: string | null; merged: boolean
    phone: { status: 'active' | 'detached' | 'none' | 'unavailable'; phone: string | null; verified_at: string | null; detached_at?: string | null; detach_reason?: string | null }
    google: { status: 'active' | 'none' | 'unavailable'; email: string | null; verified_at: string | null }
    kakao: { status: 'active' | 'none' | 'unavailable'; verified_at: string | null }
  }
  payment_provider: string
  point_amount: number; price_won: number; purchase_currency: string | null; purchase_amount: number | null
  purchase_country_code: string | null; store: string; environment: string; status: 'credited' | 'refunded'
  unrecovered_points: number; transaction_reference: string; purchased_at: string | null; refunded_at: string | null
  account_deleted_at: string | null; created_at: string
}

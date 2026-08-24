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
  content_snapshot: EvidenceMessage[]
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
  talks: Array<{ id: string; purpose: string; topic: string; is_active: boolean; created_at: string; expires_at: string }>
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

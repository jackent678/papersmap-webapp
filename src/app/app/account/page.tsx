'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import PageHeader from '../_components/PageHeader'
import { supabase } from '@/lib/supabaseClient'

type Profile = {
  id: string
  user_id: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
  phone: string | null
  department: string | null
  job_title: string | null
  bio: string | null
  theme_preference: 'light' | 'dark' | 'system'
  notification_email: boolean
  notification_push: boolean
  language: string
  timezone: string
  created_at: string
  updated_at: string
}

type NotificationSettings = {
  email_comments: boolean
  email_mentions: boolean
  email_tasks: boolean
  email_projects: boolean
  push_comments: boolean
  push_mentions: boolean
  push_tasks: boolean
  push_projects: boolean
}

export default function AccountPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [profile, setProfile] = useState<Profile | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'profile' | 'notifications' | 'security'>('profile')

  // 通知設定（獨立狀態，因為可能在 profiles 表中是 JSON 欄位）
  const [notifications, setNotifications] = useState<NotificationSettings>({
    email_comments: true,
    email_mentions: true,
    email_tasks: true,
    email_projects: true,
    push_comments: false,
    push_mentions: true,
    push_tasks: true,
    push_projects: false,
  })

  // 載入個人資料
  useEffect(() => {
    let cancelled = false

    async function loadProfile() {
      setLoading(true)
      setError(null)

      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) throw new Error('請先登入')

        // 從 profiles 表讀取資料
        const { data, error: profileError } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', user.id)
          .single()

        if (profileError && profileError.code !== 'PGRST116') {
          throw profileError
        }

        if (!cancelled) {
          if (data) {
            setProfile(data as Profile)
            // 如果有 notification_settings JSON 欄位，可以解析
            // @ts-ignore
            if (data.notification_settings) {
              // @ts-ignore
              setNotifications(prev => ({ ...prev, ...data.notification_settings }))
            }
          } else {
            // 建立預設 profile
            const newProfile = {
              user_id: user.id,
              display_name: user.user_metadata?.full_name || user.email?.split('@')[0] || '',
              email: user.email,
              theme_preference: 'system' as const,
              notification_email: true,
              notification_push: false,
              language: 'zh-TW',
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
            setProfile(newProfile as Profile)
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? '載入個人資料失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadProfile()

    return () => {
      cancelled = true
    }
  }, [])

  // 處理頭像上傳
  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // 檢查檔案大小（限制 2MB）
    if (file.size > 2 * 1024 * 1024) {
      setError('頭像檔案不能超過 2MB')
      return
    }

    // 檢查檔案類型
    if (!file.type.startsWith('image/')) {
      setError('請上傳圖片檔案')
      return
    }

    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
  }

  // 儲存個人資料
  async function handleSaveProfile() {
    if (!profile) return

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('請先登入')

      // 1. 如果有新頭像，先上傳到 Storage
      let avatarUrl = profile.avatar_url
      if (avatarFile) {
        const fileExt = avatarFile.name.split('.').pop()
        const fileName = `avatar-${user.id}-${Date.now()}.${fileExt}`
        const filePath = `${user.id}/${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, avatarFile, { upsert: true })

        if (uploadError) throw uploadError

        // 取得公開 URL
        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath)

        avatarUrl = publicUrl
      }

      // 2. 更新 profiles 表
      const profileData = {
        ...profile,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
        // @ts-ignore - 如果有 notification_settings 欄位
        notification_settings: notifications,
      }

      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert(profileData, { onConflict: 'user_id' })

      if (upsertError) throw upsertError

      // 3. 如果有變更 display_name，同步更新 auth 的 user_metadata
      if (profile.display_name !== user.user_metadata?.full_name) {
        await supabase.auth.updateUser({
          data: { full_name: profile.display_name }
        })
      }

      setSuccess('個人資料已更新')
      setAvatarFile(null)
      
      // 重新載入最新資料
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .single()
      
      if (data) setProfile(data as Profile)
    } catch (e: any) {
      setError(e?.message ?? '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  // 登出
  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="帳號設定" description="個人資料、通知偏好、顯示名稱等。" />
        <div className="rounded border bg-white p-8 text-center text-gray-500">
          載入中...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader 
        title="帳號設定" 
        description="管理您的個人資料、通知偏好與帳號安全" 
      />

      {/* 錯誤/成功提示 */}
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          {success}
        </div>
      )}

      {/* 頁籤 */}
      <div className="border-b">
        <nav className="flex gap-6">
          <button
            onClick={() => setActiveTab('profile')}
            className={`pb-3 text-sm font-medium transition-colors ${
              activeTab === 'profile'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            個人資料
          </button>
          <button
            onClick={() => setActiveTab('notifications')}
            className={`pb-3 text-sm font-medium transition-colors ${
              activeTab === 'notifications'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            通知設定
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`pb-3 text-sm font-medium transition-colors ${
              activeTab === 'security'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            安全性
          </button>
        </nav>
      </div>

      {/* 個人資料頁籤 */}
      {activeTab === 'profile' && profile && (
        <div className="space-y-6">
          {/* 頭像區塊 */}
          <div className="rounded border bg-white p-6">
            <h3 className="text-sm font-medium mb-4">個人頭像</h3>
            <div className="flex items-center gap-6">
              <div className="relative">
                {avatarPreview || profile.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarPreview || profile.avatar_url || ''}
                    alt="頭像"
                    className="w-20 h-20 rounded-full object-cover border"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gray-100 border flex items-center justify-center text-gray-400">
                    <span className="text-2xl">
                      {profile.display_name?.charAt(0)?.toUpperCase() || '?'}
                    </span>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <label className="inline-block">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="hidden"
                  />
                  <span className="rounded bg-black text-white px-4 py-2 text-sm cursor-pointer hover:bg-gray-800">
                    上傳新頭像
                  </span>
                </label>
                {avatarFile && (
                  <p className="text-xs text-gray-500">
                    已選擇：{avatarFile.name}
                  </p>
                )}
                <p className="text-xs text-gray-500">
                  支援 JPG、PNG、GIF，最大 2MB
                </p>
              </div>
            </div>
          </div>

          {/* 基本資料 */}
          <div className="rounded border bg-white p-6 space-y-4">
            <h3 className="text-sm font-medium">基本資料</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-gray-500">顯示名稱</label>
                <input
                  type="text"
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={profile.display_name || ''}
                  onChange={(e) => setProfile({ ...profile, display_name: e.target.value })}
                  placeholder="您的顯示名稱"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">電子郵件</label>
                <input
                  type="email"
                  className="w-full rounded border px-3 py-2 text-sm bg-gray-50"
                  value={profile.email || ''}
                  disabled
                  readOnly
                />
                <p className="text-[11px] text-gray-500">電子郵件無法在此修改</p>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">部門</label>
                <input
                  type="text"
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={profile.department || ''}
                  onChange={(e) => setProfile({ ...profile, department: e.target.value })}
                  placeholder="例如：研發部"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">職稱</label>
                <input
                  type="text"
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={profile.job_title || ''}
                  onChange={(e) => setProfile({ ...profile, job_title: e.target.value })}
                  placeholder="例如：前端工程師"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">電話</label>
                <input
                  type="tel"
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={profile.phone || ''}
                  onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
                  placeholder="0912-345-678"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-500">時區</label>
                <select
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={profile.timezone || 'Asia/Taipei'}
                  onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
                >
                  <option value="Asia/Taipei">台北 (GMT+8)</option>
                  <option value="Asia/Tokyo">東京 (GMT+9)</option>
                  <option value="America/New_York">紐約 (GMT-5)</option>
                  <option value="Europe/London">倫敦 (GMT+0)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-500">個人簡介</label>
              <textarea
                className="w-full rounded border px-3 py-2 text-sm min-h-[100px]"
                value={profile.bio || ''}
                onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                placeholder="簡單介紹一下自己..."
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-500">主題偏好</label>
              <div className="flex gap-4">
                {(['light', 'dark', 'system'] as const).map((theme) => (
                  <label key={theme} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="theme"
                      value={theme}
                      checked={profile.theme_preference === theme}
                      onChange={(e) => setProfile({ 
                        ...profile, 
                        theme_preference: e.target.value as typeof theme 
                      })}
                    />
                    <span className="text-sm">
                      {theme === 'light' && '淺色'}
                      {theme === 'dark' && '深色'}
                      {theme === 'system' && '跟隨系統'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 通知設定頁籤 */}
      {activeTab === 'notifications' && (
        <div className="rounded border bg-white p-6 space-y-6">
          <div>
            <h3 className="text-sm font-medium mb-4">電子郵件通知</h3>
            <div className="space-y-3">
              {[
                { key: 'email_comments', label: '留言回覆' },
                { key: 'email_mentions', label: '提及我的通知' },
                { key: 'email_tasks', label: '任務指派與更新' },
                { key: 'email_projects', label: '專案動態' },
              ].map((item) => (
                <label key={item.key} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={notifications[item.key as keyof NotificationSettings] as boolean}
                    onChange={(e) => setNotifications({
                      ...notifications,
                      [item.key]: e.target.checked
                    })}
                    className="rounded"
                  />
                  <span className="text-sm">{item.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-4">推播通知</h3>
            <div className="space-y-3">
              {[
                { key: 'push_comments', label: '留言回覆' },
                { key: 'push_mentions', label: '提及我的通知' },
                { key: 'push_tasks', label: '任務指派與更新' },
                { key: 'push_projects', label: '專案動態' },
              ].map((item) => (
                <label key={item.key} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={notifications[item.key as keyof NotificationSettings] as boolean}
                    onChange={(e) => setNotifications({
                      ...notifications,
                      [item.key]: e.target.checked
                    })}
                    className="rounded"
                  />
                  <span className="text-sm">{item.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 安全性頁籤 */}
      {activeTab === 'security' && (
        <div className="rounded border bg-white p-6 space-y-6">
          <div>
            <h3 className="text-sm font-medium mb-4">密碼與認證</h3>
            <div className="space-y-3">
              <button
                onClick={() => {
                  supabase.auth.resetPasswordForEmail(profile?.email || '', {
                    redirectTo: `${window.location.origin}/account/update-password`,
                  })
                  setSuccess('密碼重設信已寄出，請檢查信箱')
                }}
                className="text-sm text-black underline"
              >
                變更密碼
              </button>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-4">登入紀錄</h3>
            <div className="text-sm text-gray-600">
              上次登入：{new Date().toLocaleString('zh-TW')}
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-4 text-red-600">危險區域</h3>
            <button
              onClick={handleSignOut}
              className="rounded border border-red-200 text-red-700 px-4 py-2 text-sm hover:bg-red-50"
            >
              登出所有裝置
            </button>
          </div>
        </div>
      )}

      {/* 儲存按鈕 */}
      <div className="flex justify-end gap-3">
        <button
          onClick={handleSaveProfile}
          disabled={saving}
          className="rounded bg-black text-white px-6 py-2 text-sm disabled:opacity-50"
        >
          {saving ? '儲存中...' : '儲存變更'}
        </button>
      </div>
    </div>
  )
}
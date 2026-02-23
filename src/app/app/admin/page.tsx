'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

type MemberRow = {
  user_id: string
  role: 'admin' | 'manager' | 'member'
  is_active: boolean
  display_name: string | null
  email: string | null
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ')
}

export default function AdminPage() {
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [members, setMembers] = useState<MemberRow[]>([])
  const [q, setQ] = useState('')

  async function checkAdminAndLoad() {
    setChecking(true)
    setError(null)
    try {
      const { data: userRes } = await supabase.auth.getUser()
      const user = userRes.user
      if (!user) {
        router.replace('/auth')
        return
      }

      // 用 default org 的 org_members 判斷是否 admin
      // 依你目前系統單一 org 寫法：查「自己在 org_members 的 role」
      const { data: mem, error: memErr } = await supabase
        .from('org_members')
        .select('role, is_active')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

      if (memErr) throw memErr
      const ok = mem?.role === 'admin'
      setIsAdmin(!!ok)

      if (!ok) {
        router.replace('/app/projects')
        return
      }

      // admin 才載入成員列表：用 v_org_members（或你自己的 view）
      const { data, error } = await supabase
        .from('v_org_members')
        .select('user_id, role, is_active, display_name, email')
        .order('created_at', { ascending: true })

      if (error) throw error
      setMembers((data ?? []) as MemberRow[])
    } catch (e: any) {
      setError(e?.message ?? '載入失敗')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    checkAdminAndLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return members
    return members.filter((m) => {
      return (
        (m.display_name ?? '').toLowerCase().includes(kw) ||
        (m.email ?? '').toLowerCase().includes(kw) ||
        (m.user_id ?? '').toLowerCase().includes(kw)
      )
    })
  }, [members, q])

  // ✅ 前端防呆：禁止把任何人改成 admin（包含自己）
  // ⚠️ 安全性最終仍要在 RPC / DB 端限制（我也附了 DB 建議在下面）
  async function setRole(user_id: string, role: MemberRow['role']) {
    setError(null)

    // 不允許把 role 設為 admin
    if (role === 'admin') {
      setError('禁止透過此頁面變更為 admin 權限（請由資料庫/系統維運流程處理）。')
      return
    }

    try {
      const { error } = await supabase.rpc('admin_set_member_role', { p_user_id: user_id, p_role: role })
      if (error) throw error
      await checkAdminAndLoad()
    } catch (e: any) {
      setError(e?.message ?? '更新角色失敗')
    }
  }

  async function setActive(user_id: string, active: boolean) {
    setError(null)
    try {
      const { error } = await supabase.rpc('admin_set_member_active', { p_user_id: user_id, p_active: active })
      if (error) throw error
      await checkAdminAndLoad()
    } catch (e: any) {
      setError(e?.message ?? '更新啟用狀態失敗')
    }
  }

  async function setDisplayName(user_id: string, display_name: string) {
    setError(null)
    try {
      const { error } = await supabase.rpc('admin_set_display_name', { p_user_id: user_id, p_display_name: display_name })
      if (error) throw error
      await checkAdminAndLoad()
    } catch (e: any) {
      setError(e?.message ?? '更新姓名失敗')
    }
  }

  if (checking) return <div className="p-6 text-sm text-gray-600">載入中…</div>
  if (!isAdmin) return null

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="text-lg font-semibold">系統管理</div>
        <div className="text-xs text-gray-500 mt-1">只有 Admin 可以管理公司內所有成員的角色與資訊。</div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="font-semibold">發生問題</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      <div className="rounded border bg-white p-4 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <div className="text-xs text-gray-500">搜尋（姓名 / Email / UserID）</div>
            <input
              className="w-[min(520px,100%)] rounded border px-3 py-2 text-sm"
              placeholder="輸入關鍵字"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <button className="rounded border px-3 py-2 text-sm" onClick={checkAdminAndLoad}>
            重新整理
          </button>
        </div>

        <div className="overflow-auto">
          <table className="min-w-[980px] w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-3">姓名</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">角色</th>
                <th className="py-2 pr-3">啟用</th>
                <th className="py-2 pr-3">User ID</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.user_id} className="border-b">
                  <td className="py-2 pr-3">
                    <input
                      className="w-[220px] rounded border px-2 py-1 text-sm"
                      defaultValue={m.display_name ?? ''}
                      placeholder="（可編輯）"
                      onBlur={(e) => {
                        const v = e.target.value
                        if ((m.display_name ?? '') !== v) setDisplayName(m.user_id, v)
                      }}
                    />
                  </td>

                  <td className="py-2 pr-3">{m.email ?? '-'}</td>

                  <td className="py-2 pr-3">
                    <select
                      className="rounded border px-2 py-1.5 text-sm"
                      value={m.role}
                      onChange={(e) => setRole(m.user_id, e.target.value as any)}
                    >
                      {/* ✅ 移除 admin 選項：避免 UI 變更成 admin */}
                      <option value="manager">manager</option>
                      <option value="member">member</option>
                    </select>

                    {/* ✅ 若目前資料就是 admin，給提示（但不可在此頁改成 admin） */}
                    {m.role === 'admin' && (
                      <div className="text-[11px] text-gray-500 mt-1">此帳號為 admin（不可在此頁面升級/降級 admin）。</div>
                    )}
                  </td>

                  <td className="py-2 pr-3">
                    <button
                      className={cn(
                        'rounded px-3 py-1.5 text-sm border',
                        m.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-700 border-gray-200'
                      )}
                      onClick={() => setActive(m.user_id, !m.is_active)}
                      title="點擊切換啟用/停用"
                    >
                      {m.is_active ? '啟用中' : '已停用'}
                    </button>
                  </td>

                  <td className="py-2 pr-3 font-mono">{m.user_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-[11px] text-gray-500">
          建議：停用成員比刪除安全（不會破壞歷史任務/專案資料）。角色：manager 可管理任務；member 一般使用。
          <br />
          注意：此頁面<strong>禁止</strong>把任何人升級為 admin；如需 admin 請用資料庫維運流程處理。
        </div>
      </div>
    </div>
  )
}
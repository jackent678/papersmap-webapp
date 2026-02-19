'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

/**
 * 🚀 儀表板 專業版 v2
 * - 視覺層級最佳化：清晰區分「總覽 KPI」、「行動清單」、「團隊概況」
 * - 狀態模型：todo / in_progress / done (已移除 blocked / ready_for_review)
 * - 核心追蹤：逾期、今日到期、7日內到期、進行中、已完成（今日/本週）
 * - 支援預估完成時間 expected_finish_at（自動降級）
 * - 主管（admin/manager）可看全組織；成員只看自己
 * - 列表顯示專案名稱、指派對象，並提供快速更新狀態
 */

type Role = 'admin' | 'manager' | 'member'
type TaskStatus = 'todo' | 'in_progress' | 'done'

type OrgMember = { org_id: string; role: Role; is_active: boolean }

type ProjectRow = {
  id: string
  org_id?: string | null
  name: string
  description: string | null
  status: string | null
  priority: string | null
  target_due_date: string | null
  created_at: string | null
}

// 定義資料庫返回的原始任務型別
type TaskRowRaw = {
  id: string
  org_id: string | null
  project_id: string
  description: string
  assignee_user_id: string | null
  status: string  // 資料庫可能返回 string，需要轉換
  created_at: string
  expected_finish_at?: string | null
}

// 應用層使用的任務型別（已轉換 status）
type TaskRow = {
  id: string
  org_id: string | null
  project_id: string
  description: string
  assignee_user_id: string | null
  status: TaskStatus  // 確保是聯合型別
  created_at: string
  expected_finish_at?: string | null
}

type OrgUserOption = { user_id: string; full_name: string }

// ========== 工具函式 ==========
function cn(...classes: (string | boolean | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

function formatISODate(iso?: string | null) {
  if (!iso) return '—'
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

function startOfTodayUTC() {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function addDaysUTC(date: Date, days: number) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function toUTCDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return '待處理'
    case 'in_progress':
      return '進行中'
    case 'done':
      return '已完成'
  }
}

function taskStatusBadgeColor(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/50'
    case 'in_progress':
      return 'bg-sky-50 text-sky-700 ring-1 ring-sky-200/50'
    default:
      return 'bg-slate-50 text-slate-700 ring-1 ring-slate-200/50'
  }
}

function getPillColor(intent: 'critical' | 'warning' | 'positive' | 'neutral') {
  switch (intent) {
    case 'critical':
      return 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/50'
    case 'warning':
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/50'
    case 'positive':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/50'
    default:
      return 'bg-slate-50 text-slate-700 ring-1 ring-slate-200/50'
  }
}

function isPermissionError(error: any): boolean {
  const msg = error?.message?.toLowerCase() || ''
  return msg.includes('permission denied') || msg.includes('rls') || msg.includes('policy')
}

// 安全的狀態轉換函式
function toTaskStatus(status: string): TaskStatus {
  if (status === 'todo' || status === 'in_progress' || status === 'done') {
    return status
  }
  // 預設返回 'todo' 作為安全選項
  return 'todo'
}

// ========== 主元件 ==========
export default function AppDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('member')
  const isSupervisor = role === 'admin' || role === 'manager'

  // 資料
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUserOption[]>([])

  // 專案快取
  const [projectMap, setProjectMap] = useState<Record<string, ProjectRow | null>>({})
  const [loadingProjects, setLoadingProjects] = useState(false)

  // 功能旗標
  const [hasExpectedFinish, setHasExpectedFinish] = useState<boolean | null>(null)

  // 快速更新狀態
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null)

  // ========== 輔助函式：使用者名稱、專案名稱 ==========
  function getUserDisplayName(userId: string | null): string {
    if (!userId) return '未指派'
    const found = orgUsers.find(u => u.user_id === userId)
    return found?.full_name || userId.slice(0, 8)
  }

  function getProjectName(projectId: string): string {
    const proj = projectMap[projectId]
    return proj?.name || `專案 (${projectId.slice(0, 6)})`
  }

  // ========== 預載專案名稱 ==========
  async function preloadProjectNames(orgId: string, taskList: TaskRow[]) {
    const projectIds = Array.from(new Set(taskList.map(t => t.project_id).filter(Boolean)))
    if (projectIds.length === 0) return

    const missingIds = projectIds.filter(id => !(id in projectMap))
    if (missingIds.length === 0) return

    setLoadingProjects(true)
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name')
        .eq('org_id', orgId)
        .in('id', missingIds)

      if (error) {
        if (isPermissionError(error)) {
          setError('無法讀取專案名稱，請確認專案資料表權限。')
        }
        // 設定為 null 避免重複請求
        setProjectMap(prev => {
          const next = { ...prev }
          missingIds.forEach(id => { next[id] = null })
          return next
        })
        return
      }

      const newMap: Record<string, ProjectRow> = {}
      ;(data || []).forEach((p: any) => { newMap[p.id] = p })
      setProjectMap(prev => ({ ...prev, ...newMap }))
    } finally {
      setLoadingProjects(false)
    }
  }

  // ========== 偵測 expected_finish_at 欄位是否存在 ==========
  async function detectExpectedFinishColumn(orgId: string): Promise<boolean> {
    if (hasExpectedFinish !== null) return hasExpectedFinish

    const probe = await supabase
      .from('project_tasks')
      .select('id, expected_finish_at')
      .eq('org_id', orgId)
      .limit(1)

    if (!probe.error) {
      setHasExpectedFinish(true)
      return true
    }

    // 權限錯誤仍視為可能存在（避免關閉功能）
    if (isPermissionError(probe.error)) {
      setHasExpectedFinish(true)
      return true
    }

    setHasExpectedFinish(false)
    return false
  }

  // ========== 載入核心資料 ==========
  async function loadDashboardData(orgId: string, userRole: Role, currentUserId: string) {
    setError(null)

    const hasEF = await detectExpectedFinishColumn(orgId)

    // 1. 組裝查詢欄位
    let fields = 'id, org_id, project_id, description, assignee_user_id, status, created_at'
    if (hasEF) fields += ', expected_finish_at'

    let query = supabase
      .from('project_tasks')
      .select(fields)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })

    // 成員只看自己
    if (!isSupervisor) {
      query = query.eq('assignee_user_id', currentUserId)
    }

    const { data: taskData, error: taskError } = await query
    
    if (taskError) {
      if (isPermissionError(taskError)) {
        throw new Error('無法讀取任務資料，請確認資料表權限設定。')
      }
      throw taskError
    }

    // 安全的型別轉換：先轉為 unknown，再轉為 TaskRowRaw[]
    const rawTasks = (taskData || []) as unknown as TaskRowRaw[]
    
    // 轉換為應用層任務型別（確保 status 是正確的聯合型別）
    const convertedTasks: TaskRow[] = rawTasks.map(task => ({
      ...task,
      status: toTaskStatus(task.status)
    }))

    setTasks(convertedTasks)

    // 初始化專案快取狀態 (undefined 表示尚未載入)
    setProjectMap(prev => {
      const next = { ...prev }
      convertedTasks.forEach(t => {
        if (!(t.project_id in next)) next[t.project_id] = undefined as any
      })
      return next
    })
    await preloadProjectNames(orgId, convertedTasks)

    // 2. 載入組織成員（用於顯示姓名）
    const { data: users, error: usersError } = await supabase
      .from('v_org_users')
      .select('user_id, full_name')
      .eq('org_id', orgId)
      .order('full_name')

    if (!usersError && users) {
      setOrgUsers(users.map((u: any) => ({ user_id: u.user_id, full_name: u.full_name || u.user_id })))
    } else {
      // 至少包含自己
      setOrgUsers([{ user_id: currentUserId, full_name: userEmail || currentUserId.slice(0, 8) }])
    }
  }

  // ========== 初始化 ==========
  useEffect(() => {
    let isMounted = true

    async function initialize() {
      setLoading(true)
      setError(null)

      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setError('請先登入以查看儀表板')
          setLoading(false)
          return
        }

        if (!isMounted) return

        setUserId(user.id)
        setUserEmail(user.email || null)

        const { data: membership, error: membershipError } = await supabase
          .from('org_members')
          .select('org_id, role, is_active')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle<OrgMember>()

        if (membershipError) throw membershipError
        if (!membership?.org_id) {
          setError('您尚未加入任何組織，請聯繫管理員。')
          setLoading(false)
          return
        }

        setOrgId(membership.org_id)
        setRole(membership.role)

        await loadDashboardData(membership.org_id, membership.role, user.id)
      } catch (err: any) {
        setError(err?.message || '載入失敗，請稍後再試')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    initialize()
    return () => { isMounted = false }
  }, [])

  // ========== 手動重新整理 ==========
  async function handleRefresh() {
    if (!orgId || !userId) return
    setRefreshing(true)
    try {
      await loadDashboardData(orgId, role, userId)
    } catch (err: any) {
      setError(err?.message || '重新整理失敗')
    } finally {
      setRefreshing(false)
    }
  }

  // ========== 快速更新狀態 ==========
  async function handleQuickStatusUpdate(task: TaskRow, newStatus: TaskStatus) {
    if (!orgId || !userId) return
    setUpdatingTaskId(task.id)
    setError(null)

    try {
      let query = supabase
        .from('project_tasks')
        .update({ status: newStatus })
        .eq('id', task.id)
        .eq('org_id', orgId)
        .select('id')
        .limit(1)

      if (!isSupervisor) {
        query = query.eq('assignee_user_id', userId)
      }

      const { data, error } = await query
      if (error) {
        if (isPermissionError(error)) {
          throw new Error('無法更新狀態，請確認更新權限。')
        }
        throw error
      }
      if (!data || data.length === 0) {
        throw new Error('更新失敗，可能無權限修改此任務。')
      }

      await handleRefresh()
    } catch (err: any) {
      setError(err?.message || '更新狀態時發生錯誤')
    } finally {
      setUpdatingTaskId(null)
    }
  }

  // ========== 衍生資料：KPI ==========
  const todayUTC = useMemo(() => startOfTodayUTC(), [])
  const todayKey = useMemo(() => toUTCDateKey(todayUTC), [todayUTC])
  const weekEndKey = useMemo(() => toUTCDateKey(addDaysUTC(todayUTC, 7)), [todayUTC])

  const kpi = useMemo(() => {
    const list = tasks
    let open = 0
    let inProgress = 0
    let completed = 0
    let overdue = 0
    let dueToday = 0
    let dueThisWeek = 0
    let completedToday = 0

    const hasEF = !!hasExpectedFinish

    list.forEach(t => {
      if (t.status !== 'done') open++
      if (t.status === 'in_progress') inProgress++
      if (t.status === 'done') completed++

      // 今日完成（以 created_at 粗略估算，可改用 completed_at 更準確）
      if (t.status === 'done' && formatISODate(t.created_at) === todayKey) completedToday++

      if (hasEF && t.status !== 'done') {
        const ef = formatISODate((t as any).expected_finish_at)
        if (ef !== '—') {
          if (ef < todayKey) overdue++
          if (ef === todayKey) dueToday++
          if (ef > todayKey && ef <= weekEndKey) dueThisWeek++
        }
      }
    })

    return {
      open,
      inProgress,
      completed,
      overdue,
      dueToday,
      dueThisWeek,
      completedToday,
      hasEF,
    }
  }, [tasks, hasExpectedFinish, todayKey, weekEndKey])

  // ========== 行動清單 ==========
  const actionLists = useMemo(() => {
    const list = tasks
    const hasEF = !!hasExpectedFinish

    const sortByEarliestEF = (a: TaskRow, b: TaskRow) => {
      const ea = formatISODate((a as any).expected_finish_at)
      const eb = formatISODate((b as any).expected_finish_at)
      if (ea === '—' && eb === '—') return 0
      if (ea === '—') return 1
      if (eb === '—') return -1
      return ea.localeCompare(eb)
    }

    const overdue = hasEF
      ? list
          .filter(t => t.status !== 'done' && formatISODate((t as any).expected_finish_at) !== '—' && formatISODate((t as any).expected_finish_at) < todayKey)
          .sort(sortByEarliestEF)
          .slice(0, 8)
      : []

    const dueToday = hasEF
      ? list
          .filter(t => t.status !== 'done' && formatISODate((t as any).expected_finish_at) === todayKey)
          .sort(sortByEarliestEF)
          .slice(0, 8)
      : []

    const dueThisWeek = hasEF
      ? list
          .filter(t => {
            const ef = formatISODate((t as any).expected_finish_at)
            return t.status !== 'done' && ef !== '—' && ef > todayKey && ef <= weekEndKey
          })
          .sort(sortByEarliestEF)
          .slice(0, 8)
      : []

    const inProgress = list.filter(t => t.status === 'in_progress').slice(0, 8)

    return { overdue, dueToday, dueThisWeek, inProgress }
  }, [tasks, hasExpectedFinish, todayKey, weekEndKey])

  // ========== 團隊負載（主管用） ==========
  const teamLoad = useMemo(() => {
    if (!isSupervisor) return []

    const hasEF = !!hasExpectedFinish
    const workloadMap = new Map<string, { userId: string; open: number; overdue: number; inProgress: number }>()

    tasks.forEach(t => {
      const uid = t.assignee_user_id || 'unassigned'
      const current = workloadMap.get(uid) || { userId: uid, open: 0, overdue: 0, inProgress: 0 }

      if (t.status !== 'done') current.open++
      if (t.status === 'in_progress') current.inProgress++

      if (hasEF && t.status !== 'done') {
        const ef = formatISODate((t as any).expected_finish_at)
        if (ef !== '—' && ef < todayKey) current.overdue++
      }

      workloadMap.set(uid, current)
    })

    return Array.from(workloadMap.values())
      .sort((a, b) => b.overdue - a.overdue || b.inProgress - a.inProgress || b.open - a.open)
      .slice(0, 8)
  }, [isSupervisor, tasks, hasExpectedFinish, todayKey])

  // ========== 渲染 ==========
  return (
    <div className="space-y-8 p-6 lg:p-8">
      {/* 頁首 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">工作儀表板</h1>
          <p className="mt-1 text-sm text-gray-500">
            {userEmail ? (
              <>

                {loadingProjects && <span className="ml-2 text-xs text-gray-400">更新專案名稱…</span>}
              </>
            ) : (
              '載入使用者資訊…'
            )}
          </p>
          {hasExpectedFinish === false && (
            <p className="mt-2 text-xs text-amber-600">
              ⚠️ 未偵測到「預估完成時間」欄位，到期相關功能已隱藏
            </p>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleRefresh}
            disabled={loading || refreshing}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 disabled:opacity-50"
          >
            {refreshing ? '更新中…' : '重新整理'}
          </button>
          <Link
            href="/app/issues"
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2"
          >
            所有任務
          </Link>
        </div>
      </div>

      {/* 錯誤提示 */}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <p className="font-medium">無法更新儀表板</p>
          <p className="mt-1">{error}</p>
        </div>
      )}

      {/* 載入中 */}
      {loading && (
        <div className="flex h-40 items-center justify-center rounded-lg border border-gray-200 bg-white">
          <p className="text-sm text-gray-500">載入儀表板資料…</p>
        </div>
      )}

      {!loading && (
        <>
          {/* KPI 卡片區 */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium">即時總覽</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
              <KpiCard
                label="逾期任務"
                value={kpi.overdue}
                intent="critical"
                href="/app/issues"
              />
              <KpiCard
                label="今日到期"
                value={kpi.dueToday}
                intent="warning"
                href="/app/issues"
              />
              <KpiCard
                label="本週到期"
                value={kpi.dueThisWeek}
                intent="neutral"
                href="/app/issues"
              />
              <KpiCard
                label="進行中"
                value={kpi.inProgress}
                intent="neutral"
                href="/app/issues"
              />
              <KpiCard
                label="今日完成"
                value={kpi.completedToday}
                intent="positive"
                href="/app/issues"
              />
              <KpiCard
                label="未完成總數"
                value={kpi.open}
                intent="neutral"
                href="/app/issues"
              />
            </div>
          </section>

          {/* 行動清單 - 雙欄 */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ActionTaskList
              title="🔥 逾期優先"
              description="已超過預估完成日期，建議立即處理"
              items={actionLists.overdue}
              projectNameFn={getProjectName}
              userNameFn={getUserDisplayName}
              onStatusChange={handleQuickStatusUpdate}
              updatingId={updatingTaskId}
              emptyMessage="目前沒有逾期任務"
            />
            <ActionTaskList
              title="⏰ 今日到期"
              description="今天需完成的任務"
              items={actionLists.dueToday}
              projectNameFn={getProjectName}
              userNameFn={getUserDisplayName}
              onStatusChange={handleQuickStatusUpdate}
              updatingId={updatingTaskId}
              emptyMessage="今日沒有到期待辦"
            />
            <ActionTaskList
              title="📅 本週到期"
              description="未來7天內即將到期"
              items={actionLists.dueThisWeek}
              projectNameFn={getProjectName}
              userNameFn={getUserDisplayName}
              onStatusChange={handleQuickStatusUpdate}
              updatingId={updatingTaskId}
              emptyMessage="本週沒有其他到期任務"
            />
            <ActionTaskList
              title="⚙️ 進行中"
              description="目前正在處理的工作"
              items={actionLists.inProgress}
              projectNameFn={getProjectName}
              userNameFn={getUserDisplayName}
              onStatusChange={handleQuickStatusUpdate}
              updatingId={updatingTaskId}
              emptyMessage="沒有進行中的任務"
            />
          </div>

          {/* 團隊負載（主管專區） */}
          {isSupervisor && (
            <section className="space-y-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-medium">團隊負載</h2>
                <span className="text-xs text-gray-500">依成員聚合 Open / WIP / Overdue</span>
              </div>
              {teamLoad.length === 0 ? (
                <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
                  尚無團隊成員任務資料
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {teamLoad.map(w => (
                    <div key={w.userId} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900">
                          {w.userId === 'unassigned' ? '未指派' : getUserDisplayName(w.userId)}
                        </span>
                        <Link href="/app/issues" className="text-xs text-gray-500 hover:underline">
                          檢視
                        </Link>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                        <div>
                          <div className="font-semibold text-gray-700">{w.open}</div>
                          <div className="text-gray-500">待處理</div>
                        </div>
                        <div>
                          <div className="font-semibold text-sky-600">{w.inProgress}</div>
                          <div className="text-gray-500">進行中</div>
                        </div>
                        <div>
                          <div className="font-semibold text-rose-600">{w.overdue}</div>
                          <div className="text-gray-500">逾期</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

// ========== 子元件 ==========

/** KPI 卡片 */
function KpiCard({ label, value, intent, href }: { label: string; value: number; intent: 'critical' | 'warning' | 'positive' | 'neutral'; href: string }) {
  return (
    <div className="relative rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">{label}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', getPillColor(intent))}>
          {intent === 'critical' ? '急' : intent === 'warning' ? '注意' : '一般'}
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-gray-900">{value}</p>
      <Link href={href} className="mt-3 inline-block text-xs text-gray-500 hover:text-gray-900 hover:underline">
        查看詳情 →
      </Link>
    </div>
  )
}

/** 行動任務列表 */
function ActionTaskList({
  title,
  description,
  items,
  projectNameFn,
  userNameFn,
  onStatusChange,
  updatingId,
  emptyMessage,
}: {
  title: string
  description: string
  items: TaskRow[]
  projectNameFn: (projectId: string) => string
  userNameFn: (userId: string | null) => string
  onStatusChange: (task: TaskRow, newStatus: TaskStatus) => Promise<void>
  updatingId: string | null
  emptyMessage: string
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="font-medium text-gray-900">{title}</h3>
        <p className="mt-1 text-xs text-gray-500">{description}</p>
        <p className="mt-4 text-sm text-gray-400">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="font-medium text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        <span className="text-xs text-gray-400">{items.length} 項</span>
      </div>

      <div className="space-y-3">
        {items.map(task => {
          const isUpdating = updatingId === task.id
          return (
            <div key={task.id} className="group rounded-md border border-gray-100 bg-gray-50/50 p-3 transition-colors hover:bg-gray-50">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', taskStatusBadgeColor(task.status))}>
                      {taskStatusLabel(task.status)}
                    </span>
                    <span className="truncate text-xs text-gray-600">
                      專案：{projectNameFn(task.project_id)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-800 line-clamp-2">{task.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span>👤 {userNameFn(task.assignee_user_id)}</span>
                    <span>📅 建立 {formatISODate(task.created_at)}</span>
                    {(task as any).expected_finish_at && (
                      <span>⏳ 預計 {formatISODate((task as any).expected_finish_at)}</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <select
                    value={task.status}
                    onChange={e => onStatusChange(task, e.target.value as TaskStatus)}
                    disabled={isUpdating}
                    className="w-28 rounded-md border-gray-200 bg-white py-1.5 text-xs shadow-sm focus:border-gray-400 focus:ring-gray-400 disabled:opacity-50"
                  >
                    <option value="todo">待處理</option>
                    <option value="in_progress">進行中</option>
                    <option value="done">已完成</option>
                  </select>
                  <div className="flex gap-2 text-xs">
                    <Link href={`/app/issues/${task.id}`} className="text-gray-400 hover:text-gray-700 hover:underline">
                      詳細
                    </Link>
                    <Link href={`/app/projects/${task.project_id}`} className="text-gray-400 hover:text-gray-700 hover:underline">
                      專案
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
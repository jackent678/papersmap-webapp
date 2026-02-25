'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import PageHeader from '../_components/PageHeader'
import { supabase } from '../../../lib/supabaseClient'
import { format, startOfWeek, endOfWeek, eachDayOfInterval, isSameDay } from 'date-fns'
import { zhTW } from 'date-fns/locale'

type DailyLog = {
  id: string
  org_id: string
  user_id: string
  log_date: string
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  notes: string | null
  created_at: string
  updated_at: string
}

type DailyItem = {
  id: string
  daily_log_id: string
  description: string
  status: 'todo' | 'done'
  priority: 'p1' | 'p2' | 'p3' | 'p4'
  estimated_hours: number | null
  actual_hours: number | null
  notes: string | null
  created_at: string
}

type Approval = {
  id: string
  org_id: string
  target_type: string
  target_id: string
  requester_user_id: string
  approver_user_id: string | null
  status: 'pending' | 'approved' | 'rejected'
  comments: string | null
  created_at: string
  updated_at: string
}

type OrgUser = {
  user_id: string
  full_name: string
  role: string
}

type ViewMode = 'day' | 'week' | 'month'

function badgeClass(kind: 'ok' | 'warn' | 'danger' | 'muted') {
  if (kind === 'ok') return 'bg-green-100 text-green-700'
  if (kind === 'warn') return 'bg-yellow-100 text-yellow-700'
  if (kind === 'danger') return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-600'
}

function dailyStatusBadge(dailyLog: DailyLog | null) {
  if (!dailyLog) {
    return <span className={`text-xs px-2 py-0.5 rounded ${badgeClass('muted')}`}>未建立</span>
  }
  if (dailyLog.status === 'approved') return <span className={`text-xs px-2 py-0.5 rounded ${badgeClass('ok')}`}>已核准</span>
  if (dailyLog.status === 'pending') return <span className={`text-xs px-2 py-0.5 rounded ${badgeClass('warn')}`}>審核中</span>
  if (dailyLog.status === 'rejected') return <span className={`text-xs px-2 py-0.5 rounded ${badgeClass('danger')}`}>已退回</span>
  return <span className={`text-xs px-2 py-0.5 rounded ${badgeClass('muted')}`}>草稿</span>
}

export default function PlansPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [userRole, setUserRole] = useState<string>('member')
  const isSupervisor = userRole === 'admin' || userRole === 'manager'

  const [selectedDate, setSelectedDate] = useState(new Date())
  const [viewMode, setViewMode] = useState<ViewMode>('day')

  const [dailyLog, setDailyLog] = useState<DailyLog | null>(null)
  const [dailyItems, setDailyItems] = useState<DailyItem[]>([])
  const [approval, setApproval] = useState<Approval | null>(null)

  const [isEditing, setIsEditing] = useState(false)
  const [editedNotes, setEditedNotes] = useState('')
  const [editedItems, setEditedItems] = useState<DailyItem[]>([])

  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [weekLogs, setWeekLogs] = useState<Record<string, DailyLog>>({})

  // ====== init ======
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      setError(null)

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (!user) throw new Error('請先登入')
        setUserId(user.id)

        const { data: member, error: memberError } = await supabase
          .from('org_members')
          .select('org_id, role')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single()

        if (memberError) throw memberError
        setOrgId(member.org_id)
        setUserRole(member.role)

        if (member.role === 'admin' || member.role === 'manager') {
          const { data: users } = await supabase
            .from('v_org_users')
            .select('user_id, full_name, role')
            .eq('org_id', member.org_id)

          if (users) setOrgUsers(users)
        }

        if (!cancelled) {
          await loadDailyLog(selectedDate, member.org_id, user.id)
          if (member.role === 'admin' || member.role === 'manager') {
            await loadWeekData(member.org_id, user.id)
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? '初始化失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (orgId && userId) {
      loadDailyLog(selectedDate, orgId, userId)
      if (isSupervisor) loadWeekData(orgId, userId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, orgId, userId, isSupervisor])

  async function loadDailyLog(date: Date, orgIdParam: string, userIdParam: string) {
    const dateStr = format(date, 'yyyy-MM-dd')

    try {
      const { data: log, error: logError } = await supabase
        .from('daily_logs')
        .select('*')
        .eq('org_id', orgIdParam)
        .eq('user_id', userIdParam)
        .eq('log_date', dateStr)
        .maybeSingle()

      if (logError && logError.code !== 'PGRST116') throw logError

      setDailyLog((log as DailyLog) ?? null)

      if (log) {
        const { data: items, error: itemsErr } = await supabase
          .from('daily_items')
          .select('*')
          .eq('daily_log_id', (log as any).id)
          .order('priority', { ascending: true })
        if (itemsErr) throw itemsErr

        // ✅ 因為完成後會搬移刪除，所以這裡只會拿到未完成
        setDailyItems(((items as any) ?? []) as DailyItem[])

        const { data: approvalData } = await supabase
          .from('approvals')
          .select('*')
          .eq('target_type', 'daily_log')
          .eq('target_id', (log as any).id)
          .maybeSingle()

        setApproval((approvalData as Approval) ?? null)
      } else {
        setDailyItems([])
        setApproval(null)
      }
    } catch (e: any) {
      setError(e?.message ?? '載入日誌失敗')
    }
  }

  async function loadWeekData(orgIdParam: string, userIdParam: string) {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 })
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 })
    const days = eachDayOfInterval({ start: weekStart, end: weekEnd })

    const logs: Record<string, DailyLog> = {}
    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd')
      const { data } = await supabase
        .from('daily_logs')
        .select('*')
        .eq('org_id', orgIdParam)
        .eq('user_id', userIdParam)
        .eq('log_date', dateStr)
        .maybeSingle()
      if (data) logs[dateStr] = data as DailyLog
    }

    setWeekLogs(logs)
  }

  function startEditing() {
    setError(null)
    setSuccess(null)
    setIsEditing(true)
    setEditedNotes(dailyLog?.notes || '')
    setEditedItems(dailyItems.map((item) => ({ ...item })))
  }

  function cancelEditing() {
    setIsEditing(false)
    setEditedNotes('')
    setEditedItems([])
  }

  function addItem() {
    const newItem: DailyItem = {
      id: `temp_${Date.now()}_${Math.random()}`,
      daily_log_id: dailyLog?.id || '',
      description: '',
      status: 'todo',
      priority: 'p3',
      estimated_hours: null,
      actual_hours: null,
      notes: null,
      created_at: new Date().toISOString(),
    }
    setEditedItems((prev) => [...prev, newItem])
  }

  function updateItem(id: string, updates: Partial<DailyItem>) {
    setEditedItems((items) => items.map((item) => (item.id === id ? { ...item, ...updates } : item)))
  }

  function removeItem(id: string) {
    setEditedItems((items) => items.filter((item) => item.id !== id))
  }

  async function handleSaveDailyLog() {
    if (!orgId || !userId) return

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd')

      if (dailyLog) {
        const { error: updateError } = await supabase
          .from('daily_logs')
          .update({
            notes: editedNotes,
            updated_at: new Date().toISOString(),
          })
          .eq('id', dailyLog.id)

        if (updateError) throw updateError

        for (const item of editedItems) {
          if (item.id.startsWith('temp_')) {
            const { error: insertError } = await supabase.from('daily_items').insert({
              daily_log_id: dailyLog.id,
              description: item.description,
              status: item.status,
              priority: item.priority,
              estimated_hours: item.estimated_hours,
              notes: item.notes,
            })
            if (insertError) throw insertError
          } else {
            const { error: updError } = await supabase
              .from('daily_items')
              .update({
                description: item.description,
                status: item.status,
                priority: item.priority,
                estimated_hours: item.estimated_hours,
                actual_hours: item.actual_hours,
                notes: item.notes,
              })
              .eq('id', item.id)
            if (updError) throw updError
          }
        }

        const originalIds = dailyItems.map((i) => i.id)
        const newIds = editedItems.map((i) => i.id).filter((id) => !id.startsWith('temp_'))
        const toDelete = originalIds.filter((id) => !newIds.includes(id))

        if (toDelete.length > 0) {
          const { error: delErr } = await supabase.from('daily_items').delete().in('id', toDelete)
          if (delErr) throw delErr
        }
      } else {
        const { data: newLog, error: insertError } = await supabase
          .from('daily_logs')
          .insert({
            org_id: orgId,
            user_id: userId,
            log_date: dateStr,
            notes: editedNotes,
            status: 'draft',
          })
          .select()
          .single()

        if (insertError) throw insertError

        const itemsToInsert = editedItems
          .filter((x) => x.description?.trim())
          .map((item) => ({
            daily_log_id: newLog.id,
            description: item.description,
            status: item.status,
            priority: item.priority,
            estimated_hours: item.estimated_hours,
            notes: item.notes,
          }))

        if (itemsToInsert.length > 0) {
          const { error: itemsError } = await supabase.from('daily_items').insert(itemsToInsert)
          if (itemsError) throw itemsError
        }

        setDailyLog(newLog as any)
      }

      await loadDailyLog(selectedDate, orgId, userId)
      setIsEditing(false)
      setSuccess('日誌已儲存')
    } catch (e: any) {
      setError(e?.message ?? '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  async function handleSubmitForApproval() {
    if (!dailyLog || !orgId || !userId) return
    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const { error: updateError } = await supabase
        .from('daily_logs')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', dailyLog.id)
      if (updateError) throw updateError

      const { data: existing } = await supabase
        .from('approvals')
        .select('id,status')
        .eq('org_id', orgId)
        .eq('target_type', 'daily_log')
        .eq('target_id', dailyLog.id)
        .maybeSingle()

      if (!existing) {
        const { error: approvalError } = await supabase.from('approvals').insert({
          org_id: orgId,
          target_type: 'daily_log',
          target_id: dailyLog.id,
          requester_user_id: userId,
          status: 'pending',
        })
        if (approvalError) throw approvalError
      }

      await loadDailyLog(selectedDate, orgId, userId)
      setSuccess('已送交主管審核')
    } catch (e: any) {
      setError(e?.message ?? '送審失敗')
    } finally {
      setSaving(false)
    }
  }

  async function handleApproval(approved: boolean, comments?: string) {
    if (!dailyLog || !approval || !userId || !orgId) return

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const newStatus = approved ? 'approved' : 'rejected'

      const { error: approvalError } = await supabase
        .from('approvals')
        .update({
          status: newStatus,
          approver_user_id: userId,
          comments: comments || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', approval.id)
      if (approvalError) throw approvalError

      const { error: logError } = await supabase
        .from('daily_logs')
        .update({
          status: newStatus as any,
          updated_at: new Date().toISOString(),
        })
        .eq('id', dailyLog.id)
      if (logError) throw logError

      await loadDailyLog(selectedDate, orgId, userId)
      setSuccess(approved ? '已核准' : '已退回')
    } catch (e: any) {
      setError(e?.message ?? '審核失敗')
    } finally {
      setSaving(false)
    }
  }

  function changeDate(delta: number) {
    const newDate = new Date(selectedDate)
    newDate.setDate(newDate.getDate() + delta)
    setSelectedDate(newDate)
    setIsEditing(false)
  }

  // ✅ 核准後：完成=搬移到履歷（從 daily_items 移除）
  async function archiveToHistory(item: DailyItem) {
    if (!dailyLog || dailyLog.status !== 'approved') return
    setError(null)
    setSuccess(null)

    try {
      const { error } = await supabase.rpc('archive_daily_item_to_history', { p_daily_item_id: item.id })
      if (error) throw error

      setDailyItems((xs) => xs.filter((x) => x.id !== item.id))
      setSuccess('已完成並移至「完成履歷」')
    } catch (e: any) {
      setError(e?.message ?? '移至完成履歷失敗')
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="每日 / 週計畫" description="載入中..." />
        <div className="rounded border bg-white p-8 text-center text-gray-500">載入中...</div>
      </div>
    )
  }

  const canEdit = !dailyLog || dailyLog.status === 'draft' || dailyLog.status === 'rejected'
  const canSubmit = !!dailyLog && dailyLog.status === 'draft' && dailyItems.length > 0

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="每日 / 週計畫"
          description={isSupervisor ? '檢視團隊成員的工作計畫並進行審核' : '建立每日工作計畫，送交主管審核'}
        />

        {/* ✅ 新增：完成履歷入口（你可以之後做 /app/history 頁） */}
        <div className="shrink-0">
          <Link className="rounded border px-3 py-2 text-sm hover:bg-gray-50 inline-block" href="/app/history">
            查看完成履歷
          </Link>
        </div>
      </div>

      {error && <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-700">{success}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* 左側 */}
        <div className="lg:col-span-1">
          <div className="rounded border bg-white p-4 space-y-4">
            <div className="flex gap-2">
              {(['day', 'week', 'month'] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex-1 rounded px-3 py-1.5 text-xs ${viewMode === mode ? 'bg-black text-white' : 'border hover:bg-gray-50'}`}
                >
                  {mode === 'day' && '日'}
                  {mode === 'week' && '週'}
                  {mode === 'month' && '月'}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <button onClick={() => changeDate(-1)} className="p-2 hover:bg-gray-100 rounded">
                  ←
                </button>
                <span className="text-sm font-medium">{format(selectedDate, 'yyyy年MM月dd日', { locale: zhTW })}</span>
                <button onClick={() => changeDate(1)} className="p-2 hover:bg-gray-100 rounded">
                  →
                </button>
              </div>
              <button onClick={() => setSelectedDate(new Date())} className="w-full rounded border px-3 py-2 text-sm hover:bg-gray-50">
                今天
              </button>
            </div>

            {viewMode === 'week' && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500">本週進度</div>
                {eachDayOfInterval({
                  start: startOfWeek(selectedDate, { weekStartsOn: 1 }),
                  end: endOfWeek(selectedDate, { weekStartsOn: 1 }),
                }).map((day: Date) => {
                  const dateStr = format(day, 'yyyy-MM-dd')
                  const log = weekLogs[dateStr]
                  return (
                    <button
                      key={dateStr}
                      onClick={() => setSelectedDate(day)}
                      className={`w-full flex items-center justify-between p-2 rounded text-sm ${
                        isSameDay(day, selectedDate) ? 'bg-black text-white' : 'hover:bg-gray-50'
                      }`}
                    >
                      <span>{format(day, 'MM/dd EEE', { locale: zhTW })}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${badgeClass(
                          !log
                            ? 'muted'
                            : log.status === 'approved'
                              ? 'ok'
                              : log.status === 'pending'
                                ? 'warn'
                                : log.status === 'rejected'
                                  ? 'danger'
                                  : 'muted'
                        )}`}
                      >
                        {!log && '未填寫'}
                        {log?.status === 'draft' && '草稿'}
                        {log?.status === 'pending' && '審核中'}
                        {log?.status === 'approved' && '已核准'}
                        {log?.status === 'rejected' && '已退回'}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右側 */}
        <div className="lg:col-span-3">
          <div className="rounded border bg-white p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-medium">{format(selectedDate, 'yyyy年MM月dd日', { locale: zhTW })} 工作計畫</h2>
                <div className="flex items-center gap-2 mt-1">{dailyStatusBadge(dailyLog)}</div>
              </div>

              <div className="flex gap-2">
                {!isEditing && canEdit && (
                  <button onClick={startEditing} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
                    {dailyLog ? '編輯' : '建立 / 開始填寫'}
                  </button>
                )}

                {isEditing && (
                  <>
                    <button onClick={cancelEditing} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
                      取消
                    </button>
                    <button
                      onClick={handleSaveDailyLog}
                      disabled={saving}
                      className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
                    >
                      {saving ? '儲存中...' : '儲存'}
                    </button>
                  </>
                )}

                {!isEditing && canSubmit && (
                  <button
                    onClick={handleSubmitForApproval}
                    disabled={saving}
                    className="rounded bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    送交審核
                  </button>
                )}
              </div>
            </div>

            {/* 工作項目 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">工作項目</h3>
                {isEditing && (
                  <button onClick={addItem} className="rounded bg-black text-white px-3 py-1.5 text-sm">
                    ＋ 新增項目
                  </button>
                )}
              </div>

              {(!isEditing ? dailyItems : editedItems).length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500 border rounded">
                  {dailyLog ? '尚無待完成項目（完成的已移到完成履歷）' : '尚未建立本日計畫（點右上角「建立 / 開始填寫」）'}
                </div>
              ) : (
                <div className="space-y-3">
                  {(!isEditing ? dailyItems : editedItems).map((item, index) => (
                    <div key={item.id} className="border rounded p-4 space-y-3">
                      {isEditing ? (
                        <>
                          <div className="flex gap-3">
                            <input
                              type="text"
                              className="flex-1 rounded border px-3 py-2 text-sm"
                              placeholder="工作說明"
                              value={item.description}
                              onChange={(e) => updateItem(item.id, { description: e.target.value })}
                            />
                            <select
                              className="w-24 rounded border px-3 py-2 text-sm"
                              value={item.priority}
                              onChange={(e) => updateItem(item.id, { priority: e.target.value as any })}
                            >
                              <option value="p1">P1</option>
                              <option value="p2">P2</option>
                              <option value="p3">P3</option>
                              <option value="p4">P4</option>
                            </select>
                            <button onClick={() => removeItem(item.id)} className="text-red-600 px-3 py-2 text-sm hover:bg-red-50 rounded">
                              刪除
                            </button>
                          </div>
                          <div className="flex gap-3">
                            <input
                              type="number"
                              className="w-32 rounded border px-3 py-2 text-sm"
                              placeholder="預估時數"
                              value={item.estimated_hours ?? ''}
                              onChange={(e) =>
                                updateItem(item.id, {
                                  estimated_hours: e.target.value ? parseFloat(e.target.value) : null,
                                })
                              }
                            />
                            <input
                              type="text"
                              className="flex-1 rounded border px-3 py-2 text-sm"
                              placeholder="備註"
                              value={item.notes ?? ''}
                              onChange={(e) => updateItem(item.id, { notes: e.target.value })}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="flex items-start gap-3">
                          <span className="text-sm font-medium text-gray-500 w-8">{index + 1}.</span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{item.description}</span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded ${
                                  item.priority === 'p1'
                                    ? 'bg-red-100 text-red-700'
                                    : item.priority === 'p2'
                                      ? 'bg-orange-100 text-orange-700'
                                      : item.priority === 'p3'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-700'
                                }`}
                              >
                                {item.priority}
                              </span>
                            </div>
                            {(item.estimated_hours || item.notes) && (
                              <div className="mt-1 text-xs text-gray-500">
                                {item.estimated_hours ? `預估 ${item.estimated_hours} 小時` : ''}
                                {item.estimated_hours && item.notes ? ' · ' : ''}
                                {item.notes ?? ''}
                              </div>
                            )}
                          </div>

                          {/* ✅ 核准後才可「完成並移至履歷」 */}
                          {dailyLog?.status === 'approved' && (
                            <button
                              className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
                              onClick={() => archiveToHistory(item)}
                              title="完成後會移至完成履歷"
                            >
                              完成
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 備註 */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">備註</h3>
              {isEditing ? (
                <textarea
                  className="w-full rounded border px-3 py-2 text-sm min-h-[100px]"
                  placeholder="填寫備註、反思、遇到的問題..."
                  value={editedNotes}
                  onChange={(e) => setEditedNotes(e.target.value)}
                />
              ) : (
                <div className="text-sm text-gray-700 min-h-[60px] bg-gray-50 rounded p-3">{dailyLog?.notes || '無備註'}</div>
              )}
            </div>

            {/* 審核區塊（主管用） */}
            {isSupervisor && approval?.status === 'pending' && (
              <div className="border-t pt-4 space-y-4">
                <h3 className="text-sm font-medium">審核</h3>
                <div className="space-y-3">
                  <textarea id="approval-comments" className="w-full rounded border px-3 py-2 text-sm" placeholder="審核意見（選填）" />
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const el = document.getElementById('approval-comments') as HTMLTextAreaElement
                        handleApproval(true, el?.value)
                      }}
                      disabled={saving}
                      className="rounded bg-green-600 text-white px-4 py-2 text-sm hover:bg-green-700 disabled:opacity-50"
                    >
                      核准
                    </button>
                    <button
                      onClick={() => {
                        const el = document.getElementById('approval-comments') as HTMLTextAreaElement
                        handleApproval(false, el?.value)
                      }}
                      disabled={saving}
                      className="rounded border border-red-200 text-red-700 px-4 py-2 text-sm hover:bg-red-50 disabled:opacity-50"
                    >
                      退回
                    </button>
                  </div>
                </div>
              </div>
            )}

            {!dailyLog && !isEditing ? (
              <div className="rounded bg-gray-50 p-3 text-sm text-gray-600">今天尚未建立計畫。請按右上角「建立 / 開始填寫」開始新增工作項目與備註。</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
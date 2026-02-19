'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Role = 'admin' | 'manager' | 'member'
type TaskStatus = 'todo' | 'in_progress' | 'done'

type OrgMember = { org_id: string; role: Role; is_active: boolean }
type OrgUserOption = { user_id: string; full_name: string }

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

type ProjectTask = {
  id: string
  project_id: string
  org_id: string | null
  description: string
  assignee_user_id: string | null
  status: TaskStatus
  created_at: string
  expected_finish_at?: string | null // ✅ 新增：預估完成時間
}

type TaskUpdate = {
  id: string
  org_id: string
  task_id: string
  author_user_id: string
  message: string
  new_status: TaskStatus | null
  created_at: string
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ')
}
function fmtDate(iso?: string | null) {
  if (!iso) return '-'
  return iso.slice(0, 10)
}
function shortId(id: string) {
  return id.slice(0, 8)
}
function taskStatusLabel(s: TaskStatus) {
  switch (s) {
    case 'todo':
      return '未處理'
    case 'in_progress':
      return '處理中'
    case 'done':
      return '已完成'
  }
}
function taskStatusChip(s: TaskStatus) {
  switch (s) {
    case 'done':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'in_progress':
      return 'bg-amber-50 text-amber-800 border-amber-200'
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}
function roleHint(r: Role) {
  return r === 'admin' || r === 'manager'
    ? '主管（可看全部任務/指派/改狀態）'
    : '一般成員（只看我的任務）'
}
function isPermissionError(e: any) {
  const msg = (e?.message ?? '').toLowerCase()
  return msg.includes('permission denied') || msg.includes('rls') || msg.includes('row-level security')
}

/** ✅ datetime-local <-> ISO helpers */
function toDatetimeLocalValue(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}
function fromDatetimeLocalValue(v: string) {
  if (!v) return null
  const d = new Date(v) // local time
  return d.toISOString()
}

/** ✅ 到期判斷：以 expected_finish_at 為準，且 status !== done */
function startOfLocalDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}
function endOfLocalDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}
function isDueToday(task: ProjectTask) {
  if (task.status === 'done') return false
  if (!task.expected_finish_at) return false
  const due = new Date(task.expected_finish_at)
  const now = new Date()
  return due >= startOfLocalDay(now) && due <= endOfLocalDay(now)
}
function isOverdue(task: ProjectTask) {
  if (task.status === 'done') return false
  if (!task.expected_finish_at) return false
  const due = new Date(task.expected_finish_at)
  const now = new Date()
  return due.getTime() < now.getTime()
}

export default function IssuesPage() {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('member')
  const isSupervisor = role === 'admin' || role === 'manager'

  const [orgUsers, setOrgUsers] = useState<OrgUserOption[]>([])
  const [tasks, setTasks] = useState<ProjectTask[]>([])

  // project cache（列表先批次抓，展開也可補抓）
  const [projectCache, setProjectCache] = useState<Record<string, ProjectRow | null | undefined>>({})
  const [projectLoadingId, setProjectLoadingId] = useState<string | null>(null)

  // expand
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [updatesByTask, setUpdatesByTask] = useState<Record<string, TaskUpdate[]>>({})
  const [updatesLoadingTaskId, setUpdatesLoadingTaskId] = useState<string | null>(null)

  // filters
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState<string>('all')

  // reply（新增）
  const [draftMsg, setDraftMsg] = useState<string>('')
  const [draftNextStatus, setDraftNextStatus] = useState<TaskStatus | ''>('')
  const [postingTaskId, setPostingTaskId] = useState<string | null>(null)

  // ✅ reply（編輯/刪除）
  const [editingUpdateId, setEditingUpdateId] = useState<string | null>(null)
  const [editMsg, setEditMsg] = useState<string>('')
  const [editNextStatus, setEditNextStatus] = useState<TaskStatus | ''>('')
  const [savingUpdateId, setSavingUpdateId] = useState<string | null>(null)
  const [deletingUpdateId, setDeletingUpdateId] = useState<string | null>(null)

  // create task (supervisor)
  const createDialogRef = useRef<HTMLDialogElement | null>(null)
  const [newProjectId, setNewProjectId] = useState<string>('')
  const [newDesc, setNewDesc] = useState<string>('')
  const [newAssignee, setNewAssignee] = useState<string>('')
  const [newExpectedFinishAt, setNewExpectedFinishAt] = useState<string>('') // ✅ 新增
  const [creatingTask, setCreatingTask] = useState(false)

  // ✅ 主管調整 expected_finish_at
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null)

  function userLabel(uid: string | null) {
    if (!uid) return '未指派'
    const hit = orgUsers.find((u) => u.user_id === uid)
    return hit?.full_name ?? uid.slice(0, 8)
  }

  // ✅ 紅圈要顯示「專案名稱」：這裡集中處理
  function projectLabel(projectId: string) {
    const p = projectCache[projectId]
    if (p && p !== undefined) return p.name ?? shortId(projectId)
    return shortId(projectId)
  }

  // ✅ 批次把列表內所有 project_id 的專案抓回來（讓 header 不會只顯示 shortId）
  async function preloadProjectsForTasks(_orgId: string, list: ProjectTask[]) {
    const ids = Array.from(new Set(list.map((t) => t.project_id))).filter(Boolean)
    if (ids.length === 0) return

    // 避免重複抓：只抓 cache 尚未有「確定值」的（undefined 代表尚未抓）
    const need = ids.filter((id) => !Object.prototype.hasOwnProperty.call(projectCache, id) || projectCache[id] === undefined)
    if (need.length === 0) return

    try {
      const { data, error: pErr } = await supabase
        .from('projects')
        .select('id, org_id, name, description, status, priority, target_due_date, created_at')
        .eq('org_id', _orgId)
        .in('id', need)

      if (pErr) {
        if (isPermissionError(pErr)) {
          setError('專案名稱讀取失敗：projects 的 SELECT 權限/RLS 未放行（列表要顯示名稱需可讀取）。')
        } else {
          setError(`專案名稱讀取失敗：${pErr.message}`)
        }
        // 仍把 need 標記成 null，避免無限重抓
        setProjectCache((m) => {
          const next = { ...m }
          for (const id of need) next[id] = null
          return next
        })
        return
      }

      const rows = (data ?? []) as ProjectRow[]
      const map: Record<string, ProjectRow> = {}
      for (const r of rows) map[r.id] = r

      setProjectCache((m) => {
        const next = { ...m }
        for (const id of need) next[id] = map[id] ?? null
        return next
      })
    } catch (e: any) {
      setError(e?.message ?? '批次讀取專案名稱失敗')
    }
  }

  async function ensureProject(projectId: string) {
    if (!orgId) return
    if (Object.prototype.hasOwnProperty.call(projectCache, projectId) && projectCache[projectId] !== undefined) return

    setProjectLoadingId(projectId)
    try {
      const { data, error: pErr } = await supabase
        .from('projects')
        .select('id, org_id, name, description, status, priority, target_due_date, created_at')
        .eq('id', projectId)
        .eq('org_id', orgId)
        .maybeSingle<ProjectRow>()

      if (pErr) {
        if (isPermissionError(pErr)) {
          setError('專案資訊讀取失敗：projects 的 SELECT 權限/RLS 未放行（一般成員也需要可讀取）。')
        } else {
          setError(`專案資訊讀取失敗：${pErr.message}`)
        }
        setProjectCache((m) => ({ ...m, [projectId]: null }))
        return
      }

      setProjectCache((m) => ({ ...m, [projectId]: (data ?? null) as any }))
    } finally {
      setProjectLoadingId(null)
    }
  }

  // ========= init =========
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      setError(null)

      try {
        const { data: userRes } = await supabase.auth.getUser()
        const user = userRes.user
        if (!user) {
          setError('尚未登入，請先登入後再操作。')
          setLoading(false)
          return
        }
        if (!cancelled) setUserId(user.id)

        const { data: mem, error: memErr } = await supabase
          .from('org_members')
          .select('org_id, role, is_active')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle<OrgMember>()

        if (memErr) throw memErr
        if (!mem?.org_id) {
          setError('找不到 org_id（請先建立 org_members，並確保 is_active=true）')
          setLoading(false)
          return
        }

        if (!cancelled) {
          setOrgId(mem.org_id)
          setRole(mem.role)
        }

        // users list（顯示姓名）
        const { data: us, error: usErr } = await supabase
          .from('v_org_users')
          .select('user_id, full_name')
          .eq('org_id', mem.org_id)
          .order('full_name', { ascending: true })

        if (!cancelled) {
          if (!usErr && Array.isArray(us)) {
            setOrgUsers(
              us.map((r: any) => ({
                user_id: r.user_id,
                full_name: r.full_name ?? r.user_id,
              }))
            )
          } else {
            setOrgUsers([{ user_id: user.id, full_name: user.email ?? user.id.slice(0, 8) }])
          }
        }

        await loadTasks(mem.org_id, mem.role, user.id)
      } catch (e: any) {
        setError(e?.message ?? '初始化失敗')
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

  async function loadTasks(_orgId: string, _role: Role, _userId: string) {
    let query = supabase
      .from('project_tasks')
      .select('id, project_id, org_id, description, assignee_user_id, status, created_at, expected_finish_at') // ✅ 加入 expected_finish_at
      .eq('org_id', _orgId)
      .order('created_at', { ascending: false })

    if (!(_role === 'admin' || _role === 'manager')) {
      query = query.eq('assignee_user_id', _userId)
    }

    const { data, error: tErr } = await query
    if (tErr) throw tErr
    const list = (data ?? []) as ProjectTask[]
    setTasks(list)

    // 先把 cache key 建起來（undefined=尚未抓）
    setProjectCache((m) => {
      const next = { ...m }
      for (const t of list) {
        if (!Object.prototype.hasOwnProperty.call(next, t.project_id)) next[t.project_id] = undefined
      }
      return next
    })

    // ✅ 列表用：批次預抓專案資料（讓紅圈顯示專案名稱）
    await preloadProjectsForTasks(_orgId, list)
  }

  async function refresh() {
    if (!orgId || !userId) return
    setRefreshing(true)
    setError(null)
    try {
      await loadTasks(orgId, role, userId)

      if (expandedTaskId) {
        await loadUpdates(expandedTaskId)
        const task = tasks.find((x) => x.id === expandedTaskId)
        if (task) await ensureProject(task.project_id)
      }
    } catch (e: any) {
      setError(e?.message ?? '重新整理失敗')
    } finally {
      setRefreshing(false)
    }
  }

  // ========= updates =========
  async function loadUpdates(taskId: string) {
    if (!orgId) return
    setUpdatesLoadingTaskId(taskId)
    setError(null)
    try {
      const { data, error: uErr } = await supabase
        .from('task_updates')
        .select('id, org_id, task_id, author_user_id, message, new_status, created_at')
        .eq('org_id', orgId)
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })

      if (uErr) throw uErr
      setUpdatesByTask((m) => ({ ...m, [taskId]: (data ?? []) as TaskUpdate[] }))
    } catch (e: any) {
      setError(e?.message ?? '讀取進度回覆失敗（請檢查 task_updates RLS）')
    } finally {
      setUpdatesLoadingTaskId(null)
    }
  }

  async function toggleExpand(task: ProjectTask) {
    setExpandedTaskId((cur) => (cur === task.id ? null : task.id))
    if (expandedTaskId !== task.id) {
      await ensureProject(task.project_id)
      await loadUpdates(task.id)
      setDraftMsg('')
      setDraftNextStatus('')

      // ✅ 收起編輯狀態
      setEditingUpdateId(null)
      setEditMsg('')
      setEditNextStatus('')
    }
  }

  function canReply(task: ProjectTask) {
    if (!userId) return false
    if (isSupervisor) return true
    return task.assignee_user_id === userId
  }

  function canManageUpdate(u: TaskUpdate) {
    if (!userId) return false
    if (isSupervisor) return true
    return u.author_user_id === userId
  }

  async function postUpdate(task: ProjectTask) {
    if (!orgId || !userId) return
    if (!canReply(task)) {
      setError('你只能回覆自己被指派的任務。')
      return
    }
    if (!draftMsg.trim()) return

    setPostingTaskId(task.id)
    setError(null)

    try {
      const { error: insErr } = await supabase.from('task_updates').insert({
        org_id: orgId,
        task_id: task.id,
        author_user_id: userId,
        message: draftMsg.trim(),
        new_status: draftNextStatus ? draftNextStatus : null,
      })
      if (insErr) throw insErr

      // 可選：同步任務狀態
      if (draftNextStatus) {
        let q2 = supabase.from('project_tasks').update({ status: draftNextStatus }).eq('id', task.id)
        if (!isSupervisor) q2 = q2.eq('assignee_user_id', userId)

        const { data: tData, error: tErr } = await q2.select('id').limit(1)
        if (tErr) throw tErr
        if (!tData || tData.length === 0) {
          setError('狀態更新失敗：沒有更新到任務（可能是 project_tasks 的 RLS 擋住）。')
          return
        }
      }

      setDraftMsg('')
      setDraftNextStatus('')
      await loadUpdates(task.id)
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '送出回覆失敗')
    } finally {
      setPostingTaskId(null)
    }
  }

  // ✅ 編輯回覆
  function startEditUpdate(u: TaskUpdate) {
    setError(null)
    setEditingUpdateId(u.id)
    setEditMsg(u.message ?? '')
    setEditNextStatus(u.new_status ?? '')
  }

  function cancelEditUpdate() {
    setEditingUpdateId(null)
    setEditMsg('')
    setEditNextStatus('')
  }

  async function saveUpdate(taskId: string, u: TaskUpdate) {
    if (!orgId || !userId) return
    if (!canManageUpdate(u)) {
      setError('你只能編輯自己撰寫的回覆。')
      return
    }
    if (!editMsg.trim()) return

    setSavingUpdateId(u.id)
    setError(null)

    try {
      let q1 = supabase
        .from('task_updates')
        .update({
          message: editMsg.trim(),
          new_status: editNextStatus ? editNextStatus : null,
        })
        .eq('id', u.id)
        .eq('org_id', orgId)
        .select('id')
        .limit(1)

      if (!isSupervisor) q1 = q1.eq('author_user_id', userId)

      const { data, error: updErr } = await q1
      if (updErr) throw updErr

      if (!data || data.length === 0) {
        setError('編輯失敗：沒有更新到任何資料（多半是 RLS/權限 policy 擋住，或條件不命中）。')
        return
      }

      // ✅ 可選：同步任務狀態
      if (editNextStatus) {
        let q2 = supabase.from('project_tasks').update({ status: editNextStatus }).eq('id', taskId)
        if (!isSupervisor) q2 = q2.eq('assignee_user_id', userId)

        const { data: tData, error: tErr } = await q2.select('id').limit(1)
        if (tErr) throw tErr
        if (!tData || tData.length === 0) {
          setError('狀態更新失敗：沒有更新到任務（可能是 project_tasks 的 RLS policy 擋住）。')
          return
        }
      }

      cancelEditUpdate()
      await loadUpdates(taskId)
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '編輯回覆失敗')
    } finally {
      setSavingUpdateId(null)
    }
  }

  async function deleteUpdate(taskId: string, u: TaskUpdate) {
    if (!orgId || !userId) return
    if (!canManageUpdate(u)) {
      setError('你只能刪除自己撰寫的回覆。')
      return
    }

    const ok = window.confirm('確定要刪除這則回覆嗎？刪除後無法復原。')
    if (!ok) return

    setDeletingUpdateId(u.id)
    setError(null)

    try {
      let q1 = supabase
        .from('task_updates')
        .delete()
        .eq('id', u.id)
        .eq('org_id', orgId)
        .select('id')
        .limit(1)

      if (!isSupervisor) q1 = q1.eq('author_user_id', userId)

      const { data, error: delErr } = await q1
      if (delErr) throw delErr

      if (!data || data.length === 0) {
        setError('刪除失敗：沒有刪到任何資料（多半是 RLS/權限 policy 擋住，或條件不命中）。')
        return
      }

      if (editingUpdateId === u.id) cancelEditUpdate()

      await loadUpdates(taskId)
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '刪除回覆失敗')
    } finally {
      setDeletingUpdateId(null)
    }
  }

  // supervisor controls
  async function supervisorSetAssignee(task: ProjectTask, nextAssignee: string | null) {
    if (!isSupervisor) return
    setUpdatingTaskId(task.id)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('project_tasks')
        .update({ assignee_user_id: nextAssignee })
        .eq('id', task.id)
        .select('id')
        .limit(1)
      if (error) throw error
      if (!data || data.length === 0) {
        setError('更新指派失敗：沒有更新到任務（可能是 project_tasks 的 RLS 擋住）。')
        return
      }
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '更新指派失敗')
    } finally {
      setUpdatingTaskId(null)
    }
  }

  async function supervisorSetStatus(task: ProjectTask, nextStatus: TaskStatus) {
    if (!isSupervisor) return
    setUpdatingTaskId(task.id)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('project_tasks')
        .update({ status: nextStatus })
        .eq('id', task.id)
        .select('id')
        .limit(1)
      if (error) throw error
      if (!data || data.length === 0) {
        setError('更新狀態失敗：沒有更新到任務（可能是 project_tasks 的 RLS 擋住）。')
        return
      }
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '更新狀態失敗')
    } finally {
      setUpdatingTaskId(null)
    }
  }

  // ✅ 主管調整預估完成時間
  async function supervisorSetExpectedFinishAt(task: ProjectTask, nextIso: string | null) {
    if (!isSupervisor) return
    setUpdatingTaskId(task.id)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('project_tasks')
        .update({ expected_finish_at: nextIso })
        .eq('id', task.id)
        .select('id')
        .limit(1)

      if (error) throw error
      if (!data || data.length === 0) {
        setError('更新預估完成時間失敗：沒有更新到任務（可能是 project_tasks 的 RLS 擋住）。')
        return
      }
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '更新預估完成時間失敗')
    } finally {
      setUpdatingTaskId(null)
    }
  }

  function openCreate() {
    if (!isSupervisor) return
    setError(null)
    setNewProjectId(projectFilter !== 'all' ? projectFilter : '')
    setNewDesc('')
    setNewAssignee('')
    setNewExpectedFinishAt('') // ✅
    createDialogRef.current?.showModal()
  }
  function closeCreate() {
    createDialogRef.current?.close()
  }
  async function createTask() {
    if (!isSupervisor) return
    if (!orgId) return
    if (!newProjectId) {
      setError('請先選擇專案')
      return
    }
    if (!newDesc.trim()) return

    setCreatingTask(true)
    setError(null)
    try {
      const { error } = await supabase.from('project_tasks').insert({
        org_id: orgId,
        project_id: newProjectId,
        description: newDesc.trim(),
        assignee_user_id: newAssignee ? newAssignee : null,
        status: 'todo',
        expected_finish_at: fromDatetimeLocalValue(newExpectedFinishAt), // ✅
      })
      if (error) throw error
      closeCreate()
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '新增任務失敗（請檢查 project_tasks RLS / 欄位）')
    } finally {
      setCreatingTask(false)
    }
  }

  const projectOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tasks) ids.add(t.project_id)

    const list: Array<ProjectRow & { id: string }> = []
    ids.forEach((id) => {
      const p = projectCache[id]
      if (p && p !== undefined) list.push(p as any)
      else
        list.push({
          id,
          name: shortId(id),
          description: null,
          status: null,
          priority: null,
          target_due_date: null,
          created_at: null,
        })
    })

    list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    return list
  }, [tasks, projectCache])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return tasks
      .filter((t) => (statusFilter === 'all' ? true : t.status === statusFilter))
      .filter((t) => (projectFilter === 'all' ? true : t.project_id === projectFilter))
      .filter((t) => {
        if (!kw) return true
        const pName = (projectCache[t.project_id]?.name ?? shortId(t.project_id)).toLowerCase()
        const who = userLabel(t.assignee_user_id).toLowerCase()
        const due = (t.expected_finish_at ? toDatetimeLocalValue(t.expected_finish_at).replace('T', ' ') : '-').toLowerCase()
        return t.description.toLowerCase().includes(kw) || pName.includes(kw) || who.includes(kw) || due.includes(kw)
      })
  }, [tasks, q, statusFilter, projectFilter, projectCache, orgUsers])

  return (
    <div className="space-y-6">
      {/* Title bar */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-2xl font-semibold">任務 </div>
          <div className="text-sm text-gray-600">
            {isSupervisor
              ? '主管：可指派任務、追蹤進度（專案資訊仍可查看）'
              : '成員：查看指派給我的任務並回覆進度（專案資訊仍可查看）'}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            onClick={refresh}
            disabled={loading || refreshing}
          >
            {refreshing ? '更新中…' : '重新整理'}
          </button>

          {isSupervisor ? (
            <button className="rounded bg-black text-white px-4 py-2 text-sm" onClick={openCreate}>
              ＋ 新增任務
            </button>
          ) : null}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded border bg-white p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 space-y-1">
            <div className="text-xs text-gray-500">搜尋（任務/專案/人員/到期）</div>
            <input className="w-full rounded border px-3 py-2 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="輸入關鍵字" />
          </div>

          <div className="md:col-span-3 space-y-1">
            <div className="text-xs text-gray-500">狀態</div>
            <select className="w-full rounded border px-3 py-2 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
              <option value="all">全部</option>
              <option value="todo">未處理</option>
              <option value="in_progress">處理中</option>
              <option value="done">已完成</option>
            </select>
          </div>

          <div className="md:col-span-3 space-y-1">
            <div className="text-xs text-gray-500">專案</div>
            <select className="w-full rounded border px-3 py-2 text-sm" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="all">全部專案</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? shortId(p.id)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-xs text-gray-500">權限：{roleHint(role)}</div>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="font-semibold">發生問題</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {/* Create dialog */}
      <dialog
        ref={createDialogRef}
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          'w-[min(720px,calc(100vw-2rem))] rounded-2xl p-0 bg-white shadow-xl border',
          'max-h-[90vh] overflow-hidden',
          'backdrop:bg-black/40'
        )}
      >
        <div className="border-b px-6 py-4">
          <div className="text-lg font-semibold">新增任務（主管）</div>
          <div className="text-xs text-gray-500 mt-1">選專案 → 填任務內容 → 指派人員（可選）→ 預估完成時間（可選）</div>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto max-h-[calc(90vh-140px)]">
          <div className="space-y-1">
            <div className="text-xs text-gray-500">專案（必選）</div>
            <select className="w-full rounded border px-3 py-2 text-sm" value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} disabled={creatingTask}>
              <option value="">請選擇專案</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? shortId(p.id)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-gray-500">任務內容（必填）</div>
            <textarea className="w-full rounded border px-3 py-2 text-sm min-h-[96px]" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} disabled={creatingTask} />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-gray-500">指派人員（可選）</div>
            <select className="w-full rounded border px-3 py-2 text-sm" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} disabled={creatingTask}>
              <option value="">未指派</option>
              {orgUsers.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>

          {/* ✅ 新增：預估完成時間 */}
          <div className="space-y-1">
            <div className="text-xs text-gray-500">預估完成時間（可選）</div>
            <input
              type="datetime-local"
              className="w-full rounded border px-3 py-2 text-sm"
              value={newExpectedFinishAt}
              onChange={(e) => setNewExpectedFinishAt(e.target.value)}
              disabled={creatingTask}
            />
            <div className="text-[11px] text-gray-500">此欄位用於「今日到期 / 逾期」判斷（status ≠ done）。</div>
          </div>
        </div>

        <div className="border-t px-6 py-4 flex justify-end gap-2">
          <button className="rounded border px-4 py-2 text-sm hover:bg-gray-50" onClick={closeCreate} disabled={creatingTask}>
            取消
          </button>
          <button
            className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
            onClick={createTask}
            disabled={creatingTask || !newProjectId || !newDesc.trim()}
          >
            {creatingTask ? '建立中…' : '建立'}
          </button>
        </div>
      </dialog>

      {/* tasks */}
      {loading ? (
        <div className="rounded border bg-white p-4 text-sm text-gray-600">載入中…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border bg-white p-6 text-sm text-gray-600">沒有符合條件的任務</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((t, idx) => {
            const expanded = expandedTaskId === t.id
            const can = canReply(t)
            const updates = updatesByTask[t.id] ?? []
            const uLoading = updatesLoadingTaskId === t.id
            const p = projectCache[t.project_id] ?? null
            const pLoading = projectLoadingId === t.project_id

            const dueToday = isDueToday(t)
            const overdue = isOverdue(t)

            return (
              <div key={t.id} className="rounded border bg-white overflow-hidden">
                {/* header row */}
                <button className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-start justify-between gap-3" onClick={() => toggleExpand(t)}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-medium">{idx + 1}</div>

                      <span className={cn('text-xs px-2 py-1 rounded border', taskStatusChip(t.status))}>{taskStatusLabel(t.status)}</span>

                      {/* ✅ 紅圈：專案名稱 */}
                      <span className="text-xs px-2 py-1 rounded border bg-white text-gray-800">專案：{projectLabel(t.project_id)}</span>

                      <span className="text-xs text-gray-600">指派：{t.description}</span>

                      <span className="text-xs text-gray-500">建立日 {fmtDate(t.created_at)}</span>

                      {/* ✅ 新增：到期狀態 */}
                      {t.expected_finish_at ? (
                        <span className="text-xs text-gray-600">
                          預估完成 {toDatetimeLocalValue(t.expected_finish_at).replace('T', ' ')}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">未設定預估完成</span>
                      )}

                      {dueToday ? <span className="text-xs px-2 py-1 rounded border bg-blue-50 text-blue-700 border-blue-200">今日到期</span> : null}
                      {overdue ? <span className="text-xs px-2 py-1 rounded border bg-red-50 text-red-700 border-red-200">逾期</span> : null}
                    </div>
                  </div>

                  <div className="shrink-0 text-xs text-gray-600">{expanded ? '收合 ▲' : '展開 ▼'}</div>
                </button>

                {expanded && (
                  <div className="border-t px-4 py-4 space-y-4">
                    {/* Project info */}
                    <div className="rounded border bg-white p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold">專案資訊</div>
                          {pLoading ? <div className="text-xs text-gray-500 mt-1">讀取專案資訊中…</div> : null}
                          {!pLoading && p === null ? <div className="text-xs text-red-600 mt-1">專案資訊無法讀取（可能是 RLS/權限未放行）</div> : null}
                        </div>

                        <Link
                          className={cn('rounded border px-4 py-2 text-sm hover:bg-gray-50', !p && 'opacity-50 pointer-events-none')}
                          href={`/app/projects/${t.project_id}`}
                        >
                          進入詳情
                        </Link>
                      </div>

                      <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
                        <div className="md:col-span-6 space-y-1">
                          <div className="text-xs text-gray-500">專案名稱</div>
                          <input className="w-full rounded border px-3 py-2 text-sm bg-gray-50" value={p?.name ?? shortId(t.project_id)} disabled />
                        </div>

                        <div className="md:col-span-3 space-y-1">
                          <div className="text-xs text-gray-500">優先級</div>
                          <input className="w-full rounded border px-3 py-2 text-sm bg-gray-50" value={p?.priority ?? '-'} disabled />
                        </div>

                        <div className="md:col-span-3 space-y-1">
                          <div className="text-xs text-gray-500">專案狀態</div>
                          <input className="w-full rounded border px-3 py-2 text-sm bg-gray-50" value={p?.status ?? '-'} disabled />
                        </div>

                        <div className="md:col-span-12 space-y-1">
                          <div className="text-xs text-gray-500">專案說明</div>
                          <textarea className="w-full rounded border px-3 py-2 text-sm min-h-[90px] bg-gray-50" value={p?.description ?? ''} disabled />
                        </div>

                        <div className="md:col-span-6 space-y-1">
                          <div className="text-xs text-gray-500">目標日期</div>
                          <input className="w-full rounded border px-3 py-2 text-sm bg-gray-50" value={fmtDate(p?.target_due_date ?? null)} disabled />
                        </div>
                      </div>
                    </div>

                    {/* ✅ expected_finish_at：主管可調整 */}
                    <div className="rounded border bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold">預估完成時間</div>
                        <div className="text-xs text-gray-500">{isSupervisor ? '主管可調整' : '僅顯示（主管可調整）'}</div>
                      </div>

                      <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                        <div className="md:col-span-6 space-y-1">
                          <div className="text-xs text-gray-500">expected_finish_at</div>
                          <input
                            type="datetime-local"
                            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
                            defaultValue={toDatetimeLocalValue(t.expected_finish_at)}
                            disabled={!isSupervisor || updatingTaskId === t.id}
                            onBlur={(e) => {
                              if (!isSupervisor) return
                              const nextIso = fromDatetimeLocalValue(e.currentTarget.value)
                              const curIso = t.expected_finish_at ?? null
                              if (curIso === nextIso) return
                              supervisorSetExpectedFinishAt(t, nextIso)
                            }}
                          />
                          <div className="text-[11px] text-gray-500">失焦（onBlur）時自動更新。若不想用 onBlur 也可改成「儲存」按鈕。</div>
                        </div>

                        <div className="md:col-span-6 text-xs">
                          {dueToday ? <span className="px-2 py-1 rounded border bg-blue-50 text-blue-700 border-blue-200">今日到期</span> : null}
                          {overdue ? <span className="ml-2 px-2 py-1 rounded border bg-red-50 text-red-700 border-red-200">逾期</span> : null}
                          {!dueToday && !overdue ? <span className="text-gray-500">—</span> : null}
                        </div>
                      </div>
                    </div>

                    {/* Reply card */}
                    <div className="rounded border bg-white p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">處理進度回覆</div>
                        <div className="text-xs text-gray-500">{can ? '你可以回覆進度' : '你無法回覆進度'}</div>
                      </div>

                      <div className="mt-3 border-t" />

                      <div className="mt-3">
                        {uLoading ? (
                          <div className="text-sm text-gray-600">載入回覆中…</div>
                        ) : updates.length === 0 ? (
                          <div className="text-sm text-gray-600">尚無回覆</div>
                        ) : (
                          <div className="space-y-2">
                            {updates.map((u) => {
                              const canManage = canManageUpdate(u)
                              const isEditingU = editingUpdateId === u.id
                              const busy = savingUpdateId === u.id || deletingUpdateId === u.id

                              return (
                                <div key={u.id} className="rounded border p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-xs text-gray-500">
                                        {userLabel(u.author_user_id)} ・ {fmtDate(u.created_at)}
                                        {u.new_status ? (
                                          <span className={cn('ml-2 inline-flex text-[11px] px-2 py-0.5 rounded border', taskStatusChip(u.new_status))}>
                                            狀態→{taskStatusLabel(u.new_status)}
                                          </span>
                                        ) : null}
                                      </div>
                                    </div>

                                    {canManage ? (
                                      <div className="shrink-0 flex gap-2">
                                        {!isEditingU ? (
                                          <>
                                            <button className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50" onClick={() => startEditUpdate(u)} disabled={busy}>
                                              編輯
                                            </button>
                                            <button
                                              className="rounded border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                                              onClick={() => deleteUpdate(t.id, u)}
                                              disabled={busy}
                                            >
                                              {deletingUpdateId === u.id ? '刪除中…' : '刪除'}
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <button className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50" onClick={cancelEditUpdate} disabled={busy}>
                                              取消
                                            </button>
                                            <button className="rounded bg-black text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => saveUpdate(t.id, u)} disabled={busy || !editMsg.trim()}>
                                              {savingUpdateId === u.id ? '儲存中…' : '儲存'}
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    ) : null}
                                  </div>

                                  {!isEditingU ? (
                                    <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap">{u.message}</div>
                                  ) : (
                                    <div className="mt-3 space-y-2">
                                      <div className="text-xs text-gray-500">編輯內容（可選擇同步更新狀態）</div>
                                      <textarea className="w-full rounded border px-3 py-2 text-sm min-h-[96px]" value={editMsg} onChange={(e) => setEditMsg(e.target.value)} disabled={busy} />
                                      <div className="flex items-center gap-2">
                                        <select className="rounded border px-3 py-2 text-sm disabled:opacity-50" value={editNextStatus} onChange={(e) => setEditNextStatus(e.target.value as any)} disabled={busy}>
                                          <option value="">（不變更狀態）</option>
                                          <option value="todo">未處理</option>
                                          <option value="in_progress">處理中</option>
                                          <option value="done">已完成</option>
                                        </select>
                                        <div className="text-[11px] text-gray-500">儲存後會更新此回覆；若選了狀態，也會嘗試同步更新任務狀態</div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>

                      {/* new reply */}
                      <div className="mt-4">
                        <div className="text-xs text-gray-500">回覆內容（可選擇同步更新狀態）</div>

                        <textarea
                          className="mt-2 w-full rounded border px-3 py-2 text-sm min-h-[110px] disabled:bg-gray-100"
                          value={draftMsg}
                          onChange={(e) => setDraftMsg(e.target.value)}
                          disabled={!can || postingTaskId === t.id}
                          placeholder={can ? '例如：已完成資料整理，等待確認；預計明日完成方案草稿。' : '你不是此任務指派人員，無法回覆。'}
                        />

                        <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-center md:justify-between">
                          <div className="flex items-center gap-2">
                            <select
                              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
                              value={draftNextStatus}
                              onChange={(e) => setDraftNextStatus(e.target.value as any)}
                              disabled={!can || postingTaskId === t.id}
                            >
                              <option value="">（不變更狀態）</option>
                              <option value="todo">未處理</option>
                              <option value="in_progress">處理中</option>
                              <option value="done">已完成</option>
                            </select>

                            <Link href={`/app/projects/${t.project_id}`} className="text-sm underline text-gray-700">
                              前往專案
                            </Link>
                          </div>

                          <button className="rounded bg-gray-700 text-white px-4 py-2 text-sm disabled:opacity-50" onClick={() => postUpdate(t)} disabled={!can || postingTaskId === t.id || !draftMsg.trim()}>
                            {postingTaskId === t.id ? '送出中…' : '送出回覆'}
                          </button>
                        </div>

                        <div className="mt-3 text-[11px] text-gray-500">
                          權限規則：主管可看全部任務並指派/改狀態；成員只看指派給自己的任務並回覆進度。回覆編輯/刪除：作者本人可操作；主管亦可操作（需 RLS 放行）。
                        </div>
                      </div>
                    </div>

                    {/* Supervisor operations */}
                    {isSupervisor ? (
                      <div className="rounded border bg-gray-50 p-4">
                        <div className="text-sm font-semibold">主管操作</div>

                        <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
                          <div className="md:col-span-6 space-y-1">
                            <div className="text-xs text-gray-500">指派人員</div>
                            <select
                              className="w-full rounded border px-3 py-2 text-sm disabled:opacity-50"
                              value={t.assignee_user_id ?? ''}
                              onChange={(e) => supervisorSetAssignee(t, e.target.value ? e.target.value : null)}
                              disabled={updatingTaskId === t.id}
                            >
                              <option value="">未指派</option>
                              {orgUsers.map((u) => (
                                <option key={u.user_id} value={u.user_id}>
                                  {u.full_name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="md:col-span-6 space-y-1">
                            <div className="text-xs text-gray-500">任務狀態</div>
                            <select
                              className="w-full rounded border px-3 py-2 text-sm disabled:opacity-50"
                              value={t.status}
                              onChange={(e) => supervisorSetStatus(t, e.target.value as TaskStatus)}
                              disabled={updatingTaskId === t.id}
                            >
                              <option value="todo">未處理</option>
                              <option value="in_progress">處理中</option>
                              <option value="done">已完成</option>
                            </select>
                          </div>
                        </div>

                        <div className="mt-3 text-[11px] text-gray-500">主管可直接調整指派/狀態；也建議用「處理進度回覆」留存紀錄。</div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import PageHeader from '../_components/PageHeader'
import { supabase } from '@/lib/supabaseClient'

/**
 * ✅ 調整重點：
 * 1) 只有主管（admin/manager）可進入此頁（非主管直接顯示無權限畫面）
 * 2) 取消審核機制：移除 pending_approval / rejected 狀態與相關文案/限制
 * 3) 此頁定位為「主管指派工作」：任務狀態與指派都由主管操作（不提供被指派者在此頁開始處理）
 * 4) ✅ 新增：工作分配「預估完成時間 expected_finish_at」
 *    - 作為「到今日到期」與「逾期」判斷基準（status !== done）
 */

type ProjectStatus = 'draft' | 'active' | 'on_hold' | 'completed' | 'archived'
type Priority = 'p1' | 'p2' | 'p3' | 'p4'
type RiskLevel = 'low' | 'medium' | 'high'

type OrgMemberRole = 'admin' | 'manager' | 'member'
type OrgMember = {
  org_id: string
  role: OrgMemberRole
  is_active: boolean
}

type ProjectSummary = {
  id: string
  org_id: string
  code: string | null
  name: string
  description: string | null

  is_archived: boolean
  status: ProjectStatus
  priority: Priority
  risk: RiskLevel
  progress_percent: number
  target_due_date: string | null
  created_at: string

  open_issues: number
  blocked_issues: number
  overdue_issues: number
  member_count: number
}

type TaskStatus = 'todo' | 'in_progress' | 'done'
type ProjectTask = {
  id: string
  project_id: string
  org_id?: string | null
  description: string
  assignee_user_id: string | null
  status: TaskStatus
  created_at?: string
  expected_finish_at?: string | null // ✅ 新增：預估完成時間
}

type ProjectAttachment = {
  id: string
  org_id: string
  project_id: string
  uploader_user_id: string
  file_name: string
  storage_bucket: string
  storage_path: string
  mime_type: string | null
  file_size: number | null
  created_at: string
}

type OrgUserOption = {
  user_id: string
  full_name: string
}

type TaskDraft = {
  key: string
  description: string
  assignee_user_id: string // '' = 未指派
  expected_finish_at: string // datetime-local string, '' = 未填
}

type EditDraft = {
  name: string
  description: string
  target_due_date: string
  priority: Priority
  status: ProjectStatus
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ')
}

function fmtDate(isoOrDate: string | null | undefined) {
  if (!isoOrDate) return '-'
  return isoOrDate.length >= 10 ? isoOrDate.slice(0, 10) : isoOrDate
}

function statusLabel(s: ProjectStatus) {
  switch (s) {
    case 'draft':
      return '草稿'
    case 'active':
      return '執行中'
    case 'on_hold':
      return '暫停'
    case 'completed':
      return '結案'
    case 'archived':
      return '封存'
    default:
      return s
  }
}

function priorityLabel(p: Priority) {
  switch (p) {
    case 'p1':
      return 'P1'
    case 'p2':
      return 'P2'
    case 'p3':
      return 'P3'
    case 'p4':
      return 'P4'
    default:
      return p
  }
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

function stableKey() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function toEditDraft(p: ProjectSummary): EditDraft {
  return {
    name: p.name ?? '',
    description: p.description ?? '',
    target_due_date: p.target_due_date ? fmtDate(p.target_due_date) : '',
    priority: p.priority,
    status: p.status,
  }
}

function sanitizeFileName(name: string) {
  return name.replace(/[\/\\?%*:|"<>]/g, '_')
}

function humanSize(n?: number | null) {
  if (!n || n <= 0) return '-'
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function safeUUID() {
  try {
    // @ts-ignore
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {}
  return stableKey()
}

/** schema cache 找不到 table */
function isMissingTableError(e: any) {
  const msg = (e?.message ?? '').toLowerCase()
  return (
    msg.includes('could not find the table') ||
    msg.includes('schema cache') ||
    msg.includes('pgrst105') ||
    (msg.includes('relation') && msg.includes('does not exist'))
  )
}

/** 權限/RLS 類錯誤 */
function isPermissionError(e: any) {
  const msg = (e?.message ?? '').toLowerCase()
  return (
    msg.includes('permission denied') ||
    msg.includes('rls') ||
    msg.includes('new row violates row-level security policy')
  )
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

export default function ProjectsPage() {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [orgId, setOrgId] = useState<string | null>(null)
  const [orgRole, setOrgRole] = useState<OrgMemberRole>('member')
  const [userId, setUserId] = useState<string | null>(null)
  const isSupervisor = orgRole === 'admin' || orgRole === 'manager'
  const [accessDenied, setAccessDenied] = useState(false)

  const [rows, setRows] = useState<ProjectSummary[]>([])
  const [createdByMap, setCreatedByMap] = useState<Record<string, string>>({})

  // Filters
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>('all')

  // Create modal state
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newDue, setNewDue] = useState('')
  const [newPriority, setNewPriority] = useState<Priority>('p3')
  const [taskDrafts, setTaskDrafts] = useState<TaskDraft[]>([
    { key: stableKey(), description: '', assignee_user_id: '', expected_finish_at: '' },
  ])
  const [createFiles, setCreateFiles] = useState<File[]>([])

  // org users for assignment dropdown
  const [orgUsers, setOrgUsers] = useState<OrgUserOption[]>([])

  // Expand + tasks + attachments
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [tasksByProject, setTasksByProject] = useState<Record<string, ProjectTask[]>>({})
  const [tasksLoadingId, setTasksLoadingId] = useState<string | null>(null)
  const [taskUpdatingId, setTaskUpdatingId] = useState<string | null>(null)

  const [attachmentsByProject, setAttachmentsByProject] = useState<Record<string, ProjectAttachment[]>>({})
  const [attachmentsLoadingId, setAttachmentsLoadingId] = useState<string | null>(null)
  const [uploadingProjectId, setUploadingProjectId] = useState<string | null>(null)
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null)

  // attachments table status
  const [attachmentsTableOk, setAttachmentsTableOk] = useState<boolean | null>(null)

  // Project edit + delete
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // ========= helpers =========
  async function ensureAttachmentsTable() {
    if (attachmentsTableOk !== null) return attachmentsTableOk

    const { error: e } = await supabase.from('project_attachments').select('id').limit(1)
    if (!e) {
      setAttachmentsTableOk(true)
      return true
    }

    if (isMissingTableError(e)) {
      setAttachmentsTableOk(false)
      return false
    }

    if (isPermissionError(e)) {
      // 有些情境：表存在但被 RLS 擋，仍視為「表存在」
      setAttachmentsTableOk(true)
      return true
    }

    setAttachmentsTableOk(false)
    return false
  }

  // ========= init =========
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      setError(null)
      setAccessDenied(false)

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
          setOrgRole(mem.role)
        }

        // ✅ 此頁只有主管可進入
        const supervisor = mem.role === 'admin' || mem.role === 'manager'
        if (!supervisor) {
          if (!cancelled) {
            setAccessDenied(true)
            setError(null)
            setRows([])
          }
          setLoading(false)
          return
        }

        const { data, error: viewErr } = await supabase
          .from('v_project_summary')
          .select('*')
          .eq('org_id', mem.org_id)
          .order('created_at', { ascending: false })

        if (viewErr) throw new Error(`讀取 v_project_summary 失敗：${viewErr.message}`)
        const list = (data ?? []) as ProjectSummary[]
        if (!cancelled) setRows(list)

        if (list.length > 0) {
          const ids = list.map((p) => p.id)
          const { data: creators, error: cErr } = await supabase
            .from('projects')
            .select('id, created_by')
            .in('id', ids)

          if (!cErr && Array.isArray(creators)) {
            const m: Record<string, string> = {}
            creators.forEach((r: any) => {
              if (r?.id && r?.created_by) m[r.id] = r.created_by
            })
            if (!cancelled) setCreatedByMap(m)
          }
        }

        // ✅ org users list：抓 v_org_users（由 profiles.display_name 產出 full_name）
        const { data: us, error: usErr } = await supabase
          .from('v_org_users')
          .select('user_id, full_name')
          .eq('org_id', mem.org_id)
          .order('full_name', { ascending: true })

        if (!usErr && Array.isArray(us) && us.length > 0) {
          const opts: OrgUserOption[] = us
            .map((r: any) => ({ user_id: r.user_id, full_name: r.full_name ?? r.user_id }))
            .filter((x) => !!x.user_id)
          if (!cancelled) setOrgUsers(opts)
        } else {
          // fallback：至少自己可選（顯示 email > id 前8）
          const label = (user.email ?? '').trim() || user.id.slice(0, 8)
          if (!cancelled) setOrgUsers([{ user_id: user.id, full_name: label }])
        }

        if (!cancelled) ensureAttachmentsTable().catch(() => {})
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    if (!orgId) return
    if (!isSupervisor) return

    setRefreshing(true)
    setError(null)

    try {
      const { data, error: viewErr } = await supabase
        .from('v_project_summary')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })

      if (viewErr) throw viewErr
      const list = (data ?? []) as ProjectSummary[]
      setRows(list)

      if (list.length > 0) {
        const ids = list.map((p) => p.id)
        const { data: creators, error: cErr } = await supabase
          .from('projects')
          .select('id, created_by')
          .in('id', ids)

        if (!cErr && Array.isArray(creators)) {
          const m: Record<string, string> = {}
          creators.forEach((r: any) => {
            if (r?.id && r?.created_by) m[r.id] = r.created_by
          })
          setCreatedByMap(m)
        }
      }
    } catch (e: any) {
      setError(e?.message ?? '重新整理失敗')
    } finally {
      setRefreshing(false)
    }
  }

  // ========= Create modal helpers =========
  function openCreateModal() {
    if (!isSupervisor) return
    setError(null)
    dialogRef.current?.showModal()
  }
  function closeCreateModal() {
    dialogRef.current?.close()
  }
  function resetCreateForm() {
    setNewName('')
    setNewDesc('')
    setNewDue('')
    setNewPriority('p3')
    setTaskDrafts([{ key: stableKey(), description: '', assignee_user_id: '', expected_finish_at: '' }])
    setCreateFiles([])
  }

  function addTaskDraft() {
    setTaskDrafts((xs) => [...xs, { key: stableKey(), description: '', assignee_user_id: '', expected_finish_at: '' }])
  }
  function removeTaskDraft(key: string) {
    setTaskDrafts((xs) => (xs.length <= 1 ? xs : xs.filter((t) => t.key !== key)))
  }
  function updateTaskDraft(key: string, patch: Partial<TaskDraft>) {
    setTaskDrafts((xs) => xs.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  }

  function addCreateFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const incoming = Array.from(files)
    setCreateFiles((prev) => {
      const exists = new Set(prev.map((f) => `${f.name}|${f.size}|${f.lastModified}`))
      const merged = [...prev]
      for (const f of incoming) {
        const k = `${f.name}|${f.size}|${f.lastModified}`
        if (!exists.has(k)) {
          merged.push(f)
          exists.add(k)
        }
      }
      return merged
    })
  }
  function removeCreateFile(idx: number) {
    setCreateFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  // ========= Load tasks & attachments =========
  async function loadTasks(projectId: string) {
    setTasksLoadingId(projectId)
    setError(null)
    try {
      const { data, error: tErr } = await supabase
        .from('project_tasks')
        .select('id, project_id, org_id, description, assignee_user_id, status, created_at, expected_finish_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true })

      if (tErr) throw tErr
      setTasksByProject((m) => ({ ...m, [projectId]: (data ?? []) as ProjectTask[] }))
    } catch (e: any) {
      setError(e?.message ?? '讀取工作分配失敗')
    } finally {
      setTasksLoadingId(null)
    }
  }

  async function loadAttachments(projectId: string) {
    setAttachmentsLoadingId(projectId)
    setError(null)
    try {
      const ok = await ensureAttachmentsTable()
      if (!ok) {
        setAttachmentsByProject((m) => ({ ...m, [projectId]: [] }))
        setError('附件功能尚未啟用：資料表 project_attachments 尚未建立。')
        return
      }

      const { data, error: aErr } = await supabase
        .from('project_attachments')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })

      if (aErr) {
        if (isPermissionError(aErr)) {
          throw new Error('讀取附件失敗：權限不足（請建立 project_attachments 的 RLS SELECT policy）。')
        }
        throw aErr
      }

      setAttachmentsByProject((m) => ({ ...m, [projectId]: (data ?? []) as ProjectAttachment[] }))
    } catch (e: any) {
      setError(e?.message ?? '讀取附件失敗')
    } finally {
      setAttachmentsLoadingId(null)
    }
  }

  async function onToggleExpand(projectId: string) {
    setExpandedId((cur) => (cur === projectId ? null : projectId))
    if (expandedId !== projectId) {
      await loadTasks(projectId)
      await loadAttachments(projectId)
    }
  }

  // ========= Create project (RPC version) =========
  async function createProject() {
    if (!isSupervisor) {
      setError('此頁僅限主管操作。')
      return
    }
    if (!orgId) {
      setError('找不到 org_id（請先建立 org_members）')
      return
    }
    if (!newName.trim()) return

    setCreating(true)
    setError(null)

    try {
      const { data: userRes } = await supabase.auth.getUser()
      const user = userRes.user
      if (!user) throw new Error('尚未登入')

      const { data: projectId, error: rpcErr } = await supabase.rpc('create_project_with_owner', {
        p_org_id: orgId,
        p_name: newName.trim(),
        p_description: newDesc.trim() || null,
        p_target_due_date: newDue || null,
        p_priority: newPriority,
      })

      if (rpcErr) throw new Error(`建立專案失敗（RPC）：${rpcErr.message}`)
      const pid = projectId as string
      if (!pid) throw new Error('建立專案失敗（未取得 project_id）')

      const cleanTasks = taskDrafts
        .map((t) => ({
          org_id: orgId,
          project_id: pid,
          description: t.description.trim(),
          assignee_user_id: t.assignee_user_id || null,
          status: 'todo' as TaskStatus,
          expected_finish_at: fromDatetimeLocalValue(t.expected_finish_at), // ✅ 新增
        }))
        .filter((t) => !!t.description)

      if (cleanTasks.length > 0) {
        const { error: tErr } = await supabase.from('project_tasks').insert(cleanTasks)
        if (tErr) throw tErr
      }

      const failed: string[] = []
      const attachmentTableOk = createFiles.length > 0 ? await ensureAttachmentsTable() : true

      for (const f of createFiles) {
        try {
          const safeName = sanitizeFileName(f.name)
          const objectPath = `org/${orgId}/project/${pid}/${safeUUID()}-${safeName}`

          const { error: upErr } = await supabase.storage.from('project-attachments').upload(objectPath, f, {
            cacheControl: '3600',
            upsert: false,
            contentType: f.type || undefined,
          })
          if (upErr) throw upErr

          if (!attachmentTableOk) {
            failed.push(`${f.name}（DB未建project_attachments，只上傳Storage未寫入）`)
            continue
          }

          const { error: insErr } = await supabase.from('project_attachments').insert({
            org_id: orgId,
            project_id: pid,
            uploader_user_id: user.id,
            file_name: f.name,
            storage_bucket: 'project-attachments',
            storage_path: objectPath,
            mime_type: f.type || null,
            file_size: f.size || null,
          })

          if (insErr) {
            if (isPermissionError(insErr)) {
              throw new Error('寫入附件資料失敗：權限不足（請建立 project_attachments 的 RLS INSERT policy）。')
            }
            throw insErr
          }
        } catch {
          failed.push(f.name)
        }
      }

      closeCreateModal()
      resetCreateForm()

      setCreatedByMap((m) => ({ ...m, [pid]: user.id }))

      await refresh()
      setExpandedId(pid)
      await loadTasks(pid)
      await loadAttachments(pid)

      if (failed.length > 0) {
        setError(`專案已建立，但以下附件處理不完整：${failed.join('、')}`)
      }
    } catch (e: any) {
      setError(e?.message ?? '建立專案失敗')
    } finally {
      setCreating(false)
    }
  }

  // ========= Task ops (主管操作) =========
  function canSupervisorSetStatus() {
    return isSupervisor
  }

  async function supervisorSetTaskStatus(task: ProjectTask, next: TaskStatus) {
    if (!canSupervisorSetStatus()) return
    setTaskUpdatingId(task.id)
    setError(null)
    try {
      const { error: uErr } = await supabase.from('project_tasks').update({ status: next }).eq('id', task.id)
      if (uErr) throw uErr
      await loadTasks(task.project_id)
    } catch (e: any) {
      setError(e?.message ?? '更新任務狀態失敗')
    } finally {
      setTaskUpdatingId(null)
    }
  }

  async function supervisorUpdateAssignee(task: ProjectTask, nextAssigneeUserId: string | null) {
    if (!canSupervisorSetStatus()) return
    setTaskUpdatingId(task.id)
    setError(null)
    try {
      const { error: uErr } = await supabase
        .from('project_tasks')
        .update({ assignee_user_id: nextAssigneeUserId })
        .eq('id', task.id)
      if (uErr) throw uErr
      await loadTasks(task.project_id)
    } catch (e: any) {
      setError(e?.message ?? '更新指派人員失敗')
    } finally {
      setTaskUpdatingId(null)
    }
  }

  async function supervisorUpdateExpectedFinishAt(task: ProjectTask, nextIso: string | null) {
    if (!canSupervisorSetStatus()) return
    setTaskUpdatingId(task.id)
    setError(null)
    try {
      const { error: uErr } = await supabase
        .from('project_tasks')
        .update({ expected_finish_at: nextIso })
        .eq('id', task.id)
      if (uErr) throw uErr
      await loadTasks(task.project_id)
    } catch (e: any) {
      setError(e?.message ?? '更新預估完成時間失敗')
    } finally {
      setTaskUpdatingId(null)
    }
  }

  async function supervisorAddTask(projectId: string) {
    if (!orgId || !isSupervisor) return
    const desc = window.prompt('新增任務說明（將建立為未處理 todo）')
    if (!desc?.trim()) return

    // ✅ 讓主管可順手填預估完成（可留空）
    const dt = window.prompt('預估完成時間（可留空，格式範例：2026-02-16T18:00）', '')
    const expectedIso = dt ? fromDatetimeLocalValue(dt.trim()) : null

    setTaskUpdatingId(`add_${projectId}`)
    setError(null)
    try {
      const { error: iErr } = await supabase.from('project_tasks').insert({
        org_id: orgId,
        project_id: projectId,
        description: desc.trim(),
        assignee_user_id: null,
        status: 'todo',
        expected_finish_at: expectedIso,
      })
      if (iErr) throw iErr
      await loadTasks(projectId)
    } catch (e: any) {
      setError(e?.message ?? '新增任務失敗')
    } finally {
      setTaskUpdatingId(null)
    }
  }

  async function supervisorDeleteTask(task: ProjectTask) {
    if (!isSupervisor) return
    const ok = window.confirm('確定刪除此任務？')
    if (!ok) return

    setTaskUpdatingId(task.id)
    setError(null)
    try {
      const { error: dErr } = await supabase.from('project_tasks').delete().eq('id', task.id)
      if (dErr) throw dErr
      await loadTasks(task.project_id)
    } catch (e: any) {
      setError(e?.message ?? '刪除任務失敗')
    } finally {
      setTaskUpdatingId(null)
    }
  }

  function userLabel(uid: string | null) {
    if (!uid) return '未指派'
    const hit = orgUsers.find((u) => u.user_id === uid)
    return hit?.full_name ?? uid
  }

  // ========= Project edit/delete =========
  function isCreator(projectId: string) {
    return !!userId && createdByMap[projectId] === userId
  }

  function startEdit(p: ProjectSummary) {
    if (!isSupervisor) return
    setError(null)
    setEditingId(p.id)
    setEditDraft(toEditDraft(p))
    setConfirmDeleteId(null)
    setDeleteConfirmText('')
    setExpandedId(p.id)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft(null)
    setConfirmDeleteId(null)
    setDeleteConfirmText('')
  }

  async function saveProject(projectId: string) {
    if (!isSupervisor) return
    if (!editDraft) return

    setSavingId(projectId)
    setError(null)

    try {
      const payload = {
        name: editDraft.name.trim(),
        description: editDraft.description.trim() || null,
        target_due_date: editDraft.target_due_date || null,
        priority: editDraft.priority,
        status: editDraft.status,
      }
      if (!payload.name) throw new Error('專案名稱不可為空')

      const { error: uErr } = await supabase.from('projects').update(payload).eq('id', projectId)
      if (uErr) throw uErr

      await refresh()
      cancelEdit()
      setExpandedId(projectId)
    } catch (e: any) {
      setError(e?.message ?? '儲存失敗')
    } finally {
      setSavingId(null)
    }
  }

  function openDeleteConfirm(projectId: string) {
    if (!isSupervisor) return
    setConfirmDeleteId(projectId)
    setDeleteConfirmText('')
  }
  function closeDeleteConfirm() {
    setConfirmDeleteId(null)
    setDeleteConfirmText('')
  }

  async function deleteProject(p: ProjectSummary) {
    if (!isSupervisor) return

    // 保留原本「創建者才能刪除」規則（可依你公司規則改成主管皆可刪）
    if (!isCreator(p.id)) {
      setError('只有建立此專案的人可以刪除。')
      return
    }

    setDeletingId(p.id)
    setError(null)
    try {
      const { error: pErr } = await supabase.from('projects').delete().eq('id', p.id)
      if (pErr) throw pErr

      closeDeleteConfirm()
      if (expandedId === p.id) setExpandedId(null)
      if (editingId === p.id) cancelEdit()

      setTasksByProject((m) => {
        const c = { ...m }
        delete c[p.id]
        return c
      })
      setAttachmentsByProject((m) => {
        const c = { ...m }
        delete c[p.id]
        return c
      })

      await refresh()
    } catch (e: any) {
      setError(e?.message ?? '刪除失敗（請檢查 RLS/外鍵 cascade/權限）')
    } finally {
      setDeletingId(null)
    }
  }

  // ========= Attachments =========
  async function uploadAttachment(projectId: string, file: File) {
    if (!orgId) return
    if (!userId) return
    if (!isSupervisor) return

    setUploadingProjectId(projectId)
    setError(null)

    try {
      const ok = await ensureAttachmentsTable()
      if (!ok) {
        setError('附件功能尚未啟用：資料表 project_attachments 尚未建立。')
        return
      }

      const safeName = sanitizeFileName(file.name)
      const objectPath = `org/${orgId}/project/${projectId}/${safeUUID()}-${safeName}`

      const { error: upErr } = await supabase.storage.from('project-attachments').upload(objectPath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined,
      })
      if (upErr) throw upErr

      const { error: insErr } = await supabase.from('project_attachments').insert({
        org_id: orgId,
        project_id: projectId,
        uploader_user_id: userId,
        file_name: file.name,
        storage_bucket: 'project-attachments',
        storage_path: objectPath,
        mime_type: file.type || null,
        file_size: file.size || null,
      })

      if (insErr) {
        if (isPermissionError(insErr)) {
          throw new Error('上傳附件失敗：權限不足（請建立 project_attachments 的 RLS INSERT policy）。')
        }
        throw insErr
      }

      await loadAttachments(projectId)
    } catch (e: any) {
      setError(e?.message ?? '上傳附件失敗')
    } finally {
      setUploadingProjectId(null)
    }
  }

  async function downloadAttachment(a: ProjectAttachment) {
    setError(null)
    try {
      const { data, error: sErr } = await supabase.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 60)
      if (sErr) throw sErr
      window.open(data.signedUrl, '_blank')
    } catch (e: any) {
      setError(e?.message ?? '產生下載連結失敗')
    }
  }

  async function deleteAttachment(a: ProjectAttachment) {
    if (!isSupervisor) return

    setDeletingAttachmentId(a.id)
    setError(null)
    try {
      const ok = await ensureAttachmentsTable()
      if (!ok) {
        setError('附件功能尚未啟用：資料表 project_attachments 尚未建立。')
        return
      }

      const { error: rErr } = await supabase.storage.from(a.storage_bucket).remove([a.storage_path])
      if (rErr) throw rErr

      const { error: dErr } = await supabase.from('project_attachments').delete().eq('id', a.id)
      if (dErr) {
        if (isPermissionError(dErr)) {
          throw new Error('刪除附件失敗：權限不足（請建立 project_attachments 的 RLS DELETE policy）。')
        }
        throw dErr
      }

      await loadAttachments(a.project_id)
    } catch (e: any) {
      setError(e?.message ?? '刪除附件失敗')
    } finally {
      setDeletingAttachmentId(null)
    }
  }

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return rows
      .filter((p) => (showArchived ? true : !p.is_archived && p.status !== 'archived'))
      .filter((p) => (statusFilter === 'all' ? true : p.status === statusFilter))
      .filter((p) => {
        if (!kw) return true
        return (p.name ?? '').toLowerCase().includes(kw) || (p.description ?? '').toLowerCase().includes(kw)
      })
  }, [rows, q, showArchived, statusFilter])

  // ========= Access Denied UI =========
  if (!loading && accessDenied) {
    return (
      <div className="space-y-4">
        <PageHeader title="專案管理（主管專用）" description="此頁面僅限主管用於指派任務與管理專案。" />
        <div className="rounded border bg-white p-6">
          <div className="text-lg font-semibold">無法進入</div>
          <div className="mt-2 text-sm text-gray-700">
            你的角色為 <span className="font-mono">{orgRole}</span>，此功能僅提供{' '}
            <span className="font-semibold">admin / manager</span> 使用。
          </div>
          <div className="mt-4 text-sm text-gray-600">請聯絡系統管理者將你加入 org_members 並設定 role 為 manager 或 admin。</div>
          <div className="mt-4">
            <Link className="text-sm underline" href="/app">
              返回儀表板
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="專案管理（主管專用）"
          description="主管建立專案並指派工作（任務說明＋人員指派＋預估完成時間），可調整任務狀態與維護附件。已取消審核流程。"
        />

        <div className="flex gap-2">
          <button
            className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            onClick={refresh}
            disabled={refreshing || loading || !isSupervisor}
          >
            {refreshing ? '更新中…' : '重新整理'}
          </button>

          <button
            className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
            onClick={openCreateModal}
            disabled={loading || !isSupervisor}
            title={!isSupervisor ? '僅主管可建立專案' : '建立專案'}
          >
            ＋ 建立專案
          </button>
        </div>
      </div>

      {/* Create Modal (center) */}
      <dialog
        ref={dialogRef}
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          'w-[min(900px,calc(100vw-2rem))] rounded-2xl p-0',
          'bg-white shadow-xl border',
          'max-h-[90vh] overflow-hidden',
          'backdrop:bg-black/40'
        )}
      >
        <div className="border-b px-6 py-4">
          <div className="text-lg font-semibold">建立專案</div>
          <div className="text-xs text-gray-500 mt-1">專案名稱／專案說明／工作分配（任務＋指派＋預估完成）／附件／目標日期／優先級</div>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-152px)] space-y-6">
          <div className="space-y-1">
            <div className="text-xs text-gray-500">專案名稱（必填）</div>
            <input
              className="w-full rounded border px-3 py-2 text-sm"
              placeholder="例如：客服回覆效率提升專案"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-gray-500">專案說明</div>
            <textarea
              className="w-full rounded border px-3 py-2 text-sm min-h-[90px]"
              placeholder="背景、目的、範圍、成功定義"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>

          {/* Tasks drafts */}
          <div className="rounded border bg-gray-50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">新增工作分配</div>
              <button className="rounded bg-black text-white px-3 py-1.5 text-sm" onClick={addTaskDraft} type="button">
                ＋ 新增
              </button>
            </div>

            <div className="space-y-3">
              {taskDrafts.map((t, idx) => (
                <div key={t.key} className="rounded border bg-white p-3">
                  <div className="text-xs text-gray-500 mb-2">工作分配 {idx + 1}</div>

                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                    <div className="md:col-span-6 space-y-1">
                      <div className="text-xs text-gray-500">任務說明</div>
                      <input
                        className="w-full rounded border px-3 py-2 text-sm"
                        placeholder="例如：整理需求與流程、建立回覆模板"
                        value={t.description}
                        onChange={(e) => updateTaskDraft(t.key, { description: e.target.value })}
                      />
                    </div>

                    <div className="md:col-span-3 space-y-1">
                      <div className="text-xs text-gray-500">人員指派</div>
                      <select
                        className="w-full rounded border px-3 py-2 text-sm"
                        value={t.assignee_user_id}
                        onChange={(e) => updateTaskDraft(t.key, { assignee_user_id: e.target.value })}
                      >
                        <option value="">未指派</option>
                        {orgUsers.map((u) => (
                          <option key={u.user_id} value={u.user_id}>
                            {u.full_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="md:col-span-3 space-y-1">
                      <div className="text-xs text-gray-500">預估完成時間</div>
                      <input
                        type="datetime-local"
                        className="w-full rounded border px-3 py-2 text-sm"
                        value={t.expected_finish_at}
                        onChange={(e) => updateTaskDraft(t.key, { expected_finish_at: e.target.value })}
                        placeholder="yyyy-mm-ddThh:mm"
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex justify-end">
                    <button
                      className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => removeTaskDraft(t.key)}
                      disabled={taskDrafts.length <= 1}
                      type="button"
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-gray-500">建立後任務狀態預設為「未處理」。到期與逾期判斷以「預估完成時間」為準。</div>
          </div>

          {/* Attachments */}
          <div className="rounded border bg-white p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">附件</div>

              <label className="inline-flex items-center gap-2">
                <input
                  type="file"
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    addCreateFiles(e.target.files)
                    e.currentTarget.value = ''
                  }}
                  disabled={creating}
                />
                <span
                  className={cn(
                    'rounded bg-black text-white px-3 py-1.5 text-sm cursor-pointer select-none',
                    creating && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  ＋ 加入附件
                </span>
              </label>
            </div>

            {createFiles.length === 0 ? (
              <div className="text-sm text-gray-600">尚未加入附件</div>
            ) : (
              <div className="space-y-2">
                {createFiles.map((f, idx) => (
                  <div
                    key={`${f.name}-${f.size}-${f.lastModified}`}
                    className="flex items-start justify-between gap-3 rounded border p-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium break-words">{f.name}</div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        {humanSize(f.size)} ・ {f.type || 'unknown'}
                      </div>
                    </div>

                    <button
                      className="rounded border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                      onClick={() => removeCreateFile(idx)}
                      disabled={creating}
                      type="button"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="text-[11px] text-gray-500">
              提示：此處先選檔，按「建立」後才會上傳到 Storage（私有 bucket，下載用簽名連結）。
              <br />
              若 DB 尚未建立 project_attachments，會「只上傳 Storage，無法在清單顯示」。
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6 space-y-1">
              <div className="text-xs text-gray-500">目標日期</div>
              <input
                type="date"
                className="w-full rounded border px-3 py-2 text-sm"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
              />
            </div>

            <div className="md:col-span-6 space-y-1">
              <div className="text-xs text-gray-500">優先級</div>
              <select
                className="w-full rounded border px-3 py-2 text-sm"
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Priority)}
              >
                <option value="p1">P1（最高）</option>
                <option value="p2">P2</option>
                <option value="p3">P3（預設）</option>
                <option value="p4">P4</option>
              </select>
            </div>
          </div>
        </div>

        <div className="border-t px-6 py-4 flex justify-end gap-2">
          <button className="rounded border px-4 py-2 text-sm hover:bg-gray-50" onClick={closeCreateModal} disabled={creating}>
            取消
          </button>
          <button
            className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
            onClick={createProject}
            disabled={creating || !newName.trim()}
          >
            {creating ? '建立中…' : '建立'}
          </button>
        </div>
      </dialog>

      {/* Filters */}
      <div className="rounded border bg-white p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 space-y-1">
            <div className="text-xs text-gray-500">搜尋（名稱/說明）</div>
            <input
              className="w-full rounded border px-3 py-2 text-sm"
              placeholder="輸入關鍵字"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className="md:col-span-3 space-y-1">
            <div className="text-xs text-gray-500">狀態</div>
            <select
              className="w-full rounded border px-3 py-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
            >
              <option value="all">全部</option>
              <option value="draft">草稿</option>
              <option value="active">執行中</option>
              <option value="on_hold">暫停</option>
              <option value="completed">結案</option>
              <option value="archived">封存</option>
            </select>
          </div>

          <div className="md:col-span-3 flex items-end">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              顯示封存
            </label>
          </div>
        </div>

        <div className="text-xs text-gray-500">你的權限：主管（可建立專案、指派任務、調整狀態、維護附件）</div>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="font-semibold">發生問題</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {/* Cards */}
      {loading ? (
        <div className="rounded border bg-white p-4 text-sm text-gray-600">載入中…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border bg-white p-6 text-sm text-gray-600">沒有符合條件的專案</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => {
            const isExpanded = expandedId === p.id
            const isEditing = editingId === p.id
            const edit = isEditing ? editDraft : null

            const tasks = tasksByProject[p.id] ?? []
            const isTasksLoading = tasksLoadingId === p.id

            const attachments = attachmentsByProject[p.id] ?? []
            const isAttachmentsLoading = attachmentsLoadingId === p.id

            const isDeleteOpen = confirmDeleteId === p.id

            return (
              <div key={p.id} className="rounded border bg-white overflow-hidden">
                <button
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-start justify-between gap-3"
                  onClick={() => onToggleExpand(p.id)}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="truncate font-medium">{p.name}</div>
                      <span className="text-xs px-2 py-1 rounded border bg-white text-gray-800">{statusLabel(p.status)}</span>
                      <span className="text-xs px-2 py-1 rounded border bg-white text-gray-800">{priorityLabel(p.priority)}</span>
                      <span className="text-xs text-gray-500">目標日 {fmtDate(p.target_due_date)}</span>
                    </div>
                    <div className="truncate text-xs text-gray-600 mt-1">{p.description ?? '-'}</div>
                  </div>

                  <div className="shrink-0 text-xs text-gray-500 pt-1">{isExpanded ? '收合 ▲' : '展開 ▼'}</div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 py-4 space-y-4">
                    {/* Project info */}
                    <div className="rounded border bg-gray-50 p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">專案資訊</div>

                        <div className="flex gap-2">
                          {!isEditing ? (
                            <button className="rounded border px-3 py-1.5 text-sm hover:bg-white" onClick={() => startEdit(p)}>
                              編輯
                            </button>
                          ) : (
                            <>
                              <button
                                className="rounded border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-white disabled:opacity-50"
                                onClick={() => openDeleteConfirm(p.id)}
                                disabled={!isCreator(p.id) || deletingId === p.id}
                                title={!isCreator(p.id) ? '只有建立專案的人可以刪除' : '刪除專案'}
                              >
                                刪除
                              </button>

                              <button
                                className="rounded border px-3 py-1.5 text-sm hover:bg-white"
                                onClick={cancelEdit}
                                disabled={savingId === p.id || deletingId === p.id}
                              >
                                取消
                              </button>

                              <button
                                className="rounded bg-black text-white px-3 py-1.5 text-sm disabled:opacity-50"
                                onClick={() => saveProject(p.id)}
                                disabled={savingId === p.id || deletingId === p.id || !edit?.name.trim()}
                              >
                                {savingId === p.id ? '儲存中…' : '儲存'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isEditing && isDeleteOpen && (
                        <div className="mt-4 rounded border border-red-200 bg-red-50 p-4">
                          <div className="text-sm font-semibold text-red-800">刪除確認</div>
                          <div className="text-xs text-red-700 mt-1">
                            為避免誤刪，請輸入專案名稱：<span className="font-mono">{p.name}</span>
                          </div>

                          <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-center">
                            <input
                              className="w-full md:flex-1 rounded border px-3 py-2 text-sm"
                              placeholder="輸入專案名稱以確認"
                              value={deleteConfirmText}
                              onChange={(e) => setDeleteConfirmText(e.target.value)}
                              disabled={deletingId === p.id}
                            />

                            <div className="flex gap-2">
                              <button className="rounded border px-3 py-2 text-sm hover:bg-white" onClick={closeDeleteConfirm} disabled={deletingId === p.id}>
                                取消
                              </button>

                              <button
                                className="rounded bg-red-600 text-white px-3 py-2 text-sm disabled:opacity-50"
                                onClick={() => deleteProject(p)}
                                disabled={deletingId === p.id || deleteConfirmText.trim() !== p.name.trim()}
                                title={deleteConfirmText.trim() !== p.name.trim() ? '名稱不一致，無法刪除' : '確認刪除'}
                              >
                                {deletingId === p.id ? '刪除中…' : '確認刪除'}
                              </button>
                            </div>
                          </div>

                          <div className="mt-2 text-[11px] text-red-700">刪除會連帶刪除任務、成員關聯與附件資料（需外鍵 on delete cascade）。</div>
                        </div>
                      )}

                      <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
                        <div className="md:col-span-6 space-y-1">
                          <div className="text-xs text-gray-500">專案名稱</div>
                          <input
                            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
                            value={isEditing ? (edit?.name ?? '') : p.name}
                            disabled={!isEditing}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                          />
                        </div>

                        <div className="md:col-span-3 space-y-1">
                          <div className="text-xs text-gray-500">優先級</div>
                          <select
                            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
                            value={isEditing ? (edit?.priority ?? 'p3') : p.priority}
                            disabled={!isEditing}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, priority: e.target.value as Priority } : d))}
                          >
                            <option value="p1">P1（最高）</option>
                            <option value="p2">P2</option>
                            <option value="p3">P3</option>
                            <option value="p4">P4</option>
                          </select>
                        </div>

                        <div className="md:col-span-3 space-y-1">
                          <div className="text-xs text-gray-500">專案狀態</div>
                          <select
                            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
                            value={isEditing ? (edit?.status ?? 'active') : p.status}
                            disabled={!isEditing}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, status: e.target.value as ProjectStatus } : d))}
                          >
                            <option value="draft">草稿</option>
                            <option value="active">執行中</option>
                            <option value="on_hold">暫停</option>
                            <option value="completed">結案</option>
                            <option value="archived">封存</option>
                          </select>
                        </div>

                        <div className="md:col-span-12 space-y-1">
                          <div className="text-xs text-gray-500">專案說明</div>
                          <textarea
                            className="w-full rounded border px-3 py-2 text-sm min-h-[90px] disabled:bg-gray-100"
                            value={isEditing ? (edit?.description ?? '') : p.description ?? ''}
                            disabled={!isEditing}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, description: e.target.value } : d))}
                          />
                        </div>

                        <div className="md:col-span-6 space-y-1">
                          <div className="text-xs text-gray-500">目標日期</div>
                          <input
                            type="date"
                            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
                            value={isEditing ? (edit?.target_due_date ?? '') : p.target_due_date ? fmtDate(p.target_due_date) : ''}
                            disabled={!isEditing}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, target_due_date: e.target.value } : d))}
                          />
                        </div>

                        <div className="md:col-span-6 flex items-end justify-end">
                          <Link href={`/app/projects/${p.id}`} className="text-sm underline text-gray-800" onClick={(e) => e.stopPropagation()}>
                            進入詳情
                          </Link>
                        </div>
                      </div>
                    </div>

                    {/* Tasks */}
                    <div className="rounded border bg-white p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">工作分配（主管指派）</div>
                        <button
                          className="rounded bg-black text-white px-3 py-1.5 text-sm disabled:opacity-50"
                          onClick={() => supervisorAddTask(p.id)}
                          disabled={taskUpdatingId === `add_${p.id}`}
                        >
                          ＋ 新增任務
                        </button>
                      </div>

                      {isTasksLoading ? (
                        <div className="text-sm text-gray-600">載入任務中…</div>
                      ) : tasks.length === 0 ? (
                        <div className="text-sm text-gray-600">尚無工作分配</div>
                      ) : (
                        <div className="space-y-2">
                          {tasks.map((t, idx) => {
                            const dueToday = isDueToday(t)
                            const overdue = isOverdue(t)

                            return (
                              <div key={t.id} className="rounded border p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-xs text-gray-500">工作分配 {idx + 1}</div>
                                    <div className="mt-1 text-sm font-medium break-words">{t.description}</div>

                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                                      <span>人員指派：{userLabel(t.assignee_user_id)}</span>
                                      <span className="text-gray-300">｜</span>
                                      <span>預估完成：{t.expected_finish_at ? toDatetimeLocalValue(t.expected_finish_at).replace('T', ' ') : '-'}</span>

                                      {dueToday && (
                                        <span className="px-2 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200">今日到期</span>
                                      )}
                                      {overdue && (
                                        <span className="px-2 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">逾期</span>
                                      )}
                                    </div>
                                  </div>

                                  <div className="shrink-0 flex items-center gap-2">
                                    {/* ✅ 預估完成時間（紅圈位置） */}
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-gray-600">預估完成</span>
                                      <input
                                        type="datetime-local"
                                        className="w-[190px] rounded border px-2 py-1.5 text-sm disabled:opacity-50"
                                        defaultValue={toDatetimeLocalValue(t.expected_finish_at)}
                                        disabled={taskUpdatingId === t.id}
                                        onBlur={(e) => {
                                          const nextIso = fromDatetimeLocalValue(e.currentTarget.value)
                                          const curIso = t.expected_finish_at ?? null
                                          if (curIso === nextIso) return
                                          supervisorUpdateExpectedFinishAt(t, nextIso)
                                        }}
                                        title="預估完成時間"
                                      />
                                    </div>

                                    <span className={cn('text-xs px-2 py-1 rounded border', taskStatusChip(t.status))}>
                                      {taskStatusLabel(t.status)}
                                    </span>

                                    {canSupervisorSetStatus() ? (
                                      <>
                                        <select
                                          className="rounded border px-2 py-1.5 text-sm disabled:opacity-50"
                                          value={t.assignee_user_id ?? ''}
                                          onChange={(e) => supervisorUpdateAssignee(t, e.target.value ? e.target.value : null)}
                                          disabled={taskUpdatingId === t.id}
                                          title="指派人員"
                                        >
                                          <option value="">未指派</option>
                                          {orgUsers.map((u) => (
                                            <option key={u.user_id} value={u.user_id}>
                                              {u.full_name}
                                            </option>
                                          ))}
                                        </select>

                                        <select
                                          className="rounded border px-2 py-1.5 text-sm disabled:opacity-50"
                                          value={t.status}
                                          onChange={(e) => supervisorSetTaskStatus(t, e.target.value as TaskStatus)}
                                          disabled={taskUpdatingId === t.id}
                                          title="變更狀態"
                                        >
                                          <option value="todo">未處理</option>
                                          <option value="in_progress">處理中</option>
                                          <option value="done">已完成</option>
                                        </select>

                                        <button
                                          className="rounded border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                                          onClick={() => supervisorDeleteTask(t)}
                                          disabled={taskUpdatingId === t.id}
                                          title="刪除任務"
                                        >
                                          刪除
                                        </button>
                                      </>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      <div className="text-[11px] text-gray-500">
                        規則：此頁僅主管操作；任務指派與狀態調整皆由主管維護。到期/逾期以「預估完成時間」為準（status ≠ done）。
                      </div>
                    </div>

                    {/* Attachments */}
                    <div className="rounded border bg-white p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold">附件</div>

                        <label className="inline-flex items-center gap-2">
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              e.target.value = ''
                              if (f) uploadAttachment(p.id, f)
                            }}
                            disabled={uploadingProjectId === p.id}
                          />
                          <span
                            className={cn(
                              'rounded bg-black text-white px-3 py-1.5 text-sm cursor-pointer select-none',
                              uploadingProjectId === p.id && 'opacity-50 cursor-not-allowed'
                            )}
                          >
                            {uploadingProjectId === p.id ? '上傳中…' : '＋ 上傳附件'}
                          </span>
                        </label>
                      </div>

                      {isAttachmentsLoading ? (
                        <div className="text-sm text-gray-600">載入附件中…</div>
                      ) : attachments.length === 0 ? (
                        <div className="text-sm text-gray-600">尚無附件</div>
                      ) : (
                        <div className="space-y-2">
                          {attachments.map((a) => (
                            <div key={a.id} className="flex items-start justify-between gap-3 rounded border p-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium break-words">{a.file_name}</div>
                                <div className="text-[11px] text-gray-500 mt-1">
                                  上傳者 {a.uploader_user_id.slice(0, 8)} ・ {fmtDate(a.created_at)} ・ {humanSize(a.file_size)}
                                </div>
                              </div>

                              <div className="shrink-0 flex gap-2">
                                <button className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => downloadAttachment(a)}>
                                  下載
                                </button>

                                <button
                                  className="rounded border border-red-200 text-red-700 px-3 py-1.5 text-sm hover:bg-red-50 disabled:opacity-50"
                                  onClick={() => deleteAttachment(a)}
                                  disabled={deletingAttachmentId === a.id}
                                >
                                  {deletingAttachmentId === a.id ? '刪除中…' : '刪除'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="text-[11px] text-gray-500">附件為私有儲存，下載使用簽名連結（有效 60 秒）。</div>
                    </div>
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

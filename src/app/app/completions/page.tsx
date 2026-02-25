'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import PageHeader from '../_components/PageHeader'
import { supabase } from '@/lib/supabaseClient'

type Role = 'admin' | 'manager' | 'member'
type Scope = 'all' | 'me'
type TabKey = 'tasks' | 'projects'

type OrgMember = {
  org_id: string
  role: Role
  is_active: boolean
  created_at?: string
}

type TaskCompletionRow = {
  task_id: string
  org_id: string
  project_id: string
  project_name: string
  task_description: string
  assignee_user_id: string | null
  assignee_name: string | null
  status: 'done'
  expected_finish_at: string | null
  completed_at: string | null
  created_at: string
}

type ProjectCompletionRow = {
  project_id: string
  org_id: string
  project_name: string
  project_description: string | null
  priority: string | null
  status: 'completed'
  target_due_date: string | null
  created_at: string
  total_tasks: number
  done_tasks: number
  completion_rate_percent: number
  last_task_completed_at: string | null
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ')
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '-'
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

function isMissingTableError(e: any) {
  const msg = (e?.message ?? '').toLowerCase()
  return msg.includes('could not find the table') || msg.includes('schema cache') || msg.includes('pgrst105')
}

function pickMembership(mems: OrgMember[]) {
  const supervisors = mems.filter((m) => m.role === 'admin' || m.role === 'manager')
  const list = supervisors.length > 0 ? supervisors : mems

  const sorted = [...list].sort((a, b) => {
    const aa = a.created_at ? String(a.created_at) : ''
    const bb = b.created_at ? String(b.created_at) : ''
    return bb.localeCompare(aa)
  })
  return sorted[0]
}

export default function HistoryPage() {
  const [loading, setLoading] = useState(true)
  const [querying, setQuerying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('member')
  const isSupervisor = role === 'admin' || role === 'manager'

  const [tab, setTab] = useState<TabKey>('tasks')

  // filters
  const [scope, setScope] = useState<Scope>('me')
  const [kw, setKw] = useState('')
  const [fromDate, setFromDate] = useState('') // yyyy-mm-dd
  const [toDate, setToDate] = useState('') // yyyy-mm-dd

  // data
  const [taskRows, setTaskRows] = useState<TaskCompletionRow[]>([])
  const [projectRows, setProjectRows] = useState<ProjectCompletionRow[]>([])

  // init
  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      setError(null)
      try {
        const { data: userRes } = await supabase.auth.getUser()
        const user = userRes.user
        if (!user) throw new Error('請先登入')
        if (cancelled) return

        setUserId(user.id)

        const { data: mems, error: memErr } = await supabase
          .from('org_members')
          .select('org_id, role, is_active, created_at')
          .eq('user_id', user.id)
          .eq('is_active', true)

        if (memErr) throw memErr
        if (!mems || mems.length === 0) throw new Error('找不到 org_members（請確認已加入組織且 is_active=true）')

        const mem = pickMembership(mems as OrgMember[])
        if (!mem?.org_id) throw new Error('找不到 org_id')

        setOrgId(mem.org_id)
        setRole(mem.role)

        // 預設 scope：主管可看 all，成員只能 me
        if (mem.role === 'admin' || mem.role === 'manager') setScope('all')
        else setScope('me')
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
  }, [])

  // 執行查詢
  async function runQuery() {
    if (!orgId || !userId) return
    setQuerying(true)
    setError(null)

    try {
      // ✅ 成員不可切 all（UI + 邏輯一起鎖）
      const effScope: Scope = isSupervisor ? scope : 'me'
      const kw2 = kw.trim().toLowerCase()

      if (tab === 'tasks') {
        let q = supabase
          .from('v_task_completion')
          .select(
            'task_id, org_id, project_id, project_name, task_description, assignee_user_id, assignee_name, status, expected_finish_at, completed_at, created_at'
          )
          .eq('org_id', orgId)

        if (effScope === 'me') {
          q = q.eq('assignee_user_id', userId)
        }

        if (fromDate) q = q.gte('completed_at', `${fromDate}T00:00:00.000Z`)
        if (toDate) q = q.lte('completed_at', `${toDate}T23:59:59.999Z`)

        const { data, error } = await q.order('completed_at', { ascending: false })
        if (error) {
          if (isMissingTableError(error)) {
            throw new Error("找不到 v_task_completion（請先建立 view：v_task_completion）")
          }
          throw error
        }

        let rows = ((data ?? []) as TaskCompletionRow[])
        if (kw2) {
          rows = rows.filter((r) => {
            return (
              (r.task_description ?? '').toLowerCase().includes(kw2) ||
              (r.project_name ?? '').toLowerCase().includes(kw2) ||
              (r.assignee_name ?? '').toLowerCase().includes(kw2)
            )
          })
        }

        setTaskRows(rows)
      } else {
        // projects tab
        let q = supabase
          .from('v_project_completion')
          .select(
            'project_id, org_id, project_name, project_description, priority, status, target_due_date, created_at, total_tasks, done_tasks, completion_rate_percent, last_task_completed_at'
          )
          .eq('org_id', orgId)
          .order('created_at', { ascending: false })

        const { data, error } = await q
        if (error) {
          if (isMissingTableError(error)) {
            throw new Error("找不到 v_project_completion（請先建立 view：v_project_completion）")
          }
          throw error
        }

        let rows = ((data ?? []) as ProjectCompletionRow[])

        // ✅ scope=me：只顯示「自己有被指派過任務」的專案（統一使用 effScope）
        if (effScope === 'me') {
          const { data: myTasks, error: tErr } = await supabase
            .from('project_tasks')
            .select('project_id')
            .eq('org_id', orgId)
            .eq('assignee_user_id', userId)

          if (tErr) throw tErr

          const myProjectIds = new Set((myTasks ?? []).map((x: any) => x.project_id).filter(Boolean))
          rows = rows.filter((p) => myProjectIds.has(p.project_id))
        }

        // 日期篩選（以最後一個任務完成時間 last_task_completed_at 做區間）
        if (fromDate) {
          const fromIso = new Date(`${fromDate}T00:00:00.000Z`).getTime()
          rows = rows.filter((r) => {
            if (!r.last_task_completed_at) return false
            return new Date(r.last_task_completed_at).getTime() >= fromIso
          })
        }
        if (toDate) {
          const toIso = new Date(`${toDate}T23:59:59.999Z`).getTime()
          rows = rows.filter((r) => {
            if (!r.last_task_completed_at) return false
            return new Date(r.last_task_completed_at).getTime() <= toIso
          })
        }

        if (kw2) {
          rows = rows.filter((r) => {
            return (
              (r.project_name ?? '').toLowerCase().includes(kw2) ||
              (r.project_description ?? '').toLowerCase().includes(kw2)
            )
          })
        }

        setProjectRows(rows)
      }
    } catch (e: any) {
      setError(e?.message ?? '查詢失敗')
    } finally {
      setQuerying(false)
    }
  }

  // ✅ 改：切 tab / scope / 條件後自動重查（避免按鈕才更新）
  useEffect(() => {
    if (!loading && orgId && userId) {
      runQuery()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, orgId, userId, tab, scope, fromDate, toDate])

  const scopeLocked = !isSupervisor // 成員鎖定只看自己

  const summaryText = useMemo(() => {
    if (tab === 'tasks') return `共 ${taskRows.length} 筆任務完成`
    return `共 ${projectRows.length} 筆專案結案（顯示完成率）`
  }, [tab, taskRows.length, projectRows.length])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="完成中心"
          description="分頁管理：任務完成（project_tasks done）與專案完成進度（projects completed + 任務完成率）。"
        />

        <div className="flex gap-2">
          <Link href="/app/projects" className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
            返回專案
          </Link>
          <button
            className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            onClick={runQuery}
            disabled={querying || loading}
          >
            {querying ? '查詢中…' : '重新整理'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="font-semibold">發生問題</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {/* Tabs + Scope */}
      <div className="rounded border bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => setTab('tasks')}
              className={cn('rounded px-4 py-2 text-sm border', tab === 'tasks' ? 'bg-black text-white border-black' : 'hover:bg-gray-50')}
            >
              任務完成
            </button>
            <button
              onClick={() => setTab('projects')}
              className={cn('rounded px-4 py-2 text-sm border', tab === 'projects' ? 'bg-black text-white border-black' : 'hover:bg-gray-50')}
            >
              專案完成進度
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-xs text-gray-500">範圍：</div>
            <button
              onClick={() => setScope('all')}
              disabled={scopeLocked}
              className={cn(
                'rounded px-3 py-1.5 text-sm border',
                scope === 'all' ? 'bg-black text-white border-black' : 'hover:bg-gray-50',
                scopeLocked && 'opacity-50 cursor-not-allowed'
              )}
              title={scopeLocked ? '一般成員僅能查看自己' : '查看全組織'}
            >
              全組織
            </button>
            <button
              onClick={() => setScope('me')}
              className={cn('rounded px-3 py-1.5 text-sm border', scope === 'me' ? 'bg-black text-white border-black' : 'hover:bg-gray-50')}
            >
              只看自己
            </button>

            <button onClick={runQuery} className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50" disabled={querying || loading}>
              查詢
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 space-y-1">
            <div className="text-xs text-gray-500">搜尋（{tab === 'tasks' ? '任務內容/專案/人員' : '專案名稱/說明'}）</div>
            <input className="w-full rounded border px-3 py-2 text-sm" placeholder="輸入關鍵字" value={kw} onChange={(e) => setKw(e.target.value)} />
            <div className="text-[11px] text-gray-500">提示：輸入關鍵字後，按「查詢」才會更新（避免每打一個字就打 API）。</div>
          </div>

          <div className="md:col-span-3 space-y-1">
            <div className="text-xs text-gray-500">完成日起（含）</div>
            <input type="date" className="w-full rounded border px-3 py-2 text-sm" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>

          <div className="md:col-span-3 space-y-1">
            <div className="text-xs text-gray-500">完成日迄（含）</div>
            <input type="date" className="w-full rounded border px-3 py-2 text-sm" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>

        <div className="text-xs text-gray-500">
          你的權限：<span className="font-mono">{role}</span> · {summaryText}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="rounded border bg-white p-8 text-center text-sm text-gray-600">載入中…</div>
      ) : tab === 'tasks' ? (
        <div className="rounded border bg-white overflow-auto">
          <table className="min-w-[980px] w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr className="text-left">
                <th className="py-2 px-3">完成日</th>
                <th className="py-2 px-3">專案</th>
                <th className="py-2 px-3">任務</th>
                <th className="py-2 px-3">人員</th>
                <th className="py-2 px-3">預估完成</th>
              </tr>
            </thead>
            <tbody>
              {taskRows.length === 0 ? (
                <tr>
                  <td className="py-6 px-3 text-gray-600" colSpan={5}>
                    沒有任務完成資料
                  </td>
                </tr>
              ) : (
                taskRows.map((r) => (
                  <tr key={r.task_id} className="border-b">
                    <td className="py-2 px-3">{fmtDate(r.completed_at)}</td>
                    <td className="py-2 px-3">
                      <div className="font-medium">{r.project_name}</div>
                      <div className="text-[11px] text-gray-500 font-mono">{r.project_id.slice(0, 8)}</div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="break-words">{r.task_description}</div>
                      <div className="text-[11px] text-gray-500 font-mono">{r.task_id.slice(0, 8)}</div>
                    </td>
                    <td className="py-2 px-3">{r.assignee_name ?? '-'}</td>
                    <td className="py-2 px-3">{fmtDate(r.expected_finish_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3">
          {projectRows.length === 0 ? (
            <div className="rounded border bg-white p-6 text-sm text-gray-600">沒有專案結案資料</div>
          ) : (
            projectRows.map((p) => (
              <div key={p.project_id} className="rounded border bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{p.project_name}</div>
                    <div className="text-xs text-gray-600 mt-1 line-clamp-2">{p.project_description ?? '-'}</div>
                    <div className="mt-2 text-xs text-gray-500 flex flex-wrap gap-3">
                      <span>目標日：{fmtDate(p.target_due_date)}</span>
                      <span>最後完成：{fmtDate(p.last_task_completed_at)}</span>
                      <span className="font-mono">{p.project_id.slice(0, 8)}</span>
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-xs text-gray-500">任務完成率</div>
                    <div className="text-lg font-semibold">{p.completion_rate_percent}%</div>
                    <div className="text-xs text-gray-600">
                      {p.done_tasks} / {p.total_tasks} done
                    </div>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="h-2 w-full rounded bg-gray-100 overflow-hidden">
                    <div className="h-2 bg-black" style={{ width: `${Math.max(0, Math.min(100, p.completion_rate_percent || 0))}%` }} />
                  </div>
                </div>

                <div className="mt-3 flex justify-end">
                  <Link href={`/app/projects/${p.project_id}`} className="text-sm underline text-gray-800">
                    進入詳情
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
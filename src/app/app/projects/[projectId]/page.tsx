import Link from 'next/link'
import PageHeader from '../../_components/PageHeader'
import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * ✅ 調整重點：
 * 1) 主管權限才能進入（admin / manager）
 * 2) 取消審核機制：移除「待審核」「前往主管審核」相關內容
 * 3) 詳情頁定位：專案概覽 + 指派/追蹤任務（導到 issues / members / settings）
 */

type OrgMemberRole = 'admin' | 'manager' | 'member'

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  // ---- Supabase server client (Next.js App Router) ----
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll() {
          // 這個頁面不需要在 RSC 內 set cookie
          // 若未來要做 refresh token，可改用 middleware 或 route handler
        },
      },
    }
  )

  // ---- Auth check ----
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // ---- Role check (org_members) ----
  const { data: mem, error: memErr } = await supabase
    .from('org_members')
    .select('org_id, role, is_active')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle<{ org_id: string; role: OrgMemberRole; is_active: boolean }>()

  if (memErr) {
    // 直接導回 /app 並用 query 帶錯（你也可改成 error page）
    redirect('/app?error=org_members_read_failed')
  }

  if (!mem?.org_id) {
    redirect('/app?error=missing_org')
  }

  const isSupervisor = mem.role === 'admin' || mem.role === 'manager'
  if (!isSupervisor) {
    redirect('/app?error=forbidden')
  }

  // ---- Optional: ensure project belongs to same org (避免猜 ID) ----
  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select('id, org_id, name, description, status, priority, target_due_date, created_at')
    .eq('id', projectId)
    .eq('org_id', mem.org_id)
    .maybeSingle<{
      id: string
      org_id: string
      name: string
      description: string | null
      status: string
      priority: string
      target_due_date: string | null
      created_at: string
    }>()

  if (pErr) {
    redirect('/app/projects?error=project_read_failed')
  }
  if (!project?.id) {
    redirect('/app/projects?error=project_not_found')
  }

  const tabs = [
    { href: `/app/projects/${projectId}`, label: '概覽' },
    { href: `/app/projects/${projectId}/issues`, label: '任務' },
    { href: `/app/projects/${projectId}/members`, label: '成員' },
    { href: `/app/projects/${projectId}/settings`, label: '設定' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="專案詳情（主管專用）"
        description="專案概覽、任務指派與追蹤、成員與設定。已取消審核流程。"
      />

      <div className="rounded border bg-white p-3 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="rounded border px-3 py-2 text-sm hover:bg-gray-50"
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="rounded border bg-white p-4 space-y-3 lg:col-span-2">
          <div className="text-sm font-semibold">概覽</div>

          <div className="rounded border bg-gray-50 p-3">
            <div className="text-xs text-gray-500">專案名稱</div>
            <div className="mt-1 font-medium">{project.name}</div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3 text-sm">
              <div className="md:col-span-4">
                <div className="text-xs text-gray-500">狀態</div>
                <div className="mt-1">{project.status}</div>
              </div>
              <div className="md:col-span-4">
                <div className="text-xs text-gray-500">優先級</div>
                <div className="mt-1">{project.priority}</div>
              </div>
              <div className="md:col-span-4">
                <div className="text-xs text-gray-500">目標日期</div>
                <div className="mt-1">{project.target_due_date?.slice(0, 10) ?? '-'}</div>
              </div>
            </div>

            <div className="mt-3 text-xs text-gray-500">專案說明</div>
            <div className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">
              {project.description ?? '-'}
            </div>
          </div>

          <div className="text-sm text-gray-700">
            下一步可在此接：
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1 mt-2">
              <li>v_project_summary 的彙總欄位（open/blocked/overdue 等）</li>
              <li>issues（任務）聚合：未完成 / 逾期 / 卡關</li>
              <li>近期活動（activity log）</li>
            </ul>
          </div>

          <div className="text-xs text-gray-500 font-mono">
            projectId: {projectId}
          </div>
        </section>

        <aside className="rounded border bg-white p-4 space-y-2">
          <div className="text-sm font-semibold">快捷操作</div>
          <div className="flex flex-col gap-2">
            <Link
              className="rounded bg-black text-white px-3 py-2 text-sm text-center"
              href={`/app/projects/${projectId}/issues`}
            >
              前往任務指派 / 追蹤
            </Link>

            <Link
              className="rounded border px-3 py-2 text-sm text-center hover:bg-gray-50"
              href={`/app/projects/${projectId}/members`}
            >
              管理成員
            </Link>

            <Link
              className="rounded border px-3 py-2 text-sm text-center hover:bg-gray-50"
              href={`/app/projects/${projectId}/settings`}
            >
              專案設定
            </Link>

            <Link
              className="rounded border px-3 py-2 text-sm text-center hover:bg-gray-50"
              href={`/app/projects`}
            >
              返回專案列表
            </Link>
          </div>

          <div className="mt-3 text-[11px] text-gray-500">
            此頁已做：登入檢查 → org_members 主管角色檢查 → 專案 org 驗證（避免猜測 projectId）。
          </div>
        </aside>
      </div>
    </div>
  )
}

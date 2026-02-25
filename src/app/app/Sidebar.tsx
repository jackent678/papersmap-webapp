'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import {
  LayoutDashboard,
  FolderKanban,
  CheckSquare,
  Calendar,
  Settings,
  Users,
  Shield,
  Bug,
  LogOut,
  ChevronRight,
  Menu,
  CheckCircle2,
} from 'lucide-react'

type Role = 'admin' | 'manager' | 'member'

function cn(...classes: (string | boolean | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

function getRoleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return '系統管理員'
    case 'manager':
      return '主管'
    default:
      return '一般成員'
  }
}

function getRoleBadgeColor(role: Role): string {
  switch (role) {
    case 'admin':
      return 'bg-purple-50 text-purple-700 ring-1 ring-purple-200'
    case 'manager':
      return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
    default:
      return 'bg-gray-50 text-gray-700 ring-1 ring-gray-200'
  }
}

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  exact?: boolean
  badge?: string
}

function getNavBadgeColor(badge: string) {
  // ✅ badge 顏色依 badge 本身決定
  if (badge === '管理員') return 'bg-purple-50 text-purple-700'
  if (badge === '主管') return 'bg-blue-50 text-blue-700'
  if (badge === '除錯') return 'bg-amber-50 text-amber-800'
  return 'bg-gray-50 text-gray-700'
}

export default function Sidebar() {
  const pathname = usePathname()

  const [email, setEmail] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('member')
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const isSupervisor = role === 'admin' || role === 'manager'

  // 導航項目定義（包含圖示）
  const navItems = useMemo<NavItem[]>(() => {
    const base: NavItem[] = [
      { href: '/app', label: '儀表板', icon: LayoutDashboard, exact: true },
      { href: '/app/issues', label: '任務管理', icon: CheckSquare },
      { href: '/app/plans', label: '日程計畫', icon: Calendar },
    ]

    // ✅ 完成中心：全員可見（一般成員只能在頁內看到自己的資料，由 RLS / HistoryPage scope 控制）
    const completionItem: NavItem = {
      href: '/app/completions', // ←如果你頁面不是這個路徑，改這行
      label: '完成中心',
      icon: CheckCircle2,
      badge: isSupervisor ? '主管' : '',
    }

    // 主管專用項目
    const supervisorItems: NavItem[] = isSupervisor
      ? [
          { href: '/app/projects', label: '專案管理', icon: FolderKanban, badge: '主管' },
          { href: '/app/manager', label: '主管中心', icon: Users, badge: '主管' },
        ]
      : []

    // 管理員專用項目
    const adminItems: NavItem[] =
      role === 'admin'
        ? [
            { href: '/app/admin', label: '系統設定', icon: Shield, badge: '管理員' },
            { href: '/app/debug', label: '開發工具', icon: Bug, badge: '除錯' },
          ]
        : []

    const accountItem: NavItem = { href: '/app/account', label: '帳號設定', icon: Settings }

    return [...base, completionItem, ...supervisorItems, ...adminItems, accountItem]
  }, [isSupervisor, role])

  useEffect(() => {
    let isMounted = true

    async function loadUserData() {
      setLoading(true)
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (!isMounted) return

        setEmail(user?.email ?? null)

        // ✅ 讀取註冊時填的名稱（Auth user_metadata）
        const meta: any = user?.user_metadata || {}
        const nameFromMeta = meta.full_name || meta.name || meta.display_name || meta.username || null
        setDisplayName(nameFromMeta)

        if (user?.id) {
          const { data, error } = await supabase
            .from('org_members')
            .select('role')
            .eq('user_id', user.id)
            .eq('is_active', true)

          if (!error && data && data.length > 0) {
            const roles = data.map((r: any) => r.role)
            const finalRole: Role = roles.includes('admin')
              ? 'admin'
              : roles.includes('manager')
              ? 'manager'
              : 'member'

            if (isMounted) setRole(finalRole)
          } else {
            if (isMounted) setRole('member')
          }
        }
      } catch (error) {
        console.error('Failed to load user data:', error)
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadUserData()
    return () => {
      isMounted = false
    }
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const isLinkActive = (item: NavItem): boolean => {
    if (item.exact) return pathname === item.href
    return pathname.startsWith(item.href)
  }

  const displayText = displayName || (email ? email.split('@')[0] : '訪客')

  return (
    <>
      {/* 行動版折疊按鈕 */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="lg:hidden fixed top-4 left-4 z-50 rounded-lg border border-gray-200 bg-white p-2 shadow-sm"
      >
        <Menu className="h-5 w-5 text-gray-600" />
      </button>

      {/* 側邊欄 */}
      <aside
        className={cn(
          'fixed lg:static inset-y-0 left-0 z-40',
          'flex flex-col border-r border-gray-200 bg-white',
          'transition-all duration-300 ease-in-out',
          collapsed ? '-translate-x-full lg:translate-x-0' : 'translate-x-0',
          'w-72'
        )}
      >
        {/* Logo 區域 */}
        <div className="flex h-20 items-center justify-between border-b border-gray-100 px-6">
          <div>
            <Link href="/app" className="text-xl font-semibold tracking-tight text-gray-900">
              巨大數據科技
            </Link>

            <div className="mt-0.5 flex items-center gap-2">
              {loading ? (
                <div className="h-4 w-24 animate-pulse rounded bg-gray-200" />
              ) : (
                <>
                  <span className="text-xs text-gray-500">{displayText}</span>
                  <ChevronRight className="h-3 w-3 text-gray-400" />
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', getRoleBadgeColor(role))}>
                    {getRoleLabel(role)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 導航連結 */}
        <nav className="flex-1 overflow-y-auto px-4 py-6">
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = isLinkActive(item)
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-lg px-4 py-3',
                    'text-sm font-medium transition-all duration-200',
                    'hover:bg-gray-50',
                    active ? 'bg-gray-900 text-white shadow-sm hover:bg-gray-800' : 'text-gray-700 hover:text-gray-900'
                  )}
                >
                  <Icon className={cn('h-5 w-5 transition-colors', active ? 'text-white' : 'text-gray-400 group-hover:text-gray-600')} />
                  <span className="flex-1">{item.label}</span>

                  {item.badge && !active && (
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', getNavBadgeColor(item.badge))}>
                      {item.badge}
                    </span>
                  )}

                  {active && <span className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r-full bg-white" />}
                </Link>
              )
            })}
          </div>

          <div className="my-6 border-t border-gray-100" />

          <div className="rounded-lg bg-gray-50 p-4">
            <h4 className="text-xs font-medium text-gray-500">快捷提示</h4>
            <p className="mt-2 text-xs text-gray-600">
              {isSupervisor ? '您有權限管理專案和團隊成員。' : '您可以查看被指派的任務和個人計畫。'}
            </p>
          </div>
        </nav>

        {/* 底部登出區域 */}
        <div className="border-t border-gray-100 p-4">
          <button
            onClick={handleSignOut}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-4 py-3',
              'text-sm font-medium text-gray-700 transition-all',
              'hover:bg-gray-50 hover:text-gray-900',
              'group'
            )}
          >
            <LogOut className="h-5 w-5 text-gray-400 transition-colors group-hover:text-gray-600" />
            <span>登出系統</span>
          </button>

          <div className="mt-2 px-4 text-[10px] text-gray-400">v2.1.0 · © 2024</div>
        </div>
      </aside>

      {!collapsed && (
        <div className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm lg:hidden" onClick={() => setCollapsed(true)} />
      )}
    </>
  )
}
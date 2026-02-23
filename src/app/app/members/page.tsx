"use client";

import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/app/_components/PageHeader";
import { supabase } from "@/lib/supabaseClient";

type OrgRole = "admin" | "manager" | "member";

type Membership = {
  org_id: string;
  role: OrgRole;
  is_active: boolean;
};

type OrgMemberRow = {
  org_id: string;
  user_id: string;
  role: OrgRole;
  is_active: boolean;
  joined_at?: string | null;
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  email: string | null;
};

type MemberVM = {
  org_id: string;
  user_id: string;
  role: OrgRole;
  is_active: boolean;
  joined_at?: string | null;
  display_name: string;
  email: string | null;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function buildLabel(name?: string | null, email?: string | null, userId?: string | null) {
  const n = (name ?? "").trim();
  const e = (email ?? "").trim();
  if (n && e) return `${n}（${e}）`;
  if (n) return n;
  if (e) return e;
  if (userId) return userId.slice(0, 8);
  return "未知使用者";
}

export default function MembersAdminPage() {
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState<string | null>(null);

  // 多 org 兼容：列出自己的 memberships，能切 org 管理
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<OrgRole>("member");

  const isSupervisor = myRole === "admin" || myRole === "manager";

  // 成員清單
  const [members, setMembers] = useState<MemberVM[]>([]);
  const [q, setQ] = useState("");

  async function loadMemberships() {
    const { data: ures } = await supabase.auth.getUser();
    const u = ures.user;
    if (!u) throw new Error("尚未登入");
    setUserId(u.id);

    const { data: mems, error: memErr } = await supabase
      .from("org_members")
      .select("org_id, role, is_active")
      .eq("user_id", u.id)
      .eq("is_active", true);

    if (memErr) throw memErr;

    const list = (mems ?? []) as Membership[];
    setMemberships(list);

    // 預設選第一個（你也可以改成記錄 localStorage）
    const first = list[0];
    if (!first?.org_id) throw new Error("找不到 org_members（請確認註冊 trigger 有把你加入預設 org，且 is_active=true）");

    setOrgId(first.org_id);
    setMyRole(first.role);
    return { user: u, picked: first, all: list };
  }

  async function loadMembers(targetOrgId: string) {
    // 1) org_members
    const { data: om, error: omErr } = await supabase
      .from("org_members")
      .select("org_id, user_id, role, is_active, joined_at")
      .eq("org_id", targetOrgId)
      .order("joined_at", { ascending: true });

    if (omErr) throw omErr;

    const orgRows = (om ?? []) as OrgMemberRow[];

    // 2) profiles 補 display_name / email
    const ids = orgRows.map((r) => r.user_id).filter(Boolean);
    const { data: profs, error: pErr } = await supabase
      .from("profiles")
      .select("id, display_name, email")
      .in("id", ids);

    // profiles 讀不到也不要讓整頁掛掉（RLS/資料不齊）
    const pMap = new Map<string, ProfileRow>();
    if (!pErr && Array.isArray(profs)) {
      for (const p of profs as any[]) {
        if (p?.id) pMap.set(p.id, { id: p.id, display_name: p.display_name ?? null, email: p.email ?? null });
      }
    }

    const vm: MemberVM[] = orgRows.map((r) => {
      const p = pMap.get(r.user_id);
      const label = buildLabel(p?.display_name ?? null, p?.email ?? null, r.user_id);
      return {
        ...r,
        display_name: label,
        email: p?.email ?? null,
      };
    });

    setMembers(vm);
  }

  async function refresh(targetOrgId?: string) {
    if (!targetOrgId && !orgId) return;
    const oid = targetOrgId ?? orgId!;
    setError(null);
    await loadMembers(oid);
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const { picked } = await loadMemberships();
        if (cancelled) return;

        // 只有主管可進
        if (picked.role !== "admin" && picked.role !== "manager") {
          setLoading(false);
          return;
        }

        await loadMembers(picked.org_id);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "載入失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return members;
    return members.filter((m) => {
      const s = `${m.display_name} ${m.email ?? ""} ${m.user_id}`.toLowerCase();
      return s.includes(kw);
    });
  }, [members, q]);

  const activeAdminCount = useMemo(() => {
    return members.filter((m) => m.is_active && m.role === "admin").length;
  }, [members]);

  async function onSwitchOrg(nextOrgId: string) {
    // 找到自己的 membership role
    const mem = memberships.find((m) => m.org_id === nextOrgId);
    if (!mem) return;

    setOrgId(nextOrgId);
    setMyRole(mem.role);

    setError(null);
    setLoading(true);
    try {
      if (mem.role !== "admin" && mem.role !== "manager") {
        setMembers([]);
        return;
      }
      await loadMembers(nextOrgId);
    } catch (e: any) {
      setError(e?.message ?? "切換組織失敗");
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(targetUserId: string, nextRole: OrgRole) {
    if (!orgId) return;
    if (!isSupervisor) return;

    // 避免把「唯一 admin」降級
    const target = members.find((m) => m.user_id === targetUserId);
    if (target?.role === "admin" && target.is_active && activeAdminCount <= 1 && nextRole !== "admin") {
      setError("此組織目前只有 1 位 admin，不能將唯一 admin 降級。");
      return;
    }

    setBusyUserId(targetUserId);
    setError(null);

    try {
      const { error: uErr } = await supabase
        .from("org_members")
        .update({ role: nextRole })
        .eq("org_id", orgId)
        .eq("user_id", targetUserId);

      if (uErr) throw uErr;

      await refresh(orgId);
    } catch (e: any) {
      setError(e?.message ?? "更新角色失敗（請檢查 RLS policy）");
    } finally {
      setBusyUserId(null);
    }
  }

  async function toggleActive(targetUserId: string) {
    if (!orgId) return;
    if (!isSupervisor) return;

    // 不允許自己把自己停用（避免鎖死）
    if (targetUserId === userId) {
      setError("不能停用自己（避免把自己鎖在系統外）。");
      return;
    }

    const target = members.find((m) => m.user_id === targetUserId);
    if (!target) return;

    // 避免停用唯一 admin
    if (target.role === "admin" && target.is_active && activeAdminCount <= 1) {
      setError("此組織目前只有 1 位 admin，不能停用唯一 admin。");
      return;
    }

    setBusyUserId(targetUserId);
    setError(null);

    try {
      const { error: uErr } = await supabase
        .from("org_members")
        .update({ is_active: !target.is_active })
        .eq("org_id", orgId)
        .eq("user_id", targetUserId);

      if (uErr) throw uErr;

      await refresh(orgId);
    } catch (e: any) {
      setError(e?.message ?? "更新狀態失敗（請檢查 RLS policy）");
    } finally {
      setBusyUserId(null);
    }
  }

  // 非主管直接擋
  if (!loading && !isSupervisor) {
    return (
      <div className="space-y-4">
        <PageHeader title="成員管理" description="此頁僅限 admin / manager 使用。" />
        <div className="rounded border bg-white p-6 text-sm text-gray-700">
          無權限進入。你的角色為 <span className="font-mono">{myRole}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title="成員管理" description="管理同組織成員：改角色、停用/啟用（open_signup 模式）。" />

        <button
          className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
          onClick={() => refresh()}
          disabled={loading || !orgId}
        >
          重新整理
        </button>
      </div>

      {/* org 切換（多 org 兼容） */}
      {memberships.length > 1 && (
        <div className="rounded border bg-white p-4">
          <div className="text-sm font-semibold">切換組織</div>
          <div className="mt-2">
            <select
              className="w-full rounded border px-3 py-2 text-sm"
              value={orgId ?? ""}
              onChange={(e) => onSwitchOrg(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.org_id} value={m.org_id}>
                  {m.org_id.slice(0, 8)}（{m.role}）
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 text-xs text-gray-500">提示：不同 org 的成員清單不同；指派下拉也會依 org 變動。</div>
        </div>
      )}

      {/* 搜尋 */}
      <div className="rounded border bg-white p-4">
        <div className="text-xs text-gray-500">搜尋（姓名/Email/user_id）</div>
        <input
          className="mt-1 w-full rounded border px-3 py-2 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入關鍵字"
        />
        <div className="mt-2 text-xs text-gray-500">
          你的角色：<span className="font-mono">{myRole}</span>　｜　Active Admin 數：{activeAdminCount}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="font-semibold">發生問題</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="rounded border bg-white p-4 text-sm text-gray-600">載入中…</div>
      ) : (
        <div className="rounded border bg-white overflow-hidden">
          <div className="px-4 py-3 border-b text-sm font-semibold">成員列表（{filtered.length}）</div>

          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left">
                  <th className="p-3">姓名</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">角色</th>
                  <th className="p-3">狀態</th>
                  <th className="p-3">user_id</th>
                  <th className="p-3 text-right">操作</th>
                </tr>
              </thead>

              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td className="p-4 text-gray-600" colSpan={6}>
                      沒有資料
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => {
                    const isBusy = busyUserId === m.user_id;
                    const isSelf = m.user_id === userId;

                    return (
                      <tr key={m.user_id} className="border-t">
                        <td className="p-3 font-medium">{m.display_name}</td>
                        <td className="p-3 text-gray-700">{m.email ?? "-"}</td>

                        <td className="p-3">
                          <select
                            className={cn("rounded border px-2 py-1.5 text-sm", isBusy && "opacity-50")}
                            value={m.role}
                            disabled={isBusy}
                            onChange={(e) => changeRole(m.user_id, e.target.value as OrgRole)}
                            title={isSelf ? "你可以改自己的角色，但請小心" : "變更角色"}
                          >
                            <option value="admin">admin</option>
                            <option value="manager">manager</option>
                            <option value="member">member</option>
                          </select>
                        </td>

                        <td className="p-3">
                          <span
                            className={cn(
                              "inline-flex items-center rounded border px-2 py-1 text-xs",
                              m.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-700 border-gray-200"
                            )}
                          >
                            {m.is_active ? "啟用" : "停用"}
                          </span>
                        </td>

                        <td className="p-3 font-mono text-xs text-gray-600">{m.user_id}</td>

                        <td className="p-3 text-right">
                          <button
                            className={cn(
                              "rounded border px-3 py-1.5 text-sm hover:bg-gray-50",
                              (isBusy || isSelf) && "opacity-50 cursor-not-allowed"
                            )}
                            onClick={() => toggleActive(m.user_id)}
                            disabled={isBusy || isSelf}
                            title={isSelf ? "不可停用自己" : "切換啟用/停用"}
                          >
                            {m.is_active ? "停用" : "啟用"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t text-[11px] text-gray-500">
            規則：只有 admin/manager 可操作；不可停用自己；不可停用/降級唯一 admin（避免鎖死）。
          </div>
        </div>
      )}
    </div>
  );
}
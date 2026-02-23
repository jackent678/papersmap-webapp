"use client";

import { useEffect, useState } from "react";
import PageHeader from "../../_components/PageHeader";
import { supabase } from "@/lib/supabaseClient";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function ProfileSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setMsg(null);

    const { data: ures } = await supabase.auth.getUser();
    const u = ures.user;

    if (!u) {
      setMsg("尚未登入");
      setLoading(false);
      return;
    }

    setUserId(u.id);
    setEmail(u.email ?? null);

    const { data, error } = await supabase
      .from("profiles")
      .select("display_name, email")
      .eq("id", u.id)
      .maybeSingle();

    if (error) {
      setMsg(`讀取 profiles 失敗：${error.message}`);
      setLoading(false);
      return;
    }

    setDisplayName((data?.display_name ?? "").toString());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!userId) return;

    const next = displayName.trim();
    if (!next) {
      setMsg("顯示名稱不可為空");
      return;
    }

    setSaving(true);
    setMsg(null);

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: next })
        .eq("id", userId);

      if (error) throw error;

      setMsg("已更新顯示名稱");
    } catch (e: any) {
      setMsg(e?.message ?? "更新失敗（請檢查 profiles RLS policy）");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="個人設定" description="修改你的顯示名稱（display_name），用於指派下拉與各處顯示。" />

      {msg && (
        <div className={cn("rounded border p-4 text-sm", msg.includes("已更新") ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-700")}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="rounded border bg-white p-4 text-sm text-gray-600">載入中…</div>
      ) : (
        <div className="rounded border bg-white p-6 space-y-4">
          <div className="text-sm text-gray-700">
            <div className="text-xs text-gray-500">帳號</div>
            <div className="mt-1 font-mono">{email ?? "-"}</div>
          </div>

          <div>
            <div className="text-xs text-gray-500">顯示名稱（display_name）</div>
            <input
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如：張小儷"
            />
            <div className="mt-2 text-[11px] text-gray-500">
              建議用真實姓名或公司慣用稱呼；修改後，指派下拉會以新的顯示名稱呈現。
            </div>
          </div>

          <div className="flex gap-2">
            <button
              className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={load}
              disabled={saving}
            >
              重新載入
            </button>
            <button
              className="rounded bg-black text-white px-4 py-2 text-sm disabled:opacity-50"
              onClick={save}
              disabled={saving || !displayName.trim()}
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
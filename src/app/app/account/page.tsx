"use client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import Sidebar from "../Sidebar";

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;

    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (!alive) return;

      if (error) {
        setMsg(error.message);
        return;
      }

      if (!data.user) {
        router.replace("/login");
        return;
      }

      setEmail(data.user.email ?? null);
    })();

    return () => {
      alive = false;
    };
  }, [router]);

  async function signOut() {
    setMsg("");
    const { error } = await supabase.auth.signOut();
    if (error) {
      setMsg(error.message);
      return;
    }
    router.replace("/login");
  }

  return (
    <div style={{ display: "flex" }}>
      <Sidebar />
      <div style={{ flex: 1, padding: 18 }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>登入/登出</div>
        <p style={{ marginTop: 10 }}>目前登入：{email ?? "-"}</p>

        <button onClick={signOut} style={{ padding: "10px 14px", cursor: "pointer" }}>
          登出
        </button>

        {msg && <p style={{ marginTop: 10, color: "#b91c1c" }}>{msg}</p>}
      </div>
    </div>
  );
}

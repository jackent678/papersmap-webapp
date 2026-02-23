"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter, useSearchParams } from "next/navigation";

export default function InviteClient() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get("token") || "";

  const [msg, setMsg] = useState("處理邀請中…");

  useEffect(() => {
    async function run() {
      const { data: u } = await supabase.auth.getUser();

      if (!u.user) {
        setMsg("請先登入後再接受邀請。");
        return;
      }

      if (!token) {
        setMsg("邀請 token 無效");
        return;
      }

      const { error } = await supabase.rpc(
        "accept_org_invite",
        { p_token: token }
      );

      if (error) {
        setMsg(`接受邀請失敗：${error.message}`);
        return;
      }

      setMsg("加入組織成功，將導向儀表板…");

      setTimeout(() => {
        router.push("/app");
      }, 800);
    }

    run();
  }, [token, router]);

  return (
    <div
      style={{
        maxWidth: 520,
        margin: "80px auto",
        padding: 24,
        fontFamily: "sans-serif",
      }}
    >
      <h2 style={{ marginTop: 0 }}>加入組織</h2>

      <p>{msg}</p>
    </div>
  );
}
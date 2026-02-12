"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [name, setName] = useState(""); // ✅ 註冊用
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");

  async function signIn() {
    setMsg("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMsg(error.message);
      return;
    }
    router.push("/app");
  }

  async function signUp() {
    setMsg("");

    // ✅ 只有註冊需要姓名
    if (!name.trim()) {
      setMsg("請輸入姓名（註冊必填）");
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: name.trim() }, // ✅ 存到 user_metadata
      },
    });

    if (error) {
      setMsg(error.message);
      return;
    }

    setMsg("註冊成功！如果你有開啟 email 驗證，請去信箱點確認後再登入。");
  }

  return (
    <div
      style={{
        maxWidth: 400,
        margin: "80px auto",
        padding: "40px 32px",
        fontFamily: "sans-serif",
        backgroundColor: "white",
        borderRadius: 24,
        boxShadow: "0 10px 25px rgba(0,0,0,0.05), 0 4px 6px rgba(0,0,0,0.02)",
        border: "1px solid #f0f0f0",
      }}
    >
      <h1
        style={{
          fontSize: 28,
          fontWeight: 600,
          marginBottom: 32,
          marginTop: 0,
          color: "#1a1a1a",
          letterSpacing: "-0.01em",
        }}
      >
        👋 歡迎回來
      </h1>

      {/* ✅ 新增：姓名（註冊用） */}
      <input
        placeholder="姓名（註冊用）"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{
          width: "100%",
          padding: "12px 16px",
          marginTop: 0,
          marginBottom: 12,
          border: "1px solid #e0e0e0",
          borderRadius: 12,
          fontSize: 15,
          outline: "none",
          transition: "all 0.2s",
          boxSizing: "border-box",
          backgroundColor: "#fafafa",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "#000";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "#e0e0e0";
        }}
      />

      <input
        placeholder="電子郵件"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{
          width: "100%",
          padding: "12px 16px",
          marginTop: 0,
          marginBottom: 12,
          border: "1px solid #e0e0e0",
          borderRadius: 12,
          fontSize: 15,
          outline: "none",
          transition: "all 0.2s",
          boxSizing: "border-box",
          backgroundColor: "#fafafa",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "#000";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "#e0e0e0";
        }}
      />

      <input
        type="password"
        placeholder="密碼"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{
          width: "100%",
          padding: "12px 16px",
          marginBottom: 24,
          border: "1px solid #e0e0e0",
          borderRadius: 12,
          fontSize: 15,
          outline: "none",
          transition: "all 0.2s",
          boxSizing: "border-box",
          backgroundColor: "#fafafa",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "#000";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "#e0e0e0";
        }}
      />

      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
        <button
          onClick={signIn}
          style={{
            flex: 1,
            padding: "12px 16px",
            cursor: "pointer",
            backgroundColor: "#000",
            color: "white",
            border: "none",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 500,
            transition: "all 0.2s",
            boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#333";
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow = "0 6px 12px rgba(0,0,0,0.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "#000";
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "0 2px 4px rgba(0,0,0,0.02)";
          }}
        >
          登入
        </button>

        <button
          onClick={signUp}
          style={{
            flex: 1,
            padding: "12px 16px",
            cursor: "pointer",
            backgroundColor: "white",
            color: "#000",
            border: "1px solid #e0e0e0",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 500,
            transition: "all 0.2s",
            background: "linear-gradient(to bottom, #ffffff, #fafafa)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#f5f5f5";
            e.currentTarget.style.borderColor = "#b0b0b0";
            e.currentTarget.style.transform = "translateY(-1px)";
            e.currentTarget.style.boxShadow = "0 6px 12px rgba(0,0,0,0.04)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "white";
            e.currentTarget.style.borderColor = "#e0e0e0";
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          註冊
        </button>
      </div>

      {msg && (
        <p
          style={{
            marginTop: 24,
            marginBottom: 0,
            padding: 14,
            backgroundColor: msg.includes("成功") ? "#f0fff4" : "#fff3f0",
            color: msg.includes("成功") ? "#0a5c2c" : "#b33a1e",
            borderRadius: 12,
            fontSize: 14,
            border: msg.includes("成功") ? "1px solid #c6f6d5" : "1px solid #ffe3e0",
            textAlign: "center",
          }}
        >
          {msg}
        </p>
      )}

      <p
        style={{
          marginTop: 20,
          marginBottom: 0,
          fontSize: 12,
          color: "#888",
          textAlign: "center",
          lineHeight: 1.6,
          padding: "8px 12px",
          backgroundColor: "#f8f8f8",
          borderRadius: 20,
          border: "1px solid #f0f0f0",
        }}
      >
        ⚡ 註冊時須KEY IN 姓名，登入時無需再輸入姓名。
      </p>
    </div>
  );
}

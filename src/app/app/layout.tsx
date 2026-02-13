import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <div style={{ fontWeight: 900 }}>客服部專案管理系統</div>

      </div>

      <div style={{ display: "flex" }}>
        {/* Sidebar 會由各頁自行引用（保持簡單，不做 Context） */}
        <div style={{ width: 50 }} />
        <div style={{ flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

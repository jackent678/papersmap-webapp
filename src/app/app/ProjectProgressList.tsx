"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  progress: Record<string, any> | null;
  created_at: string;
};

type StageKey =
  | "hardware_install"
  | "hardware_stability"
  | "software_params"
  | "ai_training"
  | "run_validation"
  | "training";

const STAGES: Array<{ key: StageKey; label: string; color: string }> = [
  { key: "hardware_install", label: "硬體安裝", color: "#3b82f6" }, // blue
  { key: "hardware_stability", label: "穩定性調整", color: "#22c55e" }, // green
  { key: "software_params", label: "軟體參數", color: "#f97316" }, // orange
  { key: "ai_training", label: "AI訓練", color: "#a855f7" }, // purple
  { key: "run_validation", label: "跑料驗證", color: "#0ea5e9" }, // sky
  { key: "training", label: "教育訓練", color: "#64748b" }, // slate
];

function clampPercent(n: any) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function getStagePercent(progress: any, key: StageKey) {
  if (!progress || typeof progress !== "object") return 0;
  return clampPercent(progress?.[key]?.percent ?? 0);
}

function getOverall(progress: any) {
  if (!progress || typeof progress !== "object") return 0;
  const avg =
    STAGES.reduce((sum, s) => sum + getStagePercent(progress, s.key), 0) /
    STAGES.length;
  return clampPercent(avg);
}

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${m}月${day}日`;
}

export default function ProjectProgressList() {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [displayName, setDisplayName] = useState<string>("");

  async function loadMeName() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);

    const user = data.user;
    if (!user) {
      setDisplayName("（未登入）");
      return;
    }

    const fallback = user.email ?? "（未命名）";
    const { data: prof, error: pErr } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .maybeSingle();

    if (pErr) throw new Error(pErr.message);
    setDisplayName((prof?.name ?? fallback).toString());
  }

  async function loadProjects() {
    const { data, error } = await supabase
      .from("projects")
      .select("id,name,description,progress,created_at")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    setProjects((data ?? []) as ProjectRow[]);
  }

  async function refresh() {
    setMsg("");
    setLoading(true);
    try {
      await Promise.all([loadMeName(), loadProjects()]);
    } catch (e: any) {
      setProjects([]);
      setMsg("❌ " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const overall = useMemo(() => (p: ProjectRow) => getOverall(p.progress), []);
  const stagePercent = useMemo(
    () => (p: ProjectRow, k: StageKey) => getStagePercent(p.progress, k),
    []
  );

  if (loading) return <div style={{ color: "#6b7280" }}>載入中...</div>;
  if (msg) return <div style={{ color: "#b91c1c" }}>{msg}</div>;
  if (projects.length === 0) return <div style={{ color: "#6b7280" }}>（尚無專案）</div>;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* 左上：顯示名稱 */}
      <div style={meLine}>
        <div style={meName}>{displayName}</div>
      </div>

      {projects.map((p) => {
        const ov = overall(p);

        return (
          <div key={p.id} style={card}>
            {/* 上半：左資訊 + 右 6 欄 */}
            <div style={topRow}>
              {/* 左側資訊 */}
              <div style={leftCol}>
                <div style={projTitle}>{p.name}</div>
                {p.description && <div style={projDesc}>{p.description}</div>}
                <div style={metaLine}>
                  <span style={metaDot} />
                  <span style={metaText}>{formatDate(p.created_at)}</span>
                </div>
              </div>

              {/* 右側六項進度 */}
              <div style={stageRail}>
                <div style={stageGrid}>
                  {STAGES.map((s) => {
                    const pct = stagePercent(p, s.key);
                    return (
                      <div key={s.key} style={stageCol} title={s.label}>
                        <div style={stageLabel}>{s.label}</div>
                        <div style={miniBarOuter}>
                          <div
                            style={{
                              ...miniBarInner,
                              width: `${pct}%`,
                              background: s.color,
                            }}
                          />
                        </div>
                        <div style={stagePct}>{pct}%</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 下半：整體完成進度 */}
            <div style={overallWrap}>
              <div style={overallHead}>
                <div style={overallLabel}>整體完成進度</div>
                <div style={overallPct}>{ov}%</div>
              </div>

              <div style={barOuter}>
                <div style={{ ...barInner, width: `${ov}%` }} />
              </div>

              <div style={overallFoot}>已完成 06 階段</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- styles（已調整：卡片更扁 + 字體放大） ---------- */

const meLine: React.CSSProperties = { marginBottom: 0 };
const meName: React.CSSProperties = {
  fontSize: 16, // ⬆️ 放大
  color: "#374151",
  fontWeight: 900,
};

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 14,
  padding: 10, // ⬇️ 原 14（卡片上下縮小最關鍵）
  background: "#fff",
};

const topRow: React.CSSProperties = {
  display: "flex",
  gap: 12, // ⬇️ 原 16（更緊湊）
  alignItems: "flex-start",
};

const leftCol: React.CSSProperties = {
  width: 190, // 可依你截圖再調：170~220
  flex: "0 0 auto",
  paddingRight: 10,
  borderRight: "1px solid #f1f5f9",
};

const projTitle: React.CSSProperties = {
  fontWeight: 900,
  fontSize: 18, // ⬆️ 原 15
  color: "#111827",
};

const projDesc: React.CSSProperties = {
  marginTop: 4, // ⬇️ 原 6
  color: "#6b7280",
  fontSize: 14, // ⬆️ 原 12
  lineHeight: 1.35,
  whiteSpace: "pre-wrap",
};

const metaLine: React.CSSProperties = {
  marginTop: 6, // ⬇️ 原 10（卡片高度會再縮）
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#6b7280",
  fontSize: 13, // ⬆️ 原 12
};

const metaDot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  border: "1px solid #d1d5db",
  background: "#fff",
};

const metaText: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** 右側：固定一排 6 欄 + 橫向捲動 */
const stageRail: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowX: "auto",
  paddingBottom: 0, // ⬇️ 原 2
};

const stageGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 150px)", // ⬇️ 原 160（更像截圖緊湊）
  gap: 14, // ⬇️ 原 18（減少高度與空隙）
  alignItems: "start",
};

const stageCol: React.CSSProperties = {
  display: "grid",
  gap: 4, // ⬇️ 原 6（卡片高度會更扁）
};

const stageLabel: React.CSSProperties = {
  fontSize: 14, // ⬆️ 原 12
  fontWeight: 900,
  color: "#374151",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const stagePct: React.CSSProperties = {
  fontSize: 13, // ⬆️ 原 12
  color: "#374151",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const miniBarOuter: React.CSSProperties = {
  width: "100%",
  height: 8, // 可改 7 更扁；或 9 更厚
  borderRadius: 999,
  background: "#eef2f7",
  overflow: "hidden",
};

const miniBarInner: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
};

/** 下方：整體 */
const overallWrap: React.CSSProperties = {
  marginTop: 8, // ⬇️ 原 14（縮卡片高度的第二關鍵）
  paddingTop: 8, // ⬇️ 原 12
  borderTop: "1px solid #f1f5f9",
};

const overallHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: 4, // ⬇️ 原 6
};

const overallLabel: React.CSSProperties = {
  fontSize: 14, // ⬆️ 原 12
  color: "#374151",
  fontWeight: 900,
};

const overallPct: React.CSSProperties = {
  fontSize: 18, // ⬆️ 原 14
  color: "#111827",
  fontWeight: 900,
};

const barOuter: React.CSSProperties = {
  width: "100%",
  height: 10, // 可改 9 更扁；或 12 更厚
  borderRadius: 999,
  background: "#eef2f7",
  overflow: "hidden",
};

const barInner: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "#3b82f6",
};

const overallFoot: React.CSSProperties = {
  marginTop: 6, // ⬇️ 原 8
  fontSize: 13, // ⬆️ 原 12
  color: "#94a3b8",
  textAlign: "right",
};

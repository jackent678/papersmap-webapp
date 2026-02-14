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
  { key: "hardware_install", label: "硬體安裝", color: "#3b82f6" },
  { key: "hardware_stability", label: "穩定性調整", color: "#22c55e" },
  { key: "software_params", label: "軟體參數", color: "#f97316" },
  { key: "ai_training", label: "AI訓練", color: "#a855f7" },
  { key: "run_validation", label: "跑料驗證", color: "#0ea5e9" },
  { key: "training", label: "教育訓練", color: "#64748b" },
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
  return `${d.getMonth() + 1}月${d.getDate()}日`;
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
  if (projects.length === 0)
    return <div style={{ color: "#6b7280" }}>（尚無專案）</div>;

  return (
    <div style={pageWrap}>
      {/* 名稱列：跨滿 */}
      <div style={fullRow}>
        <div style={meName}>{displayName}</div>
      </div>

      {/* 兩欄專案區（RWD：寬度不夠自動變一欄） */}
      <div style={cardsGrid}>
        {projects.map((p) => {
          const ov = overall(p);

          return (
            <div key={p.id} style={card}>
              <div style={topRow}>
                <div style={leftCol}>
                  <div style={projTitle}>{p.name}</div>
                  {p.description && <div style={projDesc}>{p.description}</div>}
                  <div style={metaLine}>
                    <span style={metaDot} />
                    <span style={metaText}>{formatDate(p.created_at)}</span>
                  </div>
                </div>

                {/* ✅ 不要拉霸：改成等分 6 欄，不做 overflowX */}
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
    </div>
  );
}

/* ================== Styles ================== */

const pageWrap: React.CSSProperties = {
  display: "grid",
  gap: 12,
};

const fullRow: React.CSSProperties = {
  gridColumn: "1 / -1",
};

const cardsGrid: React.CSSProperties = {
  display: "grid",
  gap: 12,
  // ✅ RWD：夠寬兩欄，不夠寬一欄
  // 760 你可視你的版面調整：700~820
  gridTemplateColumns: "repeat(auto-fit, minmax(760px, 1fr))",
  alignItems: "start",
};

const meName: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: "#111827",
};

const card: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 14,
  padding: 12,
  background: "#fff",
};

const topRow: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
};

const leftCol: React.CSSProperties = {
  width: 200,
  flex: "0 0 auto",
  paddingRight: 10,
  borderRight: "1px solid #f1f5f9",
};

const projTitle: React.CSSProperties = {
  fontWeight: 900,
  fontSize: 18,
  color: "#111827",
};

const projDesc: React.CSSProperties = {
  marginTop: 4,
  color: "#6b7280",
  fontSize: 14,
  lineHeight: 1.35,
  whiteSpace: "pre-wrap",
};

const metaLine: React.CSSProperties = {
  marginTop: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "#6b7280",
};

const metaDot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  border: "1px solid #d1d5db",
  background: "#fff",
};

const metaText: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
};

/** ✅ 右側：不做 overflowX，靠 6 欄等分塞進去 */
const stageRail: React.CSSProperties = {
  flex: 1,
  minWidth: 0, // ✅ 很重要：避免 flex 子元素把寬度撐爆
};

const stageGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, minmax(0, 1fr))", // ✅ 6 欄等分
  gap: 12,
  alignItems: "start",
};

const stageCol: React.CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 0, // ✅ 讓文字可以 ellipsis
};

const stageLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#374151",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const stagePct: React.CSSProperties = {
  fontSize: 13,
  color: "#374151",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const miniBarOuter: React.CSSProperties = {
  width: "100%",
  height: 8,
  borderRadius: 999,
  background: "#eef2f7",
  overflow: "hidden",
};

const miniBarInner: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
};

const overallWrap: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 8,
  borderTop: "1px solid #f1f5f9",
};

const overallHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: 4,
};

const overallLabel: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: "#374151",
};

const overallPct: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 900,
  color: "#111827",
};

const barOuter: React.CSSProperties = {
  width: "100%",
  height: 10,
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
  marginTop: 6,
  fontSize: 13,
  color: "#94a3b8",
  textAlign: "right",
};

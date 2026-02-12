"use client";

import { useEffect, useMemo, useState } from "react";
import Sidebar from "../Sidebar";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type StageKey =
  | "hardware_install"
  | "hardware_stability"
  | "software_params"
  | "ai_training"
  | "run_validation"
  | "training";

type StageValue = {
  status: "todo" | "doing" | "done";
  percent: number; // 0-100
  note?: string;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  progress: Record<string, any> | null; // jsonb
  created_at: string;
};

const STAGES: Array<{ key: StageKey; label: string }> = [
  { key: "hardware_install", label: "硬體安裝定位" },
  { key: "hardware_stability", label: "硬體穩定性調整" },
  { key: "software_params", label: "軟體參數設定" },
  { key: "ai_training", label: "AI參數訓練" },
  { key: "run_validation", label: "跑料驗證" },
  { key: "training", label: "教育訓練" },
];

function clampPercent(n: number) {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function defaultProgress(): Record<StageKey, StageValue> {
  const obj = {} as Record<StageKey, StageValue>;
  for (const s of STAGES) obj[s.key] = { status: "todo", percent: 0, note: "" };
  return obj;
}

function normalizeProgress(p: any): Record<StageKey, StageValue> {
  const base = defaultProgress();
  if (!p || typeof p !== "object") return base;

  for (const s of STAGES) {
    const v = p[s.key];
    if (!v || typeof v !== "object") continue;

    const status = v.status === "doing" || v.status === "done" ? v.status : "todo";
    const percent = clampPercent(Number(v.percent ?? 0));
    const note = typeof v.note === "string" ? v.note : "";

    base[s.key] = { status, percent, note };
  }
  return base;
}

function statusLabel(s: StageValue["status"]) {
  if (s === "todo") return "未開始";
  if (s === "doing") return "進行中";
  return "已完成";
}

function isMissingRelationError(errMsg: string) {
  return /does not exist/i.test(errMsg) || /relation .* does not exist/i.test(errMsg);
}

function cleanNote(s: unknown) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+$/g, "").trim();
}

export default function ProjectsPage() {
  const router = useRouter();
  const [msg, setMsg] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [projects, setProjects] = useState<ProjectRow[]>([]);

  // modal state
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formProgress, setFormProgress] = useState<Record<StageKey, StageValue>>(defaultProgress());
  const [saving, setSaving] = useState(false);

  async function ensureLoggedIn() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);
    if (!data.user) {
      router.replace("/login");
      throw new Error("未登入");
    }
    return data.user;
  }

  async function loadProjects() {
    setMsg("");
    setLoading(true);

    try {
      await ensureLoggedIn();

      const { data, error } = await supabase
        .from("projects")
        .select("id,name,description,owner_id,progress,created_at")
        .order("created_at", { ascending: false });

      if (error) throw new Error(error.message);

      setProjects((data ?? []) as ProjectRow[]);

      if (!data || data.length === 0) {
        setMsg("目前沒有可見專案（可能是你尚未被加入任何專案，或 RLS 權限限制）。");
      }
    } catch (e: any) {
      setProjects([]);
      setMsg("❌ 讀取專案失敗： " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openNew() {
    setEditingId(null);
    setFormName("");
    setFormDesc("");
    setFormProgress(defaultProgress());
    setOpen(true);
  }

  function openEdit(p: ProjectRow) {
    setEditingId(p.id);
    setFormName(p.name ?? "");
    setFormDesc(p.description ?? "");
    setFormProgress(normalizeProgress(p.progress));
    setOpen(true);
  }

  const overallPercent = useMemo(() => {
    return (p: ProjectRow) => {
      const prog = normalizeProgress(p.progress);
      const avg = STAGES.reduce((sum, s) => sum + clampPercent(Number(prog[s.key]?.percent ?? 0)), 0) / STAGES.length;
      return clampPercent(avg);
    };
  }, []);

  async function saveProject() {
    setMsg("");
    if (!formName.trim()) return setMsg("❌ 請輸入專案名稱");

    setSaving(true);
    try {
      const user = await ensureLoggedIn();

      const payload = {
        name: formName.trim(),
        description: formDesc.trim() ? formDesc.trim() : null,
        progress: formProgress,
      };

      if (!editingId) {
        const { error } = await supabase.from("projects").insert({
          ...payload,
          owner_id: user.id,
        });
        if (error) throw new Error(error.message);
        setMsg("✅ 已新增專案");
      } else {
        const { error } = await supabase.from("projects").update(payload).eq("id", editingId);
        if (error) throw new Error(error.message);
        setMsg("✅ 已更新專案");
      }

      setOpen(false);
      await loadProjects();
    } catch (e: any) {
      setMsg("❌ 儲存失敗： " + (e?.message ?? "unknown"));
    } finally {
      setSaving(false);
    }
  }

  async function detachProjectFromPlans(projectId: string) {
    const tables = ["weekly_plan_items", "schedule_items"] as const;

    for (const t of tables) {
      const { error } = await supabase.from(t).update({ project_id: null }).eq("project_id", projectId);
      if (error) {
        if (isMissingRelationError(error.message)) continue;
        throw new Error(`${t} 解除專案關聯失敗：${error.message}`);
      }
    }
  }

  async function deleteProject(id: string) {
    const ok = confirm("確定要刪除這個專案？（會先解除行程關聯）");
    if (!ok) return;

    setSaving(true);
    setMsg("");
    try {
      await ensureLoggedIn();

      await detachProjectFromPlans(id);

      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) throw new Error(error.message);

      setMsg("✅ 已刪除專案（相關行程已解除專案關聯）");
      setOpen(false);
      await loadProjects();
    } catch (e: any) {
      setMsg("❌ 刪除失敗： " + (e?.message ?? "unknown"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.shell}>
      <div style={styles.sidebarWrap}>
        <Sidebar />
      </div>

      <div style={styles.main}>
        <div style={styles.topbar}>
          <div>
            <h1 style={styles.h1}>專案管理</h1>
            <div style={styles.sub}>新增 / 編輯 / 刪除 + 6階段進度（同步顯示備註）</div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={openNew} style={styles.btn}>
              ＋ 新增專案
            </button>
            <button onClick={loadProjects} style={styles.btn}>
              重新整理
            </button>
          </div>
        </div>

        {msg && (
          <div style={styles.alert}>
            <span>⚠️</span>
            {msg}
          </div>
        )}

        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <h2 style={styles.h2}>專案列表</h2>
            <div style={{ fontSize: 12, color: "#6b7280" }}>點卡片可編輯</div>
          </div>

          <div style={styles.cardBody}>
            {loading ? (
              <div style={{ color: "#6b7280" }}>載入中...</div>
            ) : projects.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={{ fontWeight: 900 }}>沒有可顯示的專案</div>
                <div style={{ marginTop: 8, opacity: 0.85, lineHeight: 1.6 }}>
                  可能原因：
                  <ul style={{ marginTop: 6 }}>
                    <li>你尚未被加入任何專案（project_members 沒有你的資料）</li>
                    <li>你不是 is_admin（主管）</li>
                    <li>RLS 正在正常限制資料（這代表權限系統已生效）</li>
                  </ul>
                  你可以去 <b>/app/admin</b> 把自己加進某個專案（或確認 is_admin=true）。
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {projects.map((p) => {
                  const prog = normalizeProgress(p.progress);
                  const overall = overallPercent(p);

                  return (
                    <div key={p.id} style={styles.projectCard} onClick={() => openEdit(p)} title="點一下編輯">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div>
                          <div style={{ fontWeight: 900, fontSize: 16, color: "#111827" }}>{p.name}</div>
                          {p.description && <div style={{ marginTop: 6, color: "#374151" }}>{p.description}</div>}
                          <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                           
                          </div>
                        </div>

                        <div style={{ minWidth: 160 }}>
                          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>整體進度（平均）</div>
                          <div style={styles.progressOuter}>
                            <div style={{ ...styles.progressInner, width: `${overall}%` }} />
                          </div>
                          <div style={{ marginTop: 6, fontSize: 12, color: "#374151", textAlign: "right" }}>{overall}%</div>
                        </div>
                      </div>

                      {/* ✅ 6階段：左=名稱 / 中=備註 / 右=狀態+進度 */}
                      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                        {STAGES.map((s) => {
                          const v = prog[s.key];
                          const note = cleanNote(v.note ?? "");

                          return (
                            <div key={s.key} style={styles.stageLine}>
                              <div style={styles.stageLeft}>{s.label}</div>

                              <div style={styles.stageNote}>
                                {note ? note : <span style={{ opacity: 0.35 }}>（無備註）</span>}
                              </div>

                              <div style={styles.stageRight}>
                                <div style={styles.stageStatus}>{statusLabel(v.status)}</div>
                                <div style={styles.stageBarOuter}>
                                  <div style={{ ...styles.stageBarInner, width: `${clampPercent(v.percent)}%` }} />
                                </div>
                                <div style={styles.stagePct}>{clampPercent(v.percent)}%</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>點卡片進入編輯</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Modal */}
        {open && (
          <div style={styles.modalOverlay} onClick={() => !saving && setOpen(false)}>
            <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{editingId ? "編輯專案" : "新增專案"}</div>
                <button onClick={() => !saving && setOpen(false)} style={styles.btn}>
                  關閉
                </button>
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                <div>
                  <div style={styles.label}>專案名稱</div>
                  <input value={formName} onChange={(e) => setFormName(e.target.value)} style={styles.input} disabled={saving} />
                </div>

                <div>
                  <div style={styles.label}>專案說明（可選）</div>
                  <textarea
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    style={{ ...styles.input, height: 90, resize: "vertical" }}
                    disabled={saving}
                  />
                </div>

                <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
                  <div style={{ fontWeight: 800, color: "#374151", marginBottom: 10 }}>6階段進度</div>

                  <div style={{ display: "grid", gap: 12 }}>
                    {STAGES.map((s) => {
                      const v = formProgress[s.key];
                      return (
                        <div key={s.key} style={styles.editStageCard}>
                          <div style={{ fontWeight: 800, color: "#111827" }}>{s.label}</div>

                          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                              <div style={styles.label}>狀態</div>
                              <select
                                value={v.status}
                                onChange={(e) =>
                                  setFormProgress((prev) => ({
                                    ...prev,
                                    [s.key]: { ...prev[s.key], status: e.target.value as StageValue["status"] },
                                  }))
                                }
                                style={styles.input}
                                disabled={saving}
                              >
                                <option value="todo">未開始</option>
                                <option value="doing">進行中</option>
                                <option value="done">已完成</option>
                              </select>
                            </div>

                            <div>
                              <div style={styles.label}>百分比（0-100）</div>
                              <input
                                value={String(v.percent)}
                                onChange={(e) =>
                                  setFormProgress((prev) => ({
                                    ...prev,
                                    [s.key]: { ...prev[s.key], percent: clampPercent(Number(e.target.value)) },
                                  }))
                                }
                                style={styles.input}
                                disabled={saving}
                                inputMode="numeric"
                              />
                            </div>
                          </div>

                          <div style={{ marginTop: 10 }}>
                            <div style={styles.label}>備註（可選）</div>
                            <textarea
                              value={v.note ?? ""}
                              onChange={(e) =>
                                setFormProgress((prev) => ({
                                  ...prev,
                                  [s.key]: { ...prev[s.key], note: e.target.value },
                                }))
                              }
                              style={{ ...styles.input, height: 70, resize: "vertical" }}
                              disabled={saving}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  {editingId && (
                    <button onClick={() => deleteProject(editingId)} style={{ ...styles.btn, background: "#fff" }} disabled={saving}>
                      刪除專案
                    </button>
                  )}
                  <button onClick={saveProject} style={styles.btn} disabled={saving}>
                    {saving ? "儲存中..." : "儲存"}
                  </button>
                </div>

                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  若新增/編輯/刪除被 RLS 擋住，代表你的 Supabase 權限規則正在生效，需要調整 policy（我也可以幫你寫）。
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { display: "flex", minHeight: "100vh", backgroundColor: "#f3f4f6" },
  sidebarWrap: { width: 260, flexShrink: 0, backgroundColor: "white", borderRight: "1px solid #e5e7eb" },
  main: { flex: 1, minWidth: 0, padding: 24, fontFamily: "sans-serif" },

  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12 },
  h1: { fontSize: 20, fontWeight: 600, margin: 0, marginBottom: 6, color: "#111827" },
  sub: { fontSize: 13, color: "#6b7280" },

  btn: {
    padding: "8px 12px",
    fontSize: 14,
    color: "#6b7280",
    backgroundColor: "transparent",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    cursor: "pointer",
  },

  alert: {
    marginBottom: 16,
    padding: "12px 16px",
    backgroundColor: "#fef2f2",
    border: "1px solid #fee2e2",
    borderRadius: 8,
    color: "#b91c1c",
    fontSize: 14,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  card: { backgroundColor: "white", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" },
  cardHeader: {
    padding: "16px 20px",
    borderBottom: "1px solid #e5e7eb",
    backgroundColor: "#f9fafb",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  h2: { fontSize: 16, fontWeight: 600, margin: 0, color: "#374151" },
  cardBody: { padding: 20 },

  emptyBox: { marginTop: 8, padding: 14, border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff" },

  projectCard: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "#fff", cursor: "pointer" },

  progressOuter: { width: "100%", height: 10, borderRadius: 999, background: "#f3f4f6", border: "1px solid #e5e7eb", overflow: "hidden" },
  progressInner: { height: "100%", background: "#3b82f6" },

  // ✅ 三欄對齊：左=階段名稱 / 中=備註 / 右=狀態+bar+%
  stageLine: {
    display: "grid",
    gridTemplateColumns: "160px 1fr 260px",
    gap: 14,
    alignItems: "center",
    border: "1px solid #f1f5f9",
    borderRadius: 12,
    padding: "10px 12px",
    background: "#fff",
  },
  stageLeft: {
    fontWeight: 900,
    color: "#111827",
    fontSize: 13,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  stageNote: {
    fontSize: 12,
    color: "#334155",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
  },
  stageRight: {
    display: "grid",
    gridTemplateColumns: "60px 1fr 44px",
    gap: 10,
    alignItems: "center",
    justifyContent: "end",
  },
  stageStatus: {
    fontSize: 12,
    color: "#6b7280",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  stagePct: {
    fontSize: 12,
    color: "#374151",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  stageBarOuter: { width: "100%", height: 8, borderRadius: 999, background: "#f3f4f6", border: "1px solid #e5e7eb", overflow: "hidden" },
  stageBarInner: { height: "100%", background: "#10b981" },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 50,
  },
  modalCard: {
    width: "min(980px, 100%)",
    background: "#fff",
    borderRadius: 14,
    padding: 14,
    border: "1px solid #eee",
    maxHeight: "90vh",
    overflow: "auto",
  },

  input: { width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd", outline: "none" },
  label: { fontSize: 12, opacity: 0.75, marginBottom: 6, fontWeight: 800 },

  editStageCard: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" },
};

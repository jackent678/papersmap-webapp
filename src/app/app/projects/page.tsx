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

  // ✅ 此階段預估天數（SLA）
  plan_days?: number; // >=0
};

type ProgressMeta = {
  // ✅ 整體專案預估天數
  project_plan_days?: number; // >=0
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  progress: Record<string, any> | null; // jsonb (包含各 stage + _meta)
  created_at: string;
};

type ScheduleItemRow = {
  id: string;
  project_id: string | null;
  work_date: string; // YYYY-MM-DD
  title: string;
  details: string | null;
  item_type: "work" | "leave" | "move";
  // ✅ 來自行程規劃：1~6 對應 6 階段（存於 schedule_items.priority）
  priority?: number | null;
};

const STAGES: Array<{ key: StageKey; label: string; keywords: string[] }> = [
  { key: "hardware_install", label: "硬體安裝定位", keywords: ["硬體安裝定位", "hardware_install"] },
  { key: "hardware_stability", label: "硬體穩定性調整", keywords: ["硬體穩定性調整", "hardware_stability"] },
  { key: "software_params", label: "軟體參數設定", keywords: ["軟體參數設定", "software_params"] },
  { key: "ai_training", label: "AI參數訓練", keywords: ["AI參數訓練", "ai_training"] },
  { key: "run_validation", label: "跑料驗證", keywords: ["跑料驗證", "run_validation"] },
  { key: "training", label: "教育訓練", keywords: ["教育訓練", "training"] },
];

function clampPercent(n: number) {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function clampNonNegInt(n: any, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  return Math.round(x);
}

function defaultMeta(): ProgressMeta {
  return { project_plan_days: 0 };
}

function defaultProgress(): Record<StageKey | "_meta", any> {
  const obj: any = {};
  obj._meta = defaultMeta();
  for (const s of STAGES) obj[s.key] = { status: "todo", percent: 0, note: "", plan_days: 0 };
  return obj;
}

function normalizeMeta(p: any): ProgressMeta {
  const m = p?._meta;
  return {
    project_plan_days: clampNonNegInt(m?.project_plan_days ?? 0, 0),
  };
}

function normalizeStageValue(v: any): StageValue {
  const status = v?.status === "doing" || v?.status === "done" ? v.status : "todo";
  const percent = clampPercent(Number(v?.percent ?? 0));
  const note = typeof v?.note === "string" ? v.note : "";
  const plan_days = clampNonNegInt(v?.plan_days ?? 0, 0);
  return { status, percent, note, plan_days };
}

function normalizeProgress(p: any): Record<StageKey, StageValue> {
  const base = {} as Record<StageKey, StageValue>;
  for (const s of STAGES) base[s.key] = normalizeStageValue(null);

  if (!p || typeof p !== "object") return base;

  for (const s of STAGES) {
    const v = p[s.key];
    base[s.key] = normalizeStageValue(v);
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

/** ✅ 嘗試從行程文字推測屬於哪個 stage（沒有 stage_key 欄位時的折衷作法） */
function detectStageFromText(text: string): StageKey | null {
  const t = (text || "").toLowerCase();
  for (const s of STAGES) {
    for (const k of s.keywords) {
      if (t.includes(k.toLowerCase())) return s.key;
    }
  }
  return null;
}

type UsageByProject = Record<
  string,
  {
    totalDays: number; // 專案使用天數（不重複日期）
    stageDays: Record<StageKey, number>; // 每階段使用天數（不重複日期）
  }
>;

function emptyStageDays(): Record<StageKey, number> {
  const obj = {} as Record<StageKey, number>;
  for (const s of STAGES) obj[s.key] = 0;
  return obj;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [msg, setMsg] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [usage, setUsage] = useState<UsageByProject>({});

  // modal state
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");

  // ✅ 整體預估天數
  const [formProjectPlanDays, setFormProjectPlanDays] = useState<number>(0);

  // ✅ 各階段（含 plan_days）
  const [formProgress, setFormProgress] = useState<Record<StageKey, StageValue>>(
    normalizeProgress(defaultProgress())
  );

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

  async function loadProjectsOnly() {
    const { data, error } = await supabase
      .from("projects")
      .select("id,name,description,owner_id,progress,created_at")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as ProjectRow[];
  }

  async function loadUsageForProjects(projectIds: string[]) {
    if (projectIds.length === 0) return {};

    const { data, error } = await supabase
      .from("schedule_items")
      .select("id,project_id,work_date,title,details,item_type,priority")
      .in("project_id", projectIds)
      .eq("item_type", "work");

    if (error) {
      if (isMissingRelationError(error.message)) return {};
      throw new Error(error.message);
    }

    const rows = (data ?? []) as ScheduleItemRow[];

    const byProjectDateSet = new Map<string, Set<string>>();
    const byProjectStageDateSet = new Map<string, Map<StageKey, Set<string>>>();

    for (const r of rows) {
      if (!r.project_id) continue;
      const pid = r.project_id;

      const date = r.work_date;

      if (!byProjectDateSet.has(pid)) byProjectDateSet.set(pid, new Set<string>());
      byProjectDateSet.get(pid)!.add(date);

      let sk: StageKey | null = null;
      const pr = Number(r.priority ?? NaN);
      if (Number.isFinite(pr) && pr >= 1 && pr <= 6) {
        sk = STAGES[Math.round(pr) - 1]?.key ?? null;
      } else {
        const text = `${r.title ?? ""}\n${r.details ?? ""}`;
        sk = detectStageFromText(text);
      }
      if (sk) {
        if (!byProjectStageDateSet.has(pid)) byProjectStageDateSet.set(pid, new Map());
        const m = byProjectStageDateSet.get(pid)!;
        if (!m.has(sk)) m.set(sk, new Set<string>());
        m.get(sk)!.add(date);
      }
    }

    const result: UsageByProject = {};
    for (const pid of projectIds) {
      const totalDays = byProjectDateSet.get(pid)?.size ?? 0;

      const stageDays = emptyStageDays();
      const m = byProjectStageDateSet.get(pid);
      if (m) {
        for (const s of STAGES) stageDays[s.key] = m.get(s.key)?.size ?? 0;
      }

      result[pid] = { totalDays, stageDays };
    }
    return result;
  }

  async function loadAll() {
    setMsg("");
    setLoading(true);
    try {
      await ensureLoggedIn();

      const list = await loadProjectsOnly();
      setProjects(list);

      const ids = list.map((p) => p.id);
      const u = await loadUsageForProjects(ids);
      setUsage(u);

      if (list.length === 0) setMsg("目前沒有可見專案（可能是你尚未被加入任何專案，或 RLS 權限限制）。");
    } catch (e: any) {
      setProjects([]);
      setUsage({});
      setMsg("❌ 讀取失敗： " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openNew() {
    setEditingId(null);
    setFormName("");
    setFormDesc("");
    setFormProjectPlanDays(0);
    setFormProgress(normalizeProgress(defaultProgress()));
    setOpen(true);
  }

  function openEdit(p: ProjectRow) {
    setEditingId(p.id);
    setFormName(p.name ?? "");
    setFormDesc(p.description ?? "");
    setFormProgress(normalizeProgress(p.progress));
    setFormProjectPlanDays(normalizeMeta(p.progress).project_plan_days ?? 0);
    setOpen(true);
  }

  const overallPercent = useMemo(() => {
    return (p: ProjectRow) => {
      const prog = normalizeProgress(p.progress);
      const avg =
        STAGES.reduce((sum, s) => sum + clampPercent(Number(prog[s.key]?.percent ?? 0)), 0) / STAGES.length;
      return clampPercent(avg);
    };
  }, []);

  function stageOverdue(p: ProjectRow, sk: StageKey) {
    const prog = normalizeProgress(p.progress);
    const plan = clampNonNegInt(prog[sk]?.plan_days ?? 0, 0);
    if (plan <= 0) return false;

    const used = usage[p.id]?.stageDays?.[sk] ?? 0;
    const st = prog[sk]?.status ?? "todo";
    return st !== "done" && used > plan;
  }

  function projectOverdue(p: ProjectRow) {
    const plan = clampNonNegInt(normalizeMeta(p.progress).project_plan_days ?? 0, 0);
    if (plan <= 0) return false;
    const used = usage[p.id]?.totalDays ?? 0;
    const done = overallPercent(p) >= 100;
    return !done && used > plan;
  }

  async function saveProject() {
    setMsg("");
    if (!formName.trim()) return setMsg("❌ 請輸入專案名稱");

    setSaving(true);
    try {
      const user = await ensureLoggedIn();

      const progressPayload: any = {};
      progressPayload._meta = { project_plan_days: clampNonNegInt(formProjectPlanDays, 0) };
      for (const s of STAGES) {
        const v = formProgress[s.key];
        progressPayload[s.key] = {
          status: v.status,
          percent: clampPercent(Number(v.percent ?? 0)),
          note: v.note ?? "",
          plan_days: clampNonNegInt(v.plan_days ?? 0, 0),
        };
      }

      const payload = {
        name: formName.trim(),
        description: formDesc.trim() ? formDesc.trim() : null,
        progress: progressPayload,
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
      await loadAll();
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
      await loadAll();
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
            <div style={styles.sub}>預估天數 / 階段天數（SLA）/ 行程統計天數 / 超時未完成顯示紅色</div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={openNew} style={styles.btn}>
              ＋ 新增專案
            </button>
            <button onClick={loadAll} style={styles.btn}>
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
            <div style={{ fontSize: 13, color: "#6b7280" }}>點卡片可編輯</div>
          </div>

          <div style={styles.cardBody}>
            {loading ? (
              <div style={{ color: "#6b7280" }}>載入中...</div>
            ) : projects.length === 0 ? (
              <div style={styles.emptyBox}>
                <div style={{ fontWeight: 900 }}>沒有可顯示的專案</div>
                <div style={{ marginTop: 6, opacity: 0.85, lineHeight: 1.55, fontSize: 13 }}>
                  可能原因：你尚未被加入任何專案 / RLS 權限限制 / 目前資料為空。
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {projects.map((p) => {
                  const prog = normalizeProgress(p.progress);
                  const meta = normalizeMeta(p.progress);
                  const overall = overallPercent(p);

                  const usedDays = usage[p.id]?.totalDays ?? 0;
                  const planDays = clampNonNegInt(meta.project_plan_days ?? 0, 0);
                  const pOver = projectOverdue(p);

                  return (
                    <div key={p.id} style={styles.projectCard} onClick={() => openEdit(p)} title="點一下編輯">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontWeight: 900, fontSize: 16, color: "#111827" }}>{p.name}</div>
                            {pOver && <span style={styles.badgeRed}>超時</span>}
                          </div>

                          {p.description && (
                            <div style={{ marginTop: 2, color: "#374151", fontSize: 13, lineHeight: 1.45 }}>
                              {p.description}
                            </div>
                          )}

                          <div style={{ marginTop: 2, fontSize: 13, color: "#6b7280" }}>
                            <span
                              style={{
                                color: pOver ? "#ef4444" : "#6b7280",
                                fontWeight: pOver ? 800 : 400,
                                background: pOver ? "#fee2e2" : "transparent",
                                padding: pOver ? "1px 6px" : 0,
                                borderRadius: pOver ? 6 : 0,
                                display: "inline-block",
                              }}
                            >
                              專案天數：使用 {usedDays} 天
                              {planDays > 0 ? ` / 預估 ${planDays} 天` : "（未設定預估天數）"}
                            </span>
                          </div>

                          <div style={{ marginTop: 2, fontSize: 13, color: "#6b7280" }}>
                            {new Date(p.created_at).toLocaleString()} · id: {p.id}
                          </div>
                        </div>

                        <div style={{ minWidth: 180 }}>
                          <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 4 }}>整體進度（平均）</div>
                          <div style={styles.progressOuter}>
                            <div style={{ ...styles.progressInner, width: `${overall}%` }} />
                          </div>
                          <div style={{ marginTop: 2, fontSize: 13, color: "#374151", textAlign: "right" }}>{overall}%</div>
                        </div>
                      </div>

                      <div style={{ marginTop: 5, display: "grid", gap: 6 }}>
                        {STAGES.map((s) => {
                          const v = prog[s.key];
                          const note = cleanNote(v.note ?? "");

                          const used = usage[p.id]?.stageDays?.[s.key] ?? 0;
                          const plan = clampNonNegInt(v.plan_days ?? 0, 0);
                          const overdue = stageOverdue(p, s.key);

                          return (
                            <div
                              key={s.key}
                              style={{
                                ...styles.stageLine,
                                borderColor: overdue ? "#fecaca" : "#f1f5f9",
                                background: overdue ? "#fff1f2" : "#fff",
                              }}
                            >
                              <div style={styles.stageLeft}>{s.label}</div>

                              <div style={styles.stageNote}>
                                {note ? note : <span style={{ opacity: 0.35 }}>（無備註）</span>}
                              </div>

                              <div style={styles.stageRight}>
                                <div style={{ textAlign: "right" }}>
                                  <div style={{ ...styles.stageStatus, color: overdue ? "#b91c1c" : "#6b7280" }}>
                                    {statusLabel(v.status)}
                                  </div>

                                  <div style={{ fontSize: 13, marginTop: 2, color: "#6b7280" }}>
                                    <span
                                      style={{
                                        color: overdue ? "#ef4444" : "#6b7280",
                                        fontWeight: overdue ? 800 : 400,
                                        background: overdue ? "#fee2e2" : "transparent",
                                        padding: overdue ? "1px 6px" : 0,
                                        borderRadius: overdue ? 6 : 0,
                                        display: "inline-block",
                                      }}
                                    >
                                      使用 {used} 天{plan > 0 ? ` / 預估 ${plan} 天` : ""}
                                    </span>
                                  </div>
                                </div>

                                <div style={styles.stageBarOuter}>
                                  <div
                                    style={{
                                      ...styles.stageBarInner,
                                      width: `${clampPercent(v.percent)}%`,
                                      background: overdue ? "#ef4444" : "#10b981",
                                    }}
                                  />
                                </div>

                                <div style={styles.stagePct}>{clampPercent(v.percent)}%</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div style={{ marginTop: 4, fontSize: 13, color: "#6b7280" }}>
                        提醒：各階段「使用天數」優先使用行程規劃的「6 階段」(schedule_items.priority=1~6)；若舊資料未填，才回退用
                        title/details 關鍵字推測。
                      </div>
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

              <div style={{ marginTop: 5, display: "grid", gap: 12 }}>
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

                <div>
                  <div style={styles.label}>專案預估處理天數（用來判斷是否超時）</div>
                  <input
                    value={String(formProjectPlanDays)}
                    onChange={(e) => setFormProjectPlanDays(clampNonNegInt(e.target.value, 0))}
                    style={styles.input}
                    disabled={saving}
                    inputMode="numeric"
                    placeholder="例如：30"
                  />
                </div>

                <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
                  <div style={{ fontWeight: 800, color: "#374151", marginBottom: 10 }}>6階段進度（含：各階段預估天數）</div>

                  <div style={{ display: "grid", gap: 12 }}>
                    {STAGES.map((s) => {
                      const v = formProgress[s.key];
                      return (
                        <div key={s.key} style={styles.editStageCard}>
                          <div style={{ fontWeight: 800, color: "#111827" }}>{s.label}</div>

                          <div style={{ marginTop: 5, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
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

                            <div>
                              <div style={styles.label}>階段預估天數（SLA）</div>
                              <input
                                value={String(v.plan_days ?? 0)}
                                onChange={(e) =>
                                  setFormProgress((prev) => ({
                                    ...prev,
                                    [s.key]: { ...prev[s.key], plan_days: clampNonNegInt(e.target.value, 0) },
                                  }))
                                }
                                style={styles.input}
                                disabled={saving}
                                inputMode="numeric"
                                placeholder="例如：5"
                              />
                            </div>
                          </div>

                          <div style={{ marginTop: 5 }}>
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
                  超時規則：若「使用天數」＞「預估天數」，且狀態不是已完成(done)，則顯示紅色。
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ✅ 只放大字體：不改卡片大小/不改 spacing/不改 grid 結構
 * 你原本的尺寸設計保留，只調整 fontSize 與 lineHeight
 */
const styles: Record<string, React.CSSProperties> = {
  shell: { display: "flex", minHeight: "100vh", backgroundColor: "#f3f4f6" },
  sidebarWrap: { width: 260, flexShrink: 0, backgroundColor: "white", borderRight: "1px solid #e5e7eb" },
  main: { flex: 1, minWidth: 0, padding: 18, fontFamily: "sans-serif" },

  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12 },
  h1: { fontSize: 20, fontWeight: 600, margin: 0, marginBottom: 4, color: "#111827" }, // ✅ 18→20
  sub: { fontSize: 14, color: "#6b7280" }, // ✅ 12→14

  btn: {
    padding: "7px 10px",
    fontSize: 14, // ✅ 13→14
    color: "#6b7280",
    backgroundColor: "transparent",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    cursor: "pointer",
  },

  alert: {
    marginBottom: 12,
    padding: "10px 12px",
    backgroundColor: "#fef2f2",
    border: "1px solid #fee2e2",
    borderRadius: 8,
    color: "#b91c1c",
    fontSize: 14, // ✅ 13→14
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  badgeRed: {
    fontSize: 12, // ✅ 11→12
    fontWeight: 900,
    color: "#991b1b",
    background: "#fee2e2",
    border: "1px solid #fecaca",
    padding: "1px 7px",
    borderRadius: 999,
  },

  card: { backgroundColor: "white", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" },
  cardHeader: {
    padding: "12px 16px",
    borderBottom: "1px solid #e5e7eb",
    backgroundColor: "#f9fafb",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  h2: { fontSize: 16, fontWeight: 600, margin: 0, color: "#374151" }, // ✅ 15→16
  cardBody: { padding: 14 },

  emptyBox: { marginTop: 4, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff" },

  projectCard: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#fff", cursor: "pointer" },

  progressOuter: {
    width: "100%",
    height: 8,
    borderRadius: 999,
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    overflow: "hidden",
  },
  progressInner: { height: "100%", background: "#3b82f6" },

  stageLine: {
    display: "grid",
    gridTemplateColumns: "140px 1fr 300px",
    gap: 10,
    alignItems: "center",
    border: "1px solid #f1f5f9",
    borderRadius: 10,
    padding: "6px 10px",
  },
  stageLeft: {
    fontWeight: 900,
    color: "#111827",
    fontSize: 13, // ✅ 12→13
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  stageNote: {
    fontSize: 13, // ✅ 11→13
    color: "#334155",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.45, // ✅ 1.35→1.45
  },
  stageRight: {
    display: "grid",
    gridTemplateColumns: "120px 1fr 40px",
    gap: 8,
    alignItems: "center",
    justifyContent: "end",
  },
  stageStatus: {
    fontSize: 13, // ✅ 11→13
    color: "#6b7280",
    textAlign: "right",
    whiteSpace: "nowrap",
    fontWeight: 800,
  },
  stagePct: {
    fontSize: 13, // ✅ 11→13
    color: "#374151",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  stageBarOuter: {
    width: "100%",
    height: 6,
    borderRadius: 999,
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    overflow: "hidden",
  },
  stageBarInner: { height: "100%" },

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
    width: "min(1040px, 100%)",
    background: "#fff",
    borderRadius: 14,
    padding: 14,
    border: "1px solid #eee",
    maxHeight: "90vh",
    overflow: "auto",
  },

  input: { width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd", outline: "none", fontSize: 14 }, // ✅ 輸入框字也放大
  label: { fontSize: 13, opacity: 0.75, marginBottom: 6, fontWeight: 800 }, // ✅ 12→13

  editStageCard: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" },
};

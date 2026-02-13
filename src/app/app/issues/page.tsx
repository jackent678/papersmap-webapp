"use client";

import { useEffect, useMemo, useState } from "react";
import Sidebar from "../Sidebar";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ProjectRow = { id: string; name: string };
type ProfileLite = { name: string | null };
type MaybeProfileJoin = ProfileLite | ProfileLite[] | null;

type IssueRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  severity: 1 | 2 | 3;
  status: "open" | "doing" | "done";
  reporter_id: string | null;
  assignee_id: string | null;
  created_at: string;
  updated_at: string;
  assignee: ProfileLite | null;

  // （可選）若你已加欄位：處理對策/處理項目
  countermeasure?: string | null;
  action_items?: string | null;
};

type IssueCommentRow = {
  id: string;
  issue_id: string;
  content: string;
  author_id: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeProfile(p: MaybeProfileJoin): ProfileLite | null {
  if (!p) return null;
  if (Array.isArray(p)) return p[0] ?? null;
  return p;
}

function clampSeverity(n: number): 1 | 2 | 3 {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

function cleanText(s: unknown) {
  if (typeof s !== "string") return "";
  return s.replace(/\s+$/g, "").trim();
}

export default function IssuesPage() {
  const router = useRouter();
  const [msg, setMsg] = useState("");

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);

  // ✅ 先選專案才顯示 issue
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  // ✅ 新增 issue
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newSeverity, setNewSeverity] = useState<1 | 2 | 3>(2);

  // ✅ 編輯 issue modal
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editSeverity, setEditSeverity] = useState<1 | 2 | 3>(2);
  const [editStatus, setEditStatus] = useState<"open" | "doing" | "done">("open");
  const [saving, setSaving] = useState(false);

  // ✅ 留言/處理紀錄：依 issue_id 分組
  const [commentsByIssue, setCommentsByIssue] = useState<Record<string, IssueCommentRow[]>>({});
  const [newCommentTextByIssue, setNewCommentTextByIssue] = useState<Record<string, string>>({});

  // ✅ 編輯留言（簡單做：同頁 inline edit）
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState<string>("");

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? "（未知專案）";
  }, [projects]);

  const stats = useMemo(() => {
    const open = issues.filter((i) => i.status === "open").length;
    const doing = issues.filter((i) => i.status === "doing").length;
    const done = issues.filter((i) => i.status === "done").length;
    return { open, doing, done, total: issues.length };
  }, [issues]);

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
    const { data, error } = await supabase
      .from("projects")
      .select("id,name")
      .order("created_at", { ascending: false });

    if (error) throw error;
    setProjects((data ?? []) as ProjectRow[]);
  }

  async function loadIssues(projectId: string) {
    const { data, error } = await supabase
      .from("issues")
      .select(
        `
        id,project_id,title,description,severity,status,reporter_id,assignee_id,created_at,updated_at,
        countermeasure,action_items,
        assignee:profiles!issues_assignee_id_fkey(name)
      `
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const normalized = (data ?? []).map((row: any) => ({
      ...row,
      assignee: normalizeProfile(row.assignee as MaybeProfileJoin),
    })) as IssueRow[];

    setIssues(normalized);

    // ✅ 同步載入留言
    const ids = normalized.map((x) => x.id);
    await loadCommentsForIssues(ids);
  }

  async function loadCommentsForIssues(issueIds: string[]) {
    if (issueIds.length === 0) {
      setCommentsByIssue({});
      return;
    }

    const { data, error } = await supabase
      .from("issue_comments")
      .select("id,issue_id,content,author_id,created_at,updated_at")
      .in("issue_id", issueIds)
      .order("created_at", { ascending: false });

    if (error) {
      // 如果你還沒建表：就不要讓整頁掛掉
      setCommentsByIssue({});
      return;
    }

    const rows = (data ?? []) as IssueCommentRow[];
    const grouped: Record<string, IssueCommentRow[]> = {};
    for (const r of rows) {
      if (!grouped[r.issue_id]) grouped[r.issue_id] = [];
      grouped[r.issue_id].push(r);
    }
    setCommentsByIssue(grouped);
  }

  async function refreshAll() {
    setMsg("");
    try {
      await ensureLoggedIn();
      await loadProjects();
      if (selectedProjectId) await loadIssues(selectedProjectId);
      else {
        setIssues([]);
        setCommentsByIssue({});
      }
    } catch (e: any) {
      setMsg("❌ " + (e?.message ?? "unknown"));
    }
  }

  async function selectProject(projectId: string) {
    setMsg("");
    setSelectedProjectId(projectId);
    setIssues([]);
    setCommentsByIssue({});
    try {
      await ensureLoggedIn();
      await loadIssues(projectId);
    } catch (e: any) {
      setMsg("❌ 讀取 Issue 失敗：" + (e?.message ?? "unknown"));
    }
  }

  async function createIssue() {
    setMsg("");
    try {
      const user = await ensureLoggedIn();
      if (!selectedProjectId) return setMsg("請先選擇專案");
      if (!newTitle.trim()) return setMsg("請輸入異常標題");

      const { error } = await supabase.from("issues").insert({
        project_id: selectedProjectId,
        title: newTitle.trim(),
        description: newDesc.trim() ? newDesc.trim() : null,
        severity: newSeverity,
        status: "open",
        reporter_id: user.id,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;

      setNewTitle("");
      setNewDesc("");
      setNewSeverity(2);

      await loadIssues(selectedProjectId);
      setMsg("✅ 已新增異常");
    } catch (e: any) {
      setMsg("❌ 新增失敗：" + (e?.message ?? "unknown"));
    }
  }

  function openEdit(it: IssueRow) {
    setEditingId(it.id);
    setEditTitle(it.title ?? "");
    setEditDesc(it.description ?? "");
    setEditSeverity(clampSeverity(it.severity ?? 2));
    setEditStatus(it.status);
    setEditOpen(true);
  }

  async function saveEdit() {
    setMsg("");
    if (!editingId) return;
    if (!editTitle.trim()) return setMsg("請輸入異常標題");

    setSaving(true);
    try {
      await ensureLoggedIn();

      const { error } = await supabase
        .from("issues")
        .update({
          title: editTitle.trim(),
          description: editDesc.trim() ? editDesc.trim() : null,
          severity: editSeverity,
          status: editStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingId);

      if (error) throw error;

      setEditOpen(false);
      if (selectedProjectId) await loadIssues(selectedProjectId);
      setMsg("✅ 已更新");
    } catch (e: any) {
      setMsg("❌ 更新失敗：" + (e?.message ?? "unknown"));
    } finally {
      setSaving(false);
    }
  }

  async function deleteIssue(issueId: string) {
    const ok = confirm("確定要刪除這筆 Issue？");
    if (!ok) return;

    setMsg("");
    try {
      await ensureLoggedIn();
      const { error } = await supabase.from("issues").delete().eq("id", issueId);
      if (error) throw error;

      if (selectedProjectId) await loadIssues(selectedProjectId);
      setMsg("✅ 已刪除");
    } catch (e: any) {
      setMsg("❌ 刪除失敗：" + (e?.message ?? "unknown"));
    }
  }

  async function setIssueStatus(issueId: string, status: "open" | "doing" | "done") {
    setMsg("");
    try {
      await ensureLoggedIn();
      const { error } = await supabase
        .from("issues")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", issueId);
      if (error) throw error;

      if (selectedProjectId) await loadIssues(selectedProjectId);
    } catch (e: any) {
      setMsg("❌ 更新狀態失敗：" + (e?.message ?? "unknown"));
    }
  }

  async function assignToMe(issueId: string) {
    setMsg("");
    try {
      const user = await ensureLoggedIn();
      const { error } = await supabase
        .from("issues")
        .update({ assignee_id: user.id, updated_at: new Date().toISOString() })
        .eq("id", issueId);
      if (error) throw error;

      if (selectedProjectId) await loadIssues(selectedProjectId);
      setMsg("✅ 已指派給自己");
    } catch (e: any) {
      setMsg("❌ 指派失敗：" + (e?.message ?? "unknown"));
    }
  }

  // ✅ 新增留言（處理紀錄）
  async function addComment(issueId: string) {
    setMsg("");
    const text = cleanText(newCommentTextByIssue[issueId] ?? "");
    if (!text) return;

    try {
      const user = await ensureLoggedIn();

      const { error } = await supabase.from("issue_comments").insert({
        issue_id: issueId,
        author_id: user.id,
        content: text,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;

      setNewCommentTextByIssue((prev) => ({ ...prev, [issueId]: "" }));
      await loadCommentsForIssues(issues.map((x) => x.id));
    } catch (e: any) {
      setMsg("❌ 新增處理紀錄失敗：" + (e?.message ?? "unknown"));
    }
  }

  async function deleteComment(commentId: string) {
    const ok = confirm("確定要刪除此筆處理紀錄？");
    if (!ok) return;

    setMsg("");
    try {
      await ensureLoggedIn();
      const { error } = await supabase.from("issue_comments").delete().eq("id", commentId);
      if (error) throw error;

      await loadCommentsForIssues(issues.map((x) => x.id));
      setMsg("✅ 已刪除處理紀錄");
    } catch (e: any) {
      setMsg("❌ 刪除處理紀錄失敗：" + (e?.message ?? "unknown"));
    }
  }

  function startEditComment(c: IssueCommentRow) {
    setEditingCommentId(c.id);
    setEditingCommentText(c.content ?? "");
  }

  function cancelEditComment() {
    setEditingCommentId(null);
    setEditingCommentText("");
  }

  async function saveEditComment() {
    setMsg("");
    if (!editingCommentId) return;

    const text = cleanText(editingCommentText);
    if (!text) return setMsg("請輸入處理說明");

    try {
      await ensureLoggedIn();
      const { error } = await supabase
        .from("issue_comments")
        .update({ content: text, updated_at: new Date().toISOString() })
        .eq("id", editingCommentId);

      if (error) throw error;

      cancelEditComment();
      await loadCommentsForIssues(issues.map((x) => x.id));
      setMsg("✅ 已更新處理紀錄");
    } catch (e: any) {
      setMsg("❌ 更新處理紀錄失敗：" + (e?.message ?? "unknown"));
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div style={{ display: "flex" }}>
      <Sidebar />

      <div style={{ flex: 1, padding: 18, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Issues</div>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
              {selectedProjectId
                ? `專案：${selectedProject?.name ?? "（未知）"} · 總數 ${stats.total} · 未處理 ${stats.open} · 處理中 ${stats.doing} · 已完成 ${stats.done}`
                : "請先選擇專案，才會顯示 Issue 列表"}
            </div>
          </div>

          <button onClick={refreshAll} style={{ padding: "6px 10px", cursor: "pointer" }}>
            重新整理
          </button>
        </div>

        {msg && <p style={{ marginTop: 10, color: msg.startsWith("✅") ? "#0a0" : "#d11" }}>{msg}</p>}

        {!selectedProjectId ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>請選擇專案</div>

            {projects.length === 0 ? (
              <div style={{ padding: 14, border: "1px solid #eee", borderRadius: 10, opacity: 0.9 }}>
                （沒有可見專案，可能是 RLS 權限限制）
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => selectProject(p.id)}
                    style={{
                      textAlign: "left",
                      border: "1px solid #eee",
                      borderRadius: 12,
                      padding: 12,
                      cursor: "pointer",
                      background: "#fff",
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{p.name}</div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>點擊查看該專案 Issue</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => {
                  setSelectedProjectId("");
                  setIssues([]);
                  setCommentsByIssue({});
                  setMsg("");
                }}
                style={{ padding: "6px 10px", cursor: "pointer" }}
              >
                ← 回專案列表
              </button>

              <div style={{ fontSize: 12, opacity: 0.75 }}>
                目前專案：<b>{projectName(selectedProjectId)}</b>
              </div>
            </div>

            <div style={{ marginTop: 14, border: "1px solid #ddd", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 900 }}>新增 Issue（{projectName(selectedProjectId)}）</div>

              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="異常標題（必填）"
                  style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
                />

                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="異常描述（可選）"
                  rows={3}
                  style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
                />

                <select
                  value={String(newSeverity)}
                  onChange={(e) => setNewSeverity(clampSeverity(Number(e.target.value)))}
                  style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
                >
                  <option value="1">嚴重度：高</option>
                  <option value="2">嚴重度：中</option>
                  <option value="3">嚴重度：低</option>
                </select>

                <button onClick={createIssue} style={{ padding: "10px 14px", cursor: "pointer", borderRadius: 8 }}>
                  新增
                </button>
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontWeight: 900 }}>Issue 列表（點標題進詳細）</div>

              {issues.length === 0 ? (
                <p style={{ marginTop: 10 }}>目前沒有 Issue</p>
              ) : (
                <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
                  {issues.map((it) => {
                    const comments = commentsByIssue[it.id] ?? [];
                    return (
                      <div key={it.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 900 }}>
                              <Link href={`/app/issues/${it.id}`} style={{ textDecoration: "none" }}>
                                {it.title}
                              </Link>
                            </div>

                            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                              專案：{projectName(it.project_id)} · 嚴重度：
                              {it.severity === 1 ? "高" : it.severity === 2 ? "中" : "低"} · 狀態：
                              {it.status === "open" ? "未處理" : it.status === "doing" ? "處理中" : "完成"}
                            </div>

                            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>負責人：{it.assignee?.name ?? "（未指派）"}</div>

                            {it.description && <div style={{ marginTop: 8, opacity: 0.9, whiteSpace: "pre-wrap" }}>{it.description}</div>}

                            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
                              建立：{new Date(it.created_at).toLocaleString()} · 更新：{new Date(it.updated_at).toLocaleString()}
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 8, minWidth: 210 }}>
                            <button
                              onClick={() => assignToMe(it.id)}
                              style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 8 }}
                            >
                              指派給我
                            </button>

                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {(["open", "doing", "done"] as const).map((s) => {
                                const active = it.status === s;
                                return (
                                  <button
                                    key={s}
                                    onClick={() => setIssueStatus(it.id, s)}
                                    style={{
                                      padding: "6px 10px",
                                      borderRadius: 999,
                                      cursor: "pointer",
                                      border: active ? "1px solid #2563eb" : "1px solid #ddd",
                                      background: active ? "#2563eb" : "#fff",
                                      color: active ? "#fff" : "#111",
                                      fontSize: 12,
                                      fontWeight: 900,
                                    }}
                                  >
                                    {s === "open" ? "未處理" : s === "doing" ? "處理中" : "完成"}
                                  </button>
                                );
                              })}
                            </div>

                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                              <button onClick={() => openEdit(it)} style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 8 }}>
                                編輯
                              </button>
                              <button
                                onClick={() => deleteIssue(it.id)}
                                style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 8, border: "1px solid #fca5a5" }}
                              >
                                刪除
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* ✅ 這段就是你截圖要的「處理紀錄」區塊 */}
                        <div style={{ marginTop: 12 }}>
                          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ fontWeight: 900, fontSize: 13 }}>處理紀錄</div>
                            <div style={{ fontSize: 12, opacity: 0.65 }}>（日期時間 / 處理說明）</div>
                          </div>

                          {/* 新增處理紀錄 */}
                          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                            <input
                              value={newCommentTextByIssue[it.id] ?? ""}
                              onChange={(e) =>
                                setNewCommentTextByIssue((prev) => ({ ...prev, [it.id]: e.target.value }))
                              }
                              placeholder="輸入處理說明（例如：已回滾版本、調整參數、待驗證...）"
                              style={{
                                flex: 1,
                                padding: 10,
                                borderRadius: 10,
                                border: "1px solid #ddd",
                                outline: "none",
                              }}
                            />
                            <button
                              onClick={() => addComment(it.id)}
                              style={{ padding: "10px 14px", cursor: "pointer", borderRadius: 10 }}
                            >
                              新增
                            </button>
                          </div>

                          {/* 留言列表 */}
                          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                            {comments.length === 0 ? (
                              <div style={{ fontSize: 12, opacity: 0.7, padding: "10px 12px", border: "1px dashed #e5e7eb", borderRadius: 10 }}>
                                尚無處理紀錄
                              </div>
                            ) : (
                              comments.map((c) => {
                                const isEditing = editingCommentId === c.id;
                                return (
                                  <div
                                    key={c.id}
                                    style={{
                                      border: "1px solid #e5e7eb",
                                      borderRadius: 10,
                                      padding: "10px 12px",
                                      display: "flex",
                                      gap: 10,
                                      justifyContent: "space-between",
                                      alignItems: "flex-start",
                                    }}
                                  >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                                        {new Date(c.created_at).toLocaleString()}{" "}
                                        {c.updated_at && c.updated_at !== c.created_at ? <span style={{ opacity: 0.6 }}>（已編輯）</span> : null}
                                      </div>

                                      {!isEditing ? (
                                        <div style={{ marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                                          {c.content}
                                        </div>
                                      ) : (
                                        <div style={{ marginTop: 6 }}>
                                          <textarea
                                            value={editingCommentText}
                                            onChange={(e) => setEditingCommentText(e.target.value)}
                                            rows={3}
                                            style={{
                                              width: "100%",
                                              padding: 10,
                                              borderRadius: 10,
                                              border: "1px solid #ddd",
                                              outline: "none",
                                              resize: "vertical",
                                            }}
                                          />
                                          <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                            <button onClick={cancelEditComment} style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 10 }}>
                                              取消
                                            </button>
                                            <button onClick={saveEditComment} style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 10 }}>
                                              儲存
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    {!isEditing ? (
                                      <div style={{ display: "flex", gap: 8 }}>
                                        <button
                                          onClick={() => startEditComment(c)}
                                          style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 10 }}
                                        >
                                          編輯
                                        </button>
                                        <button
                                          onClick={() => deleteComment(c.id)}
                                          style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 10, border: "1px solid #fca5a5" }}
                                        >
                                          刪除
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>


                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {editOpen && (
          <div style={modalOverlay} onClick={() => !saving && setEditOpen(false)}>
            <div style={modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>編輯 Issue</div>
                <button onClick={() => !saving && setEditOpen(false)} style={{ padding: "6px 10px", cursor: "pointer" }}>
                  關閉
                </button>
              </div>

              <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                <div>
                  <div style={label}>標題</div>
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={input} disabled={saving} />
                </div>

                <div>
                  <div style={label}>描述</div>
                  <textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    style={{ ...input, height: 110, resize: "vertical" }}
                    disabled={saving}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={label}>嚴重度</div>
                    <select
                      value={String(editSeverity)}
                      onChange={(e) => setEditSeverity(clampSeverity(Number(e.target.value)))}
                      style={input}
                      disabled={saving}
                    >
                      <option value="1">高</option>
                      <option value="2">中</option>
                      <option value="3">低</option>
                    </select>
                  </div>

                  <div>
                    <div style={label}>狀態</div>
                    <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as any)} style={input} disabled={saving}>
                      <option value="open">未處理</option>
                      <option value="doing">處理中</option>
                      <option value="done">完成</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={saveEdit} disabled={saving} style={{ padding: "10px 14px", cursor: "pointer", borderRadius: 8 }}>
                    {saving ? "儲存中..." : "儲存"}
                  </button>
                </div>

                <div style={{ fontSize: 12, opacity: 0.7 }}>備註：刪除/更新若被擋，代表 RLS 權限正常生效。</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const modalOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 50,
};

const modalCard: React.CSSProperties = {
  width: "min(780px, 100%)",
  background: "#fff",
  borderRadius: 14,
  padding: 14,
  border: "1px solid #eee",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: 10,
  borderRadius: 10,
  border: "1px solid #ddd",
  outline: "none",
};

const label: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
  marginBottom: 6,
  fontWeight: 800,
};

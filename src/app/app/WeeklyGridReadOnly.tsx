"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type EngineerRow = {
  id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
  user_id?: string | null; // ✅ 對應 auth.users.id
};

type ProjectRow = { id: string; name: string };

type ScheduleItemRow = {
  id: string;
  engineer_id: string;
  work_date: string; // YYYY-MM-DD
  project_id: string | null;
  title: string;
  details: string | null;
  item_type: "work" | "leave" | "move";
  priority: 1 | 2 | 3;
  sort_order: number;
};

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function startOfWeekMon(d: Date) {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function weekdayLabel(i: number) {
  return ["一", "二", "三", "四", "五", "六", "日"][i] ?? "";
}

export default function WeeklyGridReadOnly() {
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMon(new Date()));

  const [engineers, setEngineers] = useState<EngineerRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [itemsThis, setItemsThis] = useState<ScheduleItemRow[]>([]);
  const [itemsNext, setItemsNext] = useState<ScheduleItemRow[]>([]);

  // ✅ auth / role / scope
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myEngineerId, setMyEngineerId] = useState<string | null>(null);

  const daysThis = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i)), [weekStart]);
  const daysNext = useMemo(() => Array.from({ length: 7 }).map((_, i) => addDays(addDays(weekStart, 7), i)), [weekStart]);

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return (id: string | null) => (id ? m.get(id) ?? "（未知專案）" : "（未選專案）");
  }, [projects]);

  const itemsByCellThis = useMemo(() => groupByCell(itemsThis), [itemsThis]);
  const itemsByCellNext = useMemo(() => groupByCell(itemsNext), [itemsNext]);

  function groupByCell(list: ScheduleItemRow[]) {
    const m = new Map<string, ScheduleItemRow[]>();
    for (const it of list) {
      const k = `${it.engineer_id}__${it.work_date}`;
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return m;
  }

  function cellBackground(list: ScheduleItemRow[] | undefined) {
    if (!list || list.length === 0) return "#fff";
    if (list.some((x) => x.item_type === "leave" || x.item_type === "move")) return "#ffe766";
    return "#fff";
  }

  function badgeColor(p: 1 | 2 | 3) {
    if (p === 1) return "#e74c3c";
    if (p === 2) return "#f39c12";
    return "#2ecc71";
  }

  // ✅ 讀取登入者 / admin 判斷（用 app_metadata.role === "admin"）
  async function loadAuthContext() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);

    const user = data.user;
    const uid = user?.id ?? null;
    setMyUserId(uid);

    const role = (user?.app_metadata as any)?.role;
    const admin = role === "admin";
    setIsAdmin(admin);

    return { uid, admin };
  }

  async function loadBase(uid: string | null, admin: boolean) {
    const pReq = supabase.from("projects").select("id,name").order("created_at", { ascending: false });

    let eReq = supabase
      .from("engineers")
      .select("id,name,phone,is_active,user_id")
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    // ✅ 非 admin：只載入自己的 engineers row
    if (!admin) {
      if (!uid) throw new Error("尚未登入");
      eReq = eReq.eq("user_id", uid);
    }

    const [eRes, pRes] = await Promise.all([eReq, pReq]);

    if (eRes.error) throw new Error(eRes.error.message);
    if (pRes.error) throw new Error(pRes.error.message);

    const eList = (eRes.data ?? []) as EngineerRow[];
    setEngineers(eList);
    setProjects((pRes.data ?? []) as ProjectRow[]);

    // ✅ 非 admin：通常只會有一筆
    if (!admin) {
      setMyEngineerId(eList[0]?.id ?? null);
    } else {
      setMyEngineerId(null);
    }

    return { eList };
  }

  async function loadRange(start: Date, endExclusive: Date, admin: boolean, myEngId: string | null) {
    let q = supabase
      .from("schedule_items")
      .select("id,engineer_id,work_date,project_id,title,details,item_type,priority,sort_order")
      .gte("work_date", toISODate(start))
      .lt("work_date", toISODate(endExclusive))
      .order("work_date", { ascending: true })
      .order("engineer_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    // ✅ 非 admin：只撈自己的 engineer_id（省流量 + 更快）
    if (!admin) {
      if (!myEngId) return [];
      q = q.eq("engineer_id", myEngId);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as ScheduleItemRow[];
  }

  async function refresh(ws: Date) {
    setMsg("");
    setLoading(true);
    try {
      const { uid, admin } = await loadAuthContext();
      const { eList } = await loadBase(uid, admin);

      // ✅ 非 admin：用這次 loadBase 拿到的 engineer_id（避免 state 尚未同步）
      const myEngIdLocal = admin ? null : eList[0]?.id ?? null;
      if (!admin && !myEngIdLocal) {
        throw new Error("找不到對應的工程師資料（engineers.user_id 未綁定或 is_active=false）");
      }

      const ns = addDays(ws, 7);
      const [a, b] = await Promise.all([
        loadRange(ws, addDays(ws, 7), admin, myEngIdLocal),
        loadRange(ns, addDays(ns, 7), admin, myEngIdLocal),
      ]);

      setItemsThis(a);
      setItemsNext(b);
    } catch (e: any) {
      setMsg("❌ " + (e?.message ?? "unknown"));
      setEngineers([]);
      setItemsThis([]);
      setItemsNext([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(weekStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* 工具列 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ fontWeight: 600, color: "#4b5563" }}>
          {" "}
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            {isAdmin ? "（管理員：全部）" : "（user）"}
            {myUserId ? "" : "（未登入）"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setWeekStart((w) => addDays(w, -7))} style={btn}>
            ← 上一週
          </button>
          <button onClick={() => setWeekStart(startOfWeekMon(new Date()))} style={btn}>
            本週
          </button>
          <button onClick={() => setWeekStart((w) => addDays(w, 7))} style={btn}>
            下一週 →
          </button>
        </div>
      </div>

      {msg && (
        <div style={{ color: "#b91c1c", fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
          <span>⚠️</span>
          {msg}
        </div>
      )}

      {/* 本週 */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 10 }}>本週行程</div>

        <div style={panel}>
          {loading ? (
            <div style={{ padding: 12, color: "#6b7280" }}>載入中...</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>工程師</th>
                    {daysThis.map((d, idx) => {
                      const label = `${d.getMonth() + 1}月${d.getDate()}日`;
                      const isWeekend = idx >= 5;
                      return (
                        <th key={idx} style={{ ...th, color: isWeekend ? "#c11" : "#111" }}>
                          <div style={{ fontWeight: 900 }}>{label}</div>
                          <div style={{ fontSize: 12, opacity: 0.85 }}>{weekdayLabel(idx)}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody>
                  {engineers.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: 14, border: "1px solid #e5e7eb" }}>
                        {isAdmin
                          ? "（尚無工程師資料。請先在 engineers 表新增。）"
                          : "（找不到你的工程師資料。請確認 engineers.user_id 已綁定你的帳號，且 is_active=true。）"}
                      </td>
                    </tr>
                  ) : (
                    engineers.map((eng) => (
                      <tr key={eng.id}>
                        <td style={tdLeft}>
                          <div style={{ fontWeight: 900 }}>{eng.name}</div>
                          {eng.phone && <div style={{ fontSize: 12, opacity: 0.75 }}>{eng.phone}</div>}
                          {!isAdmin && (
                            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}></div>
                          )}
                        </td>

                        {daysThis.map((d, idx) => {
                          const dateISO = toISODate(d);
                          const k = `${eng.id}__${dateISO}`;
                          const list = itemsByCellThis.get(k) ?? [];
                          return (
                            <td
                              key={idx}
                              style={{
                                ...tdCell,
                                background: cellBackground(list),
                              }}
                              title="儀表板只讀"
                            >
                              {list.length === 0 ? (
                                <div style={{ opacity: 0.35, fontSize: 12 }}>（空）</div>
                              ) : (
                                <div style={{ display: "grid", gap: 8 }}>
                                  {list.map((it) => (
                                    <div
                                      key={it.id}
                                      style={{
                                        border: "1px solid #e5e7eb",
                                        borderRadius: 10,
                                        padding: 10,
                                        background: "#fff",
                                      }}
                                    >
                                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                        <div style={{ fontWeight: 900, fontSize: 13, whiteSpace: "pre-wrap" }}>
                                          {it.title}
                                        </div>
                                        <div
                                          style={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: 999,
                                            marginTop: 3,
                                            background: badgeColor(it.priority),
                                            flex: "0 0 auto",
                                          }}
                                          title={`優先度 ${it.priority}`}
                                        />
                                      </div>

                                      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                                        {it.item_type === "leave"
                                          ? "休假"
                                          : it.item_type === "move"
                                          ? "移動"
                                          : projectName(it.project_id)}
                                      </div>

                                      {it.details && (
                                        <div
                                          style={{
                                            marginTop: 6,
                                            fontSize: 12,
                                            opacity: 0.9,
                                            whiteSpace: "pre-wrap",
                                          }}
                                        >
                                          {it.details}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, color: "#6b7280", padding: "0 10px 10px" }}>
                顏色規則：格子內包含「休假/移動」會整格變黃；卡片右上圓點代表優先度（1紅 2橘 3綠）。
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 下週 */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 10 }}>下週行程</div>

        <div style={panel}>
          {loading ? (
            <div style={{ padding: 12, color: "#6b7280" }}>載入中...</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>工程師</th>
                    {daysNext.map((d, idx) => {
                      const label = `${d.getMonth() + 1}月${d.getDate()}日`;
                      const isWeekend = idx >= 5;
                      return (
                        <th key={idx} style={{ ...th, color: isWeekend ? "#c11" : "#111" }}>
                          <div style={{ fontWeight: 900 }}>{label}</div>
                          <div style={{ fontSize: 12, opacity: 0.85 }}>{weekdayLabel(idx)}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody>
                  {engineers.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: 14, border: "1px solid #e5e7eb" }}>
                        {isAdmin
                          ? "（尚無工程師資料。請先在 engineers 表新增。）"
                          : "（找不到你的工程師資料。請確認 engineers.user_id 已綁定你的帳號，且 is_active=true。）"}
                      </td>
                    </tr>
                  ) : (
                    engineers.map((eng) => (
                      <tr key={eng.id}>
                        <td style={tdLeft}>
                          <div style={{ fontWeight: 900 }}>{eng.name}</div>
                          {eng.phone && <div style={{ fontSize: 12, opacity: 0.75 }}>{eng.phone}</div>}
                          {!isAdmin && (
                            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>（只顯示我的行程）</div>
                          )}
                        </td>

                        {daysNext.map((d, idx) => {
                          const dateISO = toISODate(d);
                          const k = `${eng.id}__${dateISO}`;
                          const list = itemsByCellNext.get(k) ?? [];
                          return (
                            <td
                              key={idx}
                              style={{
                                ...tdCell,
                                background: cellBackground(list),
                              }}
                              title="儀表板只讀"
                            >
                              {list.length === 0 ? (
                                <div style={{ opacity: 0.35, fontSize: 12 }}>（空）</div>
                              ) : (
                                <div style={{ display: "grid", gap: 8 }}>
                                  {list.map((it) => (
                                    <div
                                      key={it.id}
                                      style={{
                                        border: "1px solid #e5e7eb",
                                        borderRadius: 10,
                                        padding: 10,
                                        background: "#fff",
                                      }}
                                    >
                                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                        <div style={{ fontWeight: 900, fontSize: 13, whiteSpace: "pre-wrap" }}>
                                          {it.title}
                                        </div>
                                        <div
                                          style={{
                                            width: 10,
                                            height: 10,
                                            borderRadius: 999,
                                            marginTop: 3,
                                            background: badgeColor(it.priority),
                                            flex: "0 0 auto",
                                          }}
                                          title={`優先度 ${it.priority}`}
                                        />
                                      </div>

                                      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                                        {it.item_type === "leave"
                                          ? "休假"
                                          : it.item_type === "move"
                                          ? "移動"
                                          : projectName(it.project_id)}
                                      </div>

                                      {it.details && (
                                        <div
                                          style={{
                                            marginTop: 6,
                                            fontSize: 12,
                                            opacity: 0.9,
                                            whiteSpace: "pre-wrap",
                                          }}
                                        >
                                          {it.details}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, color: "#6b7280", padding: "0 10px 10px" }}>
                顏色規則：格子內包含「休假/移動」會整格變黃；卡片右上圓點代表優先度（1紅 2橘 3綠）。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 14,
  color: "#6b7280",
  backgroundColor: "transparent",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  cursor: "pointer",
  transition: "all 0.2s",
};

const panel: React.CSSProperties = {
  backgroundColor: "#fff",
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  overflow: "hidden",
};

const table: React.CSSProperties = {
  borderCollapse: "collapse",
  minWidth: 1200,
  width: "100%",
  background: "#fff",
};

const th: React.CSSProperties = {
  border: "1px solid #000",
  padding: 10,
  background: "#ffe766",
  textAlign: "center",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
};

const tdLeft: React.CSSProperties = {
  border: "1px solid #000",
  padding: 10,
  background: "#fff",
  fontWeight: 900,
  width: 160,
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

const tdCell: React.CSSProperties = {
  border: "1px solid #000",
  padding: 10,
  verticalAlign: "top",
  minWidth: 150,
};

import PageHeader from '../_components/PageHeader'

export default function ManagerPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="主管中心"
        description="集中處理待審核（每日工作單、任務驗收），並查看團隊風險。"
      />

      <div className="rounded border bg-white p-4 space-y-2">
        <div className="text-sm text-gray-600">初版功能（待完成）</div>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>待審核清單（v_dashboard_manager_inbox）</li>
          <li>核准/退回（更新 approvals + 寫 approval_actions）</li>
          <li>團隊逾期/卡關（v_dashboard_overdue_issues / v_dashboard_team_workload）</li>
        </ul>
      </div>
    </div>
  )
}

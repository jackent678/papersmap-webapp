import PageHeader from '../../_components/PageHeader'

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ issueId: string }>
}) {
  const { issueId } = await params

  return (
    <div className="space-y-6">
      <PageHeader
        title={`任務詳情：${issueId}`}
        description="顯示任務內容、狀態流轉、留言/附件、送審/驗收。"
      />

      <div className="rounded border bg-white p-4 space-y-2">
        <div className="text-sm text-gray-600">初版規劃（待完成）</div>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>任務主資料（issues）</li>
          <li>狀態變更：todo → doing → ready_for_review → done</li>
          <li>送審：建立 approvals(target_type=issue)</li>
          <li>退回/核准：approval_actions 記錄</li>
        </ul>
      </div>
    </div>
  )
}

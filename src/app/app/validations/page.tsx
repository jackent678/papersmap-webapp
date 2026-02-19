import PageHeader from '../_components/PageHeader'

export default function ValidationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="審核紀錄"
        description="查看所有送審、核准、退回的歷史紀錄與留言。"
      />

      <div className="rounded border bg-white p-4 space-y-2">
        <div className="text-sm text-gray-600">初版功能（待完成）</div>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>approval 列表（approvals）</li>
          <li>動作流水（approval_actions）</li>
          <li>依 target_type / requester / reviewer / status 篩選</li>
        </ul>
      </div>
    </div>
  )
}

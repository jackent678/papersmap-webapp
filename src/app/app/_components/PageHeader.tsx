export default function PageHeader({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-bold">{title}</h1>
      {description ? <p className="text-sm text-gray-600">{description}</p> : null}
    </div>
  )
}

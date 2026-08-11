/** 結果の上に出る「項目: 値」の一覧 */
export function Meta({ items }: { items: [string, string | number][] }) {
  return (
    <dl className="text-muted-foreground mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs">
      {items.map(([key, value]) => (
        <div key={key} className="flex gap-1.5">
          <dt>{key}:</dt>
          <dd className="text-foreground font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

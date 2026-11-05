/**
 * 월 요금 추정 [가정]. 백엔드에는 요금 추정기가 없으므로, 공개 요금표에서 옮겨 적은 작은 가격표(아래 PRICE_BOOK)와
 * 받은 데이터(원본: 분석 스캔이 찾은 인벤토리, 대상: 계획 미리보기의 리소스)로 화면이 직접 계산한다.
 * 값은 추정이다: 리전 단가 × 수량 × 730시간(GB 단가는 × 용량). 전송·요청 수처럼 사용량에 따라 달라지는 값은 넣지 않는다.
 * 온프레미스 대상은 가격표가 없다: 추가 클라우드 비용이 없고 하드웨어·전력은 범위 밖이다.
 * 순수 함수·데이터만 둔다(런타임 import 없음).
 */
import type { AnalysisScanData, CostEstimate, CostLine, PlanResource } from './events'

export type CostLineId = 'control' | 'lb' | 'nat' | 'nodes' | 'disk' | 'db'
/** 화면에 늘 보이는 줄 순서. transfer는 사용량에 따라 달라 늘 '미포함'이다. */
export const COST_LINES: CostLineId[] = ['control', 'lb', 'nat', 'nodes', 'disk', 'db']
export const EXCLUDED_LINES = ['transfer'] as const

/** hour: 시간당 USD(× 730) · gb_month: GB·월당 USD */
export type Price = { line: CostLineId; unit: 'hour' | 'gb_month'; usd: number }
export type PriceTable = {
  provider: 'AWS' | 'GCP'
  region: string
  /** 가격을 옮겨 적은 날(화면의 '기준일') */
  basis_date: string
  /** 근거: 어느 공개 요금표인지(화면에 그대로 보인다) */
  basis: string
  prices: Record<string, Price>
  /** 원본 인벤토리 key(분석 스캔 items[].key) → 가격 id. sku가 오면 sku를 먼저 찾는다. */
  inventory?: Record<string, string>
  /** 대상 리소스 유형(Preview resource_type)마다 따라붙는 고정 요금. per_node면 수량 = 노드 수 */
  implied?: Record<string, Array<{ price: string; per_node?: boolean }>>
  /** 월 크레딧(예: GKE 청구 계정당 클러스터 하나 관리비 무료) */
  credits?: Array<{ price: string; usd_per_month: number }>
}

export const HOURS_PER_MONTH = 730

/** [가정] 공개 요금표 값(온디맨드, 세금 제외). 화면의 기준일이 이 값을 옮긴 날이다. */
export const PRICE_BOOK: Record<string, PriceTable> = {
  'AWS:ap-northeast-2': {
    provider: 'AWS', region: 'ap-northeast-2', basis_date: '2026-11-03', basis: 'aws.amazon.com/eks · ec2 · elasticloadbalancing · vpc pricing',
    prices: {
      'eks.cluster': { line: 'control', unit: 'hour', usd: 0.10 },
      'elb.alb': { line: 'lb', unit: 'hour', usd: 0.0225 },
      'vpc.nat_gateway': { line: 'nat', unit: 'hour', usd: 0.059 },
      't3.large': { line: 'nodes', unit: 'hour', usd: 0.104 },
      't3.medium': { line: 'nodes', unit: 'hour', usd: 0.052 },
      'm5.large': { line: 'nodes', unit: 'hour', usd: 0.118 },
      'ebs.gp3': { line: 'disk', unit: 'gb_month', usd: 0.0912 },
    },
    inventory: { eks_cluster: 'eks.cluster', alb: 'elb.alb', nat_gateway: 'vpc.nat_gateway', ebs_gb: 'ebs.gp3' },
  },
  'GCP:asia-northeast3': {
    provider: 'GCP', region: 'asia-northeast3', basis_date: '2026-11-03', basis: 'cloud.google.com/kubernetes-engine · compute · sql · nat pricing',
    prices: {
      'gke.cluster': { line: 'control', unit: 'hour', usd: 0.10 },
      'lb.forwarding_rule': { line: 'lb', unit: 'hour', usd: 0.025 },
      'nat.vm': { line: 'nat', unit: 'hour', usd: 0.0014 },
      'e2-standard-2': { line: 'nodes', unit: 'hour', usd: 0.0860 },
      'e2-standard-4': { line: 'nodes', unit: 'hour', usd: 0.1720 },
      'db-custom-2-7680': { line: 'db', unit: 'hour', usd: 0.1733 },
      'sql.ssd': { line: 'disk', unit: 'gb_month', usd: 0.221 },
    },
    implied: {
      CLUSTER: [{ price: 'gke.cluster' }],
      INGRESS: [{ price: 'lb.forwarding_rule' }],
      NETWORK: [{ price: 'nat.vm', per_node: true }],
    },
    credits: [{ price: 'gke.cluster', usd_per_month: 74.4 }],
  },
}

export function priceTableFor(provider: string | undefined, region: string | undefined): PriceTable | null {
  if (!provider || !region) return null
  return PRICE_BOOK[provider + ':' + region] ?? null
}

export type Usage = { price: string; qty: number }

/** 원본 사용량: 분석 스캔이 찾은 인벤토리(items[].sku 또는 key)를 가격표에서 찾는다. */
export function sourceUsage(scans: AnalysisScanData[], table: PriceTable): Usage[] {
  const usage: Usage[] = []
  for (const scan of scans) {
    if (scan.stream !== 'infrastructure') continue
    for (const item of scan.items) {
      const id = item.sku && table.prices[item.sku] ? item.sku : table.inventory?.[item.key]
      if (id && table.prices[id]) usage.push({ price: id, qty: item.n })
    }
  }
  return usage
}

const GIB = /(\d+(?:\.\d+)?)\s*Gi?B\b/i
const TIMES = /[×x]\s*(\d+)\b/

/**
 * 대상 사용량: 미리보기 리소스의 크기 문자열에서 가격표에 있는 SKU를 찾고(예: 'e2-standard-2 × 2'),
 * 용량(예: '20 GiB SSD')은 GB 단가 SKU로, 리소스 유형마다 따라붙는 고정 요금(클러스터 관리·전달 규칙·NAT)을 더한다.
 */
export function targetUsage(resources: PlanResource[], table: PriceTable): Usage[] {
  const usage: Usage[] = []
  const live = resources.filter(resource => resource.change !== 'KEEP_SOURCE' && resource.change !== 'DELETE')
  let nodes = 0
  for (const resource of live) {
    const text = [resource.size, resource.size_detail].filter(Boolean).join(' ')
    const qty = resource.quantity ?? Number(TIMES.exec(text)?.[1] ?? 1)
    for (const [id, price] of Object.entries(table.prices)) {
      if (price.unit !== 'hour' || !text.includes(id)) continue
      usage.push({ price: id, qty })
      if (price.line === 'nodes') nodes += qty
    }
    const gb = GIB.exec(text)
    const disk = Object.entries(table.prices).find(([, price]) => price.unit === 'gb_month')
    if (gb && disk && (resource.kind === 'database' || resource.resource_type === 'DATABASE')) usage.push({ price: disk[0], qty: Number(gb[1]) })
  }
  for (const resource of live) {
    const type = resource.resource_type ?? TYPE_OF_ID[resource.id]
    for (const fee of (type && table.implied?.[type]) || []) usage.push({ price: fee.price, qty: fee.per_node ? Math.max(1, nodes) : 1 })
  }
  return usage
}
/** 리소스에 resource_type이 없을 때(예전 미리보기) id로 유형을 짐작한다. */
const TYPE_OF_ID: Record<string, string> = { vpc: 'NETWORK', lb: 'INGRESS', cluster: 'CLUSTER', app: 'APP', db: 'DATABASE', storage: 'STORAGE' }

/** 계산 근거 한 줄: 가격 id(SKU) × 수량 · 단가(화면이 단위 문구를 붙인다) */
export type CostItem = { sku: string; qty: number; unit: Price['unit']; usd: number }
function monthly(usage: Usage[], table: PriceTable): { sums: Partial<Record<CostLineId, number>>; items: Partial<Record<CostLineId, CostItem[]>> } {
  const sums: Partial<Record<CostLineId, number>> = {}
  const items: Partial<Record<CostLineId, CostItem[]>> = {}
  for (const { price: id, qty } of usage) {
    const price = table.prices[id]
    const amount = price.unit === 'hour' ? price.usd * HOURS_PER_MONTH * qty : price.usd * qty
    sums[price.line] = (sums[price.line] ?? 0) + amount
    items[price.line] = [...(items[price.line] ?? []), { sku: id, qty, unit: price.unit, usd: price.usd }]
  }
  return { sums, items }
}
const round = (value: number) => Math.round(value * 10) / 10

export type CostBasis = { provider: string; region: string; date: string; basis: string }
/** 화면이 그리는 추정. target_usd가 null이면 그 줄은 대상에 가격표가 없다(온프레미스). items는 줄마다 계산 근거. */
export type CostViewLine = CostLine & { items?: { source: CostItem[]; target: CostItem[] } }
export type CostView = Omit<CostEstimate, 'lines'> & { lines: CostViewLine[]; bases: CostBasis[]; noCloudTarget: boolean }

/**
 * 원본·대상 월 요금 추정. 한쪽에만 있는 줄은 다른 쪽을 0으로 본다(그 리소스가 없다). 두 쪽 모두 0인 줄은 뺀다.
 * 대상 가격표가 없으면(온프레미스) 대상 값은 null이고 noCloudTarget이 참이다.
 */
export function estimateCost(input: {
  source: { provider?: string; location?: string }
  target: { provider?: string; location?: string }
  scans: AnalysisScanData[]
  resources: PlanResource[]
}): CostView | null {
  // 원본 인벤토리(인프라 스캔)를 아직 받지 못했으면 원본 값은 모른다(0이 아니라 null).
  const scanned = input.scans.some(scan => scan.stream === 'infrastructure')
  const sourceTable = scanned ? priceTableFor(input.source.provider, input.source.location) : null
  const targetTable = priceTableFor(input.target.provider, input.target.location)
  if (!sourceTable && !targetTable) return null
  const sourceCost = sourceTable ? monthly(sourceUsage(input.scans, sourceTable), sourceTable) : { sums: {}, items: {} }
  const targetCost = targetTable ? monthly(targetUsage(input.resources, targetTable), targetTable) : { sums: {}, items: {} }
  const source = sourceCost.sums
  const target = targetCost.sums
  const lines: CostViewLine[] = COST_LINES
    .filter(id => (source[id] ?? 0) > 0 || (target[id] ?? 0) > 0)
    .map(id => ({
      id, source_usd: sourceTable ? round(source[id] ?? 0) : null, target_usd: targetTable ? round(target[id] ?? 0) : null,
      items: { source: sourceCost.items[id] ?? [], target: targetCost.items[id] ?? [] },
    }))
  if (lines.length === 0) return null
  for (const id of EXCLUDED_LINES) lines.push({ id, source_usd: null, target_usd: null, excluded: true })
  const credits = targetTable?.credits?.filter(credit => (target[targetTable.prices[credit.price].line] ?? 0) > 0).reduce((sum, credit) => sum + credit.usd_per_month, 0) ?? 0
  const bases = [sourceTable, targetTable].filter((table): table is PriceTable => !!table)
    .map(table => ({ provider: table.provider, region: table.region, date: table.basis_date, basis: table.basis }))
  return { currency: 'USD', lines, ...(credits > 0 ? { credits_usd: credits } : {}), basis: bases[0]?.date, bases, noCloudTarget: !targetTable }
}

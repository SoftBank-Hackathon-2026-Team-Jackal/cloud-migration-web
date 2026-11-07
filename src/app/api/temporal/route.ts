import { temporalUiUrl } from '../../../lib/temporalUi'

export const dynamic = 'force-dynamic'

/**
 * Temporal 사이드바: Temporal UI 서버의 HTTP API(src/lib/temporalUi.ts)로 이전 한 건(MigrationWorkflow 루트)과
 * 같은 루트에 속한 워크플로의 상태를 돌려준다. 읽기만 한다. wf가 없으면 가장 최근 MigrationWorkflow.
 */
const BASE = temporalUiUrl()
const NS = process.env.TEMPORAL_NAMESPACE || 'default'

type Exec = { execution: { workflowId: string }; type: { name: string }; status: string; startTime?: string; closeTime?: string }

async function list(query: string): Promise<Exec[]> {
  const res = await fetch(`${BASE}/api/v1/namespaces/${NS}/workflows?pageSize=50&query=${encodeURIComponent(query)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Temporal UI ${res.status}`)
  return (await res.json()).executions || []
}

export async function GET(request: Request) {
  let root = new URL(request.url).searchParams.get('wf')
  if (root && !/^[\w.:-]+$/.test(root)) return Response.json({ error: 'invalid wf' }, { status: 400 })
  try {
    if (!root) {
      const [latest] = await list('WorkflowType="MigrationWorkflow"')
      if (!latest) return Response.json({ root: null, workflows: [] })
      root = latest.execution.workflowId
    }
    const workflows = (await list(`RootWorkflowId="${root}"`))
      .map(e => ({ id: e.execution.workflowId, type: e.type.name, status: e.status.replace('WORKFLOW_EXECUTION_STATUS_', ''), start: e.startTime, close: e.closeTime }))
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    return Response.json({ root, workflows })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}

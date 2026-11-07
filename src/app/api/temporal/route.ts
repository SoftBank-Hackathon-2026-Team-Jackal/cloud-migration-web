export const dynamic = 'force-dynamic'

/**
 * Temporal UI 서버의 HTTP API(TEMPORAL_UI_URL, 로컬 기본 http://127.0.0.1:8233)를 읽어
 * 이전 한 건(MigrationWorkflow 루트)의 워크플로 트리와 최근 이벤트를 돌려준다. 읽기만 한다.
 */
const BASE = (process.env.TEMPORAL_UI_URL || 'http://127.0.0.1:8233').replace(/\/+$/, '')
const NS = process.env.TEMPORAL_NAMESPACE || 'default'

type Exec = { execution: { workflowId: string }; type: { name: string }; status: string; startTime?: string; closeTime?: string }
type Ev = { eventId: string; eventTime: string; eventType: string; [k: string]: unknown }

async function get(path: string) {
  const res = await fetch(`${BASE}/api/v1/namespaces/${NS}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

const list = (query: string) => get(`/workflows?pageSize=50&query=${encodeURIComponent(query)}`).then(d => (d.executions || []) as Exec[])

function short(type: string) {
  return type.replace(/^EVENT_TYPE_/, '')
}

/** 사람이 읽을 이벤트만 골라 한 줄로 */
function describe(ev: Ev, scheduled: Map<string, string>): { kind: string; text: string } | null {
  const attr = (k: string) => ev[k] as Record<string, any> | undefined
  switch (ev.eventType) {
    case 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED': {
      const name = attr('activityTaskScheduledEventAttributes')?.activityType?.name
      scheduled.set(ev.eventId, name)
      return { kind: 'start', text: name }
    }
    case 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED':
      return { kind: 'done', text: scheduled.get(attr('activityTaskCompletedEventAttributes')?.scheduledEventId) || 'activity' }
    case 'EVENT_TYPE_ACTIVITY_TASK_FAILED':
    case 'EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT': {
      const a = attr('activityTaskFailedEventAttributes') || attr('activityTaskTimedOutEventAttributes')
      return { kind: 'fail', text: `${scheduled.get(a?.scheduledEventId) || 'activity'} ${a?.failure?.message || ''}`.trim() }
    }
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED':
      return { kind: 'signal', text: `signal ${attr('workflowExecutionSignaledEventAttributes')?.signalName}` }
    case 'EVENT_TYPE_TIMER_STARTED':
      return { kind: 'timer', text: `timer ${attr('timerStartedEventAttributes')?.startToFireTimeout || ''}` }
    case 'EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED':
      return { kind: 'child', text: `child ▶ ${attr('childWorkflowExecutionStartedEventAttributes')?.workflowType?.name}` }
    case 'EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED':
      return { kind: 'child', text: `child ✓ ${attr('childWorkflowExecutionCompletedEventAttributes')?.workflowType?.name}` }
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED':
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED':
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED':
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED':
    case 'EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED':
      return { kind: ev.eventType.endsWith('FAILED') || ev.eventType.endsWith('TERMINATED') ? 'fail' : 'wf', text: short(ev.eventType).replace('WORKFLOW_EXECUTION_', 'workflow ').toLowerCase() }
    default:
      return null
  }
}

export async function GET(request: Request) {
  try {
    let root = new URL(request.url).searchParams.get('wf')
    if (root && !/^[\w.:-]+$/.test(root)) return Response.json({ error: 'invalid wf' }, { status: 400 })
    if (!root) {
      const [latest] = await list('WorkflowType="MigrationWorkflow"')
      if (!latest) return Response.json({ root: null, workflows: [], events: [] })
      root = latest.execution.workflowId
    }
    const members = await list(`RootWorkflowId="${root}"`)
    const workflows = members
      .map(e => ({ id: e.execution.workflowId, type: e.type.name, status: e.status.replace('WORKFLOW_EXECUTION_STATUS_', ''), start: e.startTime, close: e.closeTime }))
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''))

    const histories = await Promise.all(workflows.map(async w => {
      const d = await get(`/workflows/${encodeURIComponent(w.id)}/history?maximumPageSize=1000`)
      const scheduled = new Map<string, string>()
      return ((d.history?.events || []) as Ev[]).flatMap(ev => {
        const line = describe(ev, scheduled)
        return line ? [{ time: ev.eventTime, workflow: w.type.replace(/Workflow$/, ''), ...line }] : []
      })
    }))
    const events = histories.flat().sort((a, b) => b.time.localeCompare(a.time)).slice(0, 40)
    return Response.json({ root, uiUrl: `${BASE}/namespaces/${NS}/workflows/${root}`, workflows, events })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}

/**
 * 실제 모드에서 돌고 있는 이전의 ID를 새로 고침·새 탭에도 이어 쓰게 둔다.
 * - 주소: ?migration=<id>(다른 탭·다른 사람에게 그대로 넘길 수 있다)
 * - sessionStorage: 같은 탭에서 주소가 바뀌어도 남는다. 고른 대상(target)도 함께 둔다.
 * 브라우저 객체는 인자로 받는다(시험에서 가짜를 넣는다).
 */
import type { BackendPhase, Target } from './events.ts'
import type { Stage } from '../stages.ts'

export const MIGRATION_PARAM = 'migration'
export const SESSION_KEY = 'jackal.migration'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type SessionEnv = {
  location: { href: string }
  history: { state: unknown; replaceState: (data: unknown, unused: string, url?: string | URL | null) => void }
  storage: StorageLike | null
}

export type SavedMigration = { id: string; target: Target | null }

/** 이전 ID로 쓸 수 있는 값(서버 workflow_id 모양: 영문·숫자·-_.:)인지 */
const validId = (value: string | null | undefined): value is string => !!value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const validTarget = (value: unknown): value is Target => value === 'gcp' || value === 'onprem'

function readStored(storage: StorageLike | null): SavedMigration | null {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { id?: unknown; target?: unknown }
    if (typeof data.id !== 'string' || !validId(data.id)) return null
    return { id: data.id, target: validTarget(data.target) ? data.target : null }
  } catch {
    return null
  }
}

/** 이어 붙을 이전: 주소의 ?migration=이 먼저, 없으면 이 탭에 저장한 값. 대상은 주소 ?target= → 같은 ID로 저장한 값. */
export function readMigration(env: SessionEnv): SavedMigration | null {
  const url = new URL(env.location.href)
  const fromUrl = url.searchParams.get(MIGRATION_PARAM)
  const stored = readStored(env.storage)
  const id = validId(fromUrl) ? fromUrl : stored?.id
  if (!id) return null
  const urlTarget = url.searchParams.get('target')
  const target = validTarget(urlTarget) ? urlTarget : stored?.id === id ? stored.target : null
  return { id, target }
}

/** 시작한 이전을 주소(?migration=)와 이 탭의 sessionStorage에 남긴다. 다른 쿼리는 그대로 둔다. */
export function saveMigration(env: SessionEnv, saved: SavedMigration) {
  if (!validId(saved.id)) return
  const url = new URL(env.location.href)
  url.searchParams.set(MIGRATION_PARAM, saved.id)
  if (saved.target) url.searchParams.set('target', saved.target)
  // 단계 바로 열기(?stage=)는 다시 붙을 때 쓰지 않는다: 지우지 않으면 새로 고침이 그 단계로 건너뛴다.
  url.searchParams.delete('stage')
  env.history.replaceState(env.history.state, '', url.toString())
  try { env.storage?.setItem(SESSION_KEY, JSON.stringify(saved)) } catch { /* 저장소를 못 쓰면 주소만 */ }
}

/** 서버가 모르는 이전(404)이면 주소와 저장소에서 지운다. */
export function clearMigration(env: SessionEnv) {
  const url = new URL(env.location.href)
  if (url.searchParams.has(MIGRATION_PARAM)) {
    url.searchParams.delete(MIGRATION_PARAM)
    env.history.replaceState(env.history.state, '', url.toString())
  }
  try { env.storage?.removeItem(SESSION_KEY) } catch { /* 무시 */ }
}

/** 마지막 이벤트의 phase → 열 화면. 아직 이벤트가 없으면 분석 화면. */
const STAGE_OF_PHASE: Record<BackendPhase, Stage> = {
  analysis: 'analysis', build: 'rehearsal', planning: 'planning', awaiting_approval: 'approval',
  provisioning: 'provisioning', data_copy: 'data', traffic: 'traffic', verification: 'cutover',
}
export function stageForPhase(phase: BackendPhase | null): Stage {
  return phase ? STAGE_OF_PHASE[phase] ?? 'analysis' : 'analysis'
}

/** 브라우저의 진짜 객체(서버 렌더링 중이면 null) */
export function browserSession(): SessionEnv | null {
  if (typeof window === 'undefined') return null
  let storage: StorageLike | null = null
  try { storage = window.sessionStorage } catch { storage = null }
  return { location: window.location, history: window.history, storage }
}

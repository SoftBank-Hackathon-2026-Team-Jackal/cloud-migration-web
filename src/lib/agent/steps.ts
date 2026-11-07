import type { MsgKey } from '../i18n'

/** 서버가 보내는 진행 단계 → 화면 문구 키. 모르는 단계는 '생각 중'으로 보인다. */
export const AGENT_STEP_KEYS: Record<string, MsgKey> = {
  reading_state: 'agent.step.reading_state' as MsgKey,
  asking_model: 'agent.step.asking_model' as MsgKey,
  translating: 'agent.step.translating' as MsgKey,
  fallback: 'agent.step.fallback' as MsgKey,
}

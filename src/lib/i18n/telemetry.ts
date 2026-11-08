/**
 * 앱 관측(OpenTelemetry) 패널 문구. ko·en·ja 사전에 펼쳐 넣는다(다른 작업과 겹치지 않게 따로 둔다).
 */
export const telemetryKo = {
  "otel.title": "앱 관측",
  "otel.tag": "OpenTelemetry",
  "otel.desc": "이전 대상 앱이 직접 보낸 값이에요(최근 5분). 오류율과 p99 판정은 위의 Envoy 값으로 하고, 이 값은 앱 안쪽을 보여 줘요.",
  "otel.empty": "아직 앱에서 받은 값이 없어요.",
  "otel.rps": "요청",
  "otel.errorRate": "오류율",
  "otel.p99": "API p99",
  "otel.dbP99": "DB p99",
  "otel.poolWait": "풀 대기",
  "otel.unit.rps": "{n}/s",
  "otel.unit.ms": "{n}ms",
  "otel.unit.msps": "{n}ms/s",
  "otel.errors": "최근 1분 5xx",
  "otel.errors.none": "최근 1분 동안 5xx가 없어요.",
  "otel.cutover.title": "앱이 본 DB 전환",
} as const

export type TelemetryKey = keyof typeof telemetryKo

export const telemetryEn: Record<TelemetryKey, string> = {
  "otel.title": "App telemetry",
  "otel.tag": "OpenTelemetry",
  "otel.desc": "Sent by the migrated app itself (last 5 minutes). Error-rate and p99 gates use the Envoy values above; these show the inside of the app.",
  "otel.empty": "No data from the app yet.",
  "otel.rps": "Requests",
  "otel.errorRate": "Error rate",
  "otel.p99": "API p99",
  "otel.dbP99": "DB p99",
  "otel.poolWait": "Pool wait",
  "otel.unit.rps": "{n}/s",
  "otel.unit.ms": "{n}ms",
  "otel.unit.msps": "{n}ms/s",
  "otel.errors": "5xx in the last minute",
  "otel.errors.none": "No 5xx in the last minute.",
  "otel.cutover.title": "DB switchover as the app saw it",
}

export const telemetryJa: Record<TelemetryKey, string> = {
  "otel.title": "アプリ観測",
  "otel.tag": "OpenTelemetry",
  "otel.desc": "移行対象アプリ自身が送った値です(直近5分)。エラー率とp99の判定は上のEnvoyの値で行い、この値はアプリ内部を示します。",
  "otel.empty": "まだアプリから値を受け取っていません。",
  "otel.rps": "リクエスト",
  "otel.errorRate": "エラー率",
  "otel.p99": "API p99",
  "otel.dbP99": "DB p99",
  "otel.poolWait": "プール待ち",
  "otel.unit.rps": "{n}/s",
  "otel.unit.ms": "{n}ms",
  "otel.unit.msps": "{n}ms/s",
  "otel.errors": "直近1分の5xx",
  "otel.errors.none": "直近1分間に5xxはありません。",
  "otel.cutover.title": "アプリから見たDB切り替え",
}

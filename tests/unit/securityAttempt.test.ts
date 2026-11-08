import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import type { MigrationEvent } from '../../src/lib/migration/events.ts'
import { renderReport, ReportEngine } from '../../src/lib/voice/reports.ts'

// 레드팀 보안 라운드의 시도는 failure_class가 SECURITY다(백엔드 failure_classifier). 분류 5개 + SECURITY.
const CLASSES = ['SPEC', 'CODE', 'BUILD', 'RENDER', 'INFRA', 'SECURITY']
const CHECKS = { required_passed: 3, required_total: 3, unsupported_calls: 0, calls_in_mapping: 0, calls_total: 0, blocked_egress: 0 }
const attempt = (cls: string | null) => ({
  type: 'sandbox.attempt', phase: 'build', status: 'running',
  data: { run: 1, attempt: 1, max_attempts: 3, verdict: { passed: false, reasons: ['FINDING:sql-injection:/login'] }, failure_class: cls, checks: CHECKS, fix_ids: ['fix-1-1'] },
  seq: 1, at: '2026-11-08T00:00:00.000Z',
})

test('이벤트 스키마가 failure_class SECURITY를 받는다(보안 라운드의 sandbox.attempt)', () => {
  const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
  ajv.addSchema(schema)
  const validate = ajv.getSchema('events.schema.json')!
  for (const cls of [...CLASSES, null]) assert.ok(validate(attempt(cls)), `${cls}: ${ajv.errorsText(validate.errors)}`)
  assert.equal(validate(attempt('NOT_A_CLASS')), false)
})

test('분류마다 화면 문구가 세 언어에 모두 있다(없으면 시도 카드가 빈 문구가 된다)', () => {
  for (const [name, dict] of [['ko', ko], ['en', en], ['ja', ja]] as const) {
    for (const cls of CLASSES) {
      for (const prefix of ['sbx.cls.', 'sbx.next.']) {
        const text = (dict as Record<string, string>)[prefix + cls]
        assert.ok(text && text.trim().length > 0, `${name} ${prefix}${cls}`)
      }
    }
  }
})

test('음성: 보안 라운드 시도 실패는 분류 이름을 넣어 말한다(cls.undefined가 되지 않는다)', () => {
  const engine = new ReportEngine()
  const [report] = engine.fromEvent(attempt('SECURITY') as unknown as MigrationEvent, 'rehearsal', 0)
  assert.equal(report.kind, 'failure')
  assert.ok(renderReport(report, 'ko').includes('보안'), renderReport(report, 'ko'))
  assert.ok(/security/i.test(renderReport(report, 'en')), renderReport(report, 'en'))
  assert.ok(renderReport(report, 'ja').includes('セキュリティ'), renderReport(report, 'ja'))
})

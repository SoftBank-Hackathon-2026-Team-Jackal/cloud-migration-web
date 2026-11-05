'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import type { Detection, RepoScan } from '../lib/github/scan'

type Props = {
  /** 이미 가진 결과(시연용 저장소) 또는 서버에서 읽어 올 저장소 */
  scan: RepoScan | { full_name: string; commit_sha: string }
  onDone: (scan: RepoScan | null) => void
}

const STEP_MS = 140
const RUNTIME_MARK: Record<string, string> = { 'Node.js': 'JS', Go: 'GO', Python: 'PY', Java: 'JV' }

/** 탐지 결과가 어느 파일에서 나왔는지: 그 파일이 목록에 나타날 때 탐지 칸이 켜진다. */
function revealIndex(detection: Detection, tree: string[]): number {
  const at = tree.findIndex(path => path === detection.evidence || path.endsWith('/' + detection.evidence) || (detection.evidence.endsWith('/') && path.startsWith(detection.evidence)))
  if (at >= 0) return at
  // 패키지 이름처럼 경로가 아닌 근거는 구성 파일(package.json 등)이 보일 때 켠다.
  const manifest = tree.findIndex(path => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|pom\.xml)$/.test(path))
  return manifest >= 0 ? manifest : tree.length - 1
}

export function detectionLabel(t: ReturnType<typeof useT>, detection: Detection): { title: string; sub: string; mark: string } {
  switch (detection.kind) {
    case 'runtime': return { title: detection.name, sub: detection.evidence, mark: RUNTIME_MARK[detection.name.split(' ')[0]] ?? detection.name.slice(0, 2).toUpperCase() }
    case 'dockerfile': return { title: t('setup2.det.dockerfile'), sub: t('setup2.det.dockerfileSub', { stages: detection.stages }), mark: 'D' }
    case 'k8s': return { title: t('setup2.det.k8s', { count: detection.count }), sub: detection.evidence, mark: 'K8' }
    case 'postgres': return { title: t('setup2.det.postgres'), sub: detection.evidence, mark: 'PG' }
    case 'env': return { title: t('setup2.det.env', { count: detection.count }), sub: detection.evidence, mark: 'ENV' }
  }
}

/**
 * 저장소 가져오기 장면: 파일 목록이 흘러 들어오고, 근거 파일이 나타나면 탐지 결과가 켜진다.
 * 실제 저장소는 이 앱의 서버(/api/github/scan)가 GitHub에서 구성만 읽어 온 결과를 쓴다. 소스 원문은 받지 않는다.
 */
export default function RepoImport({ scan, onDone }: Props) {
  const t = useT()
  const [data, setData] = useState<RepoScan | null>('tree' in scan ? scan : null)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(0)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const remote = 'tree' in scan ? null : scan

  useEffect(() => {
    if (!remote) return
    const controller = new AbortController()
    fetch('/api/github/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ full_name: remote.full_name, commit_sha: remote.commit_sha }),
    })
      .then(response => response.ok ? response.json() as Promise<RepoScan> : Promise.reject(new Error(String(response.status))))
      .then(setData)
      .catch(() => { if (!controller.signal.aborted) { setFailed(true); doneRef.current(null) } })
    return () => controller.abort()
  }, [remote?.full_name, remote?.commit_sha]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || data.tree.length === 0) { setShown(data.tree.length); doneRef.current(data); return }
    let count = 0
    const timer = window.setInterval(() => {
      count += 1
      setShown(count)
      if (count >= data.tree.length) { window.clearInterval(timer); window.setTimeout(() => doneRef.current(data), 350) }
    }, STEP_MS)
    return () => window.clearInterval(timer)
  }, [data])

  if (failed) return <p className="repo-note is-alert" role="status">{t('setup2.scanFailed')}</p>
  if (!data) return <p className="repo-note" role="status">{t('setup2.scanning')}</p>

  const evidence = new Set(data.detections.map(detection => revealIndex(detection, data.tree)))
  const complete = shown >= data.tree.length
  return <div className="rimp" data-complete={complete}>
    <ol className="rimp-tree" aria-label={t('setup2.treeAria')}>
      {data.tree.slice(0, shown).map((path, index) => {
        const parts = path.replace(/\/$/, '').split('/')
        return <li key={path} className={evidence.has(index) ? 'is-hit' : ''} style={{ paddingLeft: (parts.length - 1) * 12 }}>
          {parts[parts.length - 1]}{path.endsWith('/') ? '/' : ''}
        </li>
      })}
    </ol>
    <ul className="rimp-dets" aria-label={t('setup2.detAria')}>
      {data.detections.map(detection => {
        const label = detectionLabel(t, detection)
        const lit = shown > revealIndex(detection, data.tree)
        return <li key={detection.kind} className={'rimp-det' + (lit ? ' is-on' : '')} data-detection={detection.kind}>
          <span className="rimp-mark" aria-hidden="true">{label.mark}</span>
          <strong>{label.title}</strong>
          <small>{label.sub}</small>
        </li>
      })}
    </ul>
    <p className="rimp-state" role="status">{t(complete ? 'setup2.scanned' : 'setup2.scanning')}</p>
  </div>
}

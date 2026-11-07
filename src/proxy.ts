import { NextResponse, type NextRequest } from 'next/server'
import { isTemporalReadOnlyRequest } from './lib/temporalUi'

/** Temporal UI(next.config.ts의 fallback rewrite)의 HTTP API는 읽기만 통과시킨다. */
export function proxy(request: NextRequest) {
  if (isTemporalReadOnlyRequest(request.method, request.nextUrl.pathname)) return NextResponse.next()
  return NextResponse.json({ code: 'TEMPORAL_READ_ONLY', message: 'Temporal UI is read-only here' }, { status: 403 })
}

export const config = {
  matcher: '/api/v1/:path*',
}

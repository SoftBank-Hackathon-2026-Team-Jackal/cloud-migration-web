/**
 * 첫 화면에서 대상을 고르면 되짚는 말을 기다리지 않고 바로 GitHub 로그인으로 보낼지 정한다.
 * 실제 모드(저장소가 필요한 시작)에서 로그인 앱은 설정됐는데 아직 로그인하지 않았을 때만 보낸다.
 * 127.0.0.1에서는 OAuth 콜백 호스트가 달라 로그인이 실패하므로(RepoPicker 참고) 보내지 않고, 설정 화면의 로그인 버튼을 쓴다.
 */
const LOOPBACK = /^(127(?:\.\d{1,3}){3}|\[::1\])$/

export type GithubStatus = { configured: boolean; signed_in: boolean }

export function shouldQuickLogin(needsSource: boolean, status: GithubStatus | null, hostname: string): boolean {
  if (!needsSource || !status) return false
  if (LOOPBACK.test(hostname)) return false
  return status.configured && !status.signed_in
}

/** 로그인 뒤 돌아올 주소: 고른 대상의 설정 화면 */
export function quickLoginReturn(target: 'onprem' | 'gcp'): string {
  return '/?stage=setup&target=' + target
}

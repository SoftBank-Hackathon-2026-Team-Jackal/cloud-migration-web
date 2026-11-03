import FlowApp from '../components/FlowApp'
import { MigrationProvider } from '../lib/migration/MigrationProvider'

export default function Page() {
  return <MigrationProvider><FlowApp /></MigrationProvider>
}

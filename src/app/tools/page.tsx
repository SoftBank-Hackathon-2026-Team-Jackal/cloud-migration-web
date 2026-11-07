import type { Metadata } from 'next'
import ToolsPage from '../../components/tools/ToolsPage'
import '../settings/settings.css'
import './tools.css'

export const metadata: Metadata = { title: 'Jackal · Tools' }

export default function Tools() {
  return <ToolsPage />
}

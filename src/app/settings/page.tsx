import type { Metadata } from 'next'
import ConnectionsSettings from '../../components/settings/ConnectionsSettings'
import './settings.css'

export const metadata: Metadata = { title: 'Jackal · Connections' }

export default function SettingsPage() {
  return <ConnectionsSettings />
}

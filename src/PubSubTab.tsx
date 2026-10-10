import { useState } from 'react'
import PubSubLab from './PubSubLab'
import PubSubConsole from './PubSubConsole'

export default function PubSubTab() {
  const [view, setView] = useState<'console' | 'bench'>('console')
  return (
    <>
      <div className="psc-switch">
        <button className={view === 'console' ? 'active' : ''} onClick={() => setView('console')}>Live console</button>
        <button className={view === 'bench' ? 'active' : ''} onClick={() => setView('bench')}>Benchmark</button>
      </div>
      <div hidden={view !== 'console'}><PubSubConsole /></div>
      <div hidden={view !== 'bench'}><PubSubLab /></div>
    </>
  )
}

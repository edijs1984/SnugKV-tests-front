import { useState } from 'react'
import PubSubLab from './PubSubLab'
import PubSubConsole from './PubSubConsole'

// One element, because the app shell lays its children out as header / content / footer.
export default function PubSubTab() {
  const [view, setView] = useState<'console' | 'bench'>('console')
  return (
    <div className="psc-tab">
      <div className="psc-switch">
        <button className={view === 'console' ? 'active' : ''} onClick={() => setView('console')}>Live console</button>
        <button className={view === 'bench' ? 'active' : ''} onClick={() => setView('bench')}>Benchmark</button>
      </div>
      <div className="psc-view" hidden={view !== 'console'}><PubSubConsole /></div>
      <div className="psc-view" hidden={view !== 'bench'}><PubSubLab /></div>
    </div>
  )
}

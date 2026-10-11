import { Check, ChevronDown, Copy, Terminal } from 'lucide-react'
import { useState } from 'react'
import { copyText } from '../clipboard'

const commands = {
  Docker: 'docker compose run --rm -it \\\n  -v "$HOME/.ssh:/home/artiface/.ssh:ro" \\\n  artiface import-ssh --config /data/config.json',
  Native: 'artiface import-ssh --config /path/to/config.json',
}

export default function SSHImportGuide() {
  const [method, setMethod] = useState<'Docker' | 'Native'>('Docker')
  const [copied, setCopied] = useState('')
  const [failed, setFailed] = useState('')
  const command = commands[method]
  async function copy() {
    try { await copyText(command); setCopied(command); setFailed('') }
    catch { setFailed(command) }
  }
  return <details className="ssh-import-guide">
    <summary><Terminal size={17} /> <span>Add SSH hosts from the command line</span><ChevronDown size={16} className="ssh-guide-disclosure" aria-hidden="true" /></summary>
    <div className="ssh-import-content">
      <p>Run this on the Artiface server. It saves SSH settings, private keys, and trusted host keys in a separate encrypted file beside the app configuration.</p>
      <div className="ssh-import-controls">
        <div className="view-toggle" role="group" aria-label="Installation method">{(['Docker', 'Native'] as const).map(value =>
          <button key={value} className={method === value ? 'active' : undefined} aria-pressed={method === value} onClick={() => { setMethod(value); setCopied(''); setFailed('') }}>{value}</button>)}</div>
        <button className="button secondary" onClick={() => void copy()}>{copied === command ? <Check size={15} /> : <Copy size={15} />}{copied === command ? 'Copied' : 'Copy command'}</button>
      </div>
      <pre tabIndex={0} aria-label="SSH import command"><code>{command}</code></pre>
      {failed === command && <p role="status">Select the command above to copy it manually.</p>}
      <ol>
        <li>{method === 'Docker' ? 'Run it beside your compose.yaml file. The SSH directory is mounted only for this command.' : 'Use the executable and configuration path from your server’s start command.'}</li>
        <li>
          Enter the current admin password, or on first setup choose one or press Enter to generate one.
          {' '}Save any generated password shown after import.
          {' '}Key passphrases are requested separately; input is hidden.
        </li>
        <li>Restart Artiface, then sign in as the personal owner or at <code>/admin/</code> to unlock SSH.</li>
        <li>Add a project using one of the imported hosts.</li>
      </ol>
      <p>Run it again to import updated settings. Add <code>--host alias</code> to choose a host, or <code>--password-host alias</code> to import its SSH login password.</p>
      <p>SSH locks again on server restart. Team users cannot unlock it with their own passwords.</p>
    </div>
  </details>
}

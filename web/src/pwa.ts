import { useSyncExternalStore } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface InstallState {
  canInstall: boolean
  installed: boolean
  updateAvailable: boolean
  secureContext: boolean
  workerReady: boolean
  error: string
}

const standalone = window.matchMedia('(display-mode: standalone)')
let state: InstallState = {
  canInstall: false,
  installed: standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
  updateAvailable: false, secureContext: window.isSecureContext, workerReady: false, error: '',
}
let deferredPrompt: InstallPrompt | null = null
let registration: ServiceWorkerRegistration | null = null
const listeners = new Set<() => void>()
let initialized = false

function update(patch: Partial<InstallState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function initializePWA() {
  if (initialized) return
  initialized = true
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    deferredPrompt = event as InstallPrompt
    update({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    update({ installed: true, canInstall: false })
  })
  standalone.addEventListener('change', () => update({ installed: standalone.matches }))
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then(reg => {
      registration = reg
      update({ updateAvailable: Boolean(reg.waiting) })
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') update({
            updateAvailable: Boolean(navigator.serviceWorker.controller && reg.waiting),
            workerReady: true,
          })
        })
      })
      return navigator.serviceWorker.ready
    })
    .then(() => update({ workerReady: true }))
    .catch(() => update({ error: 'The offline app shell could not be installed. Check your connection and reload.' }))
}

export function useInstallApp() {
  return useSyncExternalStore(listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => state)
}

export async function installApp() {
  const prompt = deferredPrompt
  if (!prompt) return
  deferredPrompt = null
  update({ canInstall: false })
  try {
    await prompt.prompt()
    if ((await prompt.userChoice).outcome === 'accepted') update({ installed: true })
  } catch {
    update({ error: 'Use your browser’s installation menu to install Artiface.' })
  }
}

export function applyAppUpdate() {
  if (!registration?.waiting) return
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './preferences'
import { initializePWA } from './pwa'
import './styles.css'

initializePWA()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

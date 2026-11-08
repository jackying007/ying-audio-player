import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { initializeAndroidWindowInsets } from './lib/android-window-insets'
import { initAudioPlayback } from './store/audio-store'

initializeAndroidWindowInsets()
initAudioPlayback()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

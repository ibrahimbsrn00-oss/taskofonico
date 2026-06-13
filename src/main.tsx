import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { bootstrapPersistence } from './lib/persistence.ts';
import './index.css';

async function startApp() {
  await bootstrapPersistence();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void startApp();

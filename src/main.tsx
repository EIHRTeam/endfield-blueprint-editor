import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
// Side-effect import: the application stylesheet is bundled, not imported as a binding.
// oxlint-disable-next-line import/no-unassigned-import -- see comment above
import './styles.css';

const container = document.getElementById('root');
if (!container) throw Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

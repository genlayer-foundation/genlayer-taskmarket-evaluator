import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AcpDashboard from './App';
import Taskmarket from './Taskmarket';
import './App.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname === '/acp-dashboard' ? <AcpDashboard /> : <Taskmarket />}
  </StrictMode>,
);

import 'dotenv/config'
import { startServer } from './api/server.js'

// Capturar sinais
process.on('SIGTERM', (sig) => { console.error(`[FATAL] Received SIGTERM`); process.exit(1); });
process.on('SIGINT', (sig) => { console.error(`[FATAL] Received SIGINT`); process.exit(1); });
process.on('SIGHUP', (sig) => { console.error(`[FATAL] Received SIGHUP`); process.exit(1); });
process.on('exit', (code) => { console.error(`[FATAL] Process exiting with code ${code}`); });

process.on('unhandledRejection', (reason: any) => {
  console.error('[Process] Unhandled rejection (suppressed):', reason?.stack || reason?.message || reason);
});

process.on('uncaughtException', (err: any) => {
  console.error('[Process] Uncaught exception (suppressed):', err?.stack || err?.message || err);
});

startServer().catch(error => {
  console.error('Failed to start server:', error?.stack || error)
  process.exit(1)
})

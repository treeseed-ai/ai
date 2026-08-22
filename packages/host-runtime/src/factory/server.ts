#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createFactoryApp } from './api.js';
import { readState, writeState } from './state.js';
import { failInterruptedTransition,reconcile } from './coordinator.js';
import { prepareRuntimeDirectory } from './shared.js';

prepareRuntimeDirectory('inference');prepareRuntimeDirectory('training');
const current = readState();
if (current.mode === 'transitioning_awake' || current.mode === 'transitioning_sleep') {
  if(current.transitionId)failInterruptedTransition(current.transitionId);
  writeState({ ...current, mode: 'degraded', updatedAt: new Date().toISOString(), error: 'Interrupted mode transition requires explicit reconciliation.' });
}
else if(current.mode==='awake'||current.mode==='sleep'){try{await reconcile();}catch(error){writeState({...current,mode:'degraded',updatedAt:new Date().toISOString(),error:`Boot reconciliation failed: ${error instanceof Error?error.message:String(error)}`});}}
const port = Number(process.env.FACTORY_PORT ?? 4790);
serve({
  fetch: createFactoryApp().fetch,
  hostname: process.env.FACTORY_HOST ?? '0.0.0.0',
  port,
  createServer,
  serverOptions: {
    key: readFileSync(process.env.FACTORY_TLS_KEY ?? '/etc/treeseed-ai/host-runtime/factory/tls/server.key'),
    cert: readFileSync(process.env.FACTORY_TLS_CERT ?? '/etc/treeseed-ai/host-runtime/factory/tls/server.crt'),
  },
});
process.stdout.write(`${JSON.stringify({ service: 'factory-control', port })}\n`);

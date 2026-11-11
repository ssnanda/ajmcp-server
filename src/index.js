import { loadConfig } from './config.js';
import { createAjmcpServer } from './server.js';

const config = loadConfig();
const server = createAjmcpServer(config);
server.listen(config.port, config.host, () => {
  console.info(JSON.stringify({ event: 'listening', port: config.port, host: config.host,
    version: '0.1.0', tenantCount: config.sites.length }));
});
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

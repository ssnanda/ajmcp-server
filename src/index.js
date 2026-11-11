import { loadConfig } from './config.js';
import { createAjmcpServer } from './server.js';
import { SettingsStore } from './store.js';
import { APP_VERSION } from './version.js';

const config = loadConfig();
const store = new SettingsStore(config);
store.load();
const server = createAjmcpServer(config, { store });
server.listen(config.port, config.host, () => {
  console.info(JSON.stringify({ event: 'listening', port: config.port, host: config.host,
    version: APP_VERSION, tenantCount: config.sites.length, admin: Boolean(config.adminUser) }));
});
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

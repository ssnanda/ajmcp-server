import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const enc = (value) => Buffer.from(String(value)).toString('base64');

function apiRequest(method, path, body, read = readFileSync) {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443);
  if (!host) throw new Error('openshift_api_unavailable');
  const token = read(`${SA}/token`, 'utf8').trim();
  const ca = read(`${SA}/ca.crt`);
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method, ca, headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {})
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handled by status */ }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Object.assign(new Error('openshift_api_failed'), { status: res.statusCode }));
        resolve(data);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('openshift_api_timeout')));
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

export async function saveOllamaSecret({ host, user, port, privateKey, knownHosts }, namespace = process.env.POD_NAMESPACE || 'ajmcp') {
  const base = `/api/v1/namespaces/${encodeURIComponent(namespace)}`;
  const current = await apiRequest('GET', `${base}/secrets/ajmcp-ollama-ssh`);
  await apiRequest('PUT', `${base}/secrets/ajmcp-ollama-ssh`, {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name: 'ajmcp-ollama-ssh', namespace, resourceVersion: current.metadata.resourceVersion },
    data: { host: enc(host), user: enc(user), port: enc(port), id_key: enc(privateKey), known_hosts: enc(knownHosts) }
  });
  await apiRequest('PATCH', `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/ajmcp-server`, {
    spec: { template: { metadata: { annotations: { 'ajmcp.io/ollama-secret-updated-at': new Date().toISOString() } } } }
  });
}

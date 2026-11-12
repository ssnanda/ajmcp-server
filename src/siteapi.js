// What a website's plugin may do with its own site, authenticated by the site token: edit the AI's instructions,
// manage knowledge documents, and sync the website's own pages as knowledge. Provider, model, tokens and keys are not here.
import { InputError } from './provider.js';
import { knowledgeChars } from './knowledge.js';

const DOC_ID = /^[a-f0-9]{12}$/;

const configView = (site) => ({
  instructions: site.systemPrompt || '', strict: site.strict !== false, fallback: site.fallback || '',
  leadCapture: Boolean(site.leadCapture), leadInstructions: site.leadInstructions || '',
  provider: site.provider, model: site.model || '', knowledgeChars: knowledgeChars(site.knowledge || [])
});
const docView = (d) => ({ id: d.id, title: d.title, chars: d.text.length, source: d.source || 'manual', ref: d.ref || '', updatedAt: d.updatedAt || null });

/** Returns { status, body } or null when the path is not one of ours. */
export async function handleSiteApi({ req, path, site, store, config, readBody, limiter, identity }) {
  const method = req.method;
  const writes = method !== 'GET';
  const big = /^\/v1\/site\/knowledge(\/sync)?(\/[a-f0-9]{12})?$/.test(path);
  const body = writes && method !== 'DELETE' ? await readBody(req, big ? 1_048_576 : config.maxRequestBytes) : {};
  if (writes && (!body || typeof body !== 'object' || Array.isArray(body))) throw new InputError('invalid_request');
  if (writes) {
    const slot = limiter.acquire(identity);
    if (!slot.ok) return { status: slot.status, body: { error: slot.code } };
    slot.release();
  }
  const fresh = () => config.sites.find((s) => s.id === site.id) || site;

  if (path === '/v1/site/config') {
    if (method === 'GET') return { status: 200, body: configView(fresh()) };
    if (method === 'PUT') {
      const patch = {};
      if ('instructions' in body) patch.systemPrompt = String(body.instructions);
      for (const key of ['strict', 'fallback', 'leadCapture', 'leadInstructions']) if (key in body) patch[key] = body[key];
      store.updateSite(site.id, patch);
      return { status: 200, body: configView(fresh()) };
    }
  }
  if (path === '/v1/site/knowledge') {
    if (method === 'GET') return { status: 200, body: { documents: (fresh().knowledge || []).map(docView) } };
    if (method === 'POST') { const doc = store.addDoc(site.id, body); return { status: 201, body: docView(doc) }; }
  }
  if (path === '/v1/site/knowledge/sync' && method === 'PUT') {
    if (!Array.isArray(body.docs) || body.docs.length > 250) throw new InputError('invalid_docs');
    return { status: 200, body: store.syncDocs(site.id, String(body.source || ''), body.docs) };
  }
  const one = /^\/v1\/site\/knowledge\/([a-f0-9]{12})$/.exec(path);
  if (one && DOC_ID.test(one[1])) {
    if (method === 'GET') { const d = store.getDoc(site.id, one[1]); return { status: 200, body: { ...docView(d), text: d.text } }; }
    if (method === 'PUT') { const d = store.updateDoc(site.id, one[1], body); return { status: 200, body: docView(d) }; }
    if (method === 'DELETE') { store.removeDoc(site.id, one[1]); return { status: 200, body: { ok: true } }; }
  }
  return null;
}

// Master AI switch: one setting that routes every model call (site chat, assistants, leads, MCP, agent jobs) through
// one subscription tool, whatever each site is set to. Off = every site uses its own provider and model.
// The sites are not changed: switching back restores each site's own choice at once.
export const MASTER_PROVIDERS = Object.freeze(['claude', 'codex', 'antigravity', 'ollama']);
export const MASTER_LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex (ChatGPT)', antigravity: 'Google Antigravity', ollama: 'Ollama' });
const PROVIDER_OF = Object.freeze({ claude: 'claude-cli', codex: 'codex-cli', antigravity: 'antigravity-cli', ollama: 'ollama' });

export const emptyMaster = () => ({ provider: '', models: { claude: '', codex: '', antigravity: '', ollama: '' } });

/** The master setting from config (never undefined). */
export function masterOf(config) {
  const m = config && config.master;
  const provider = m && MASTER_PROVIDERS.includes(m.provider) ? m.provider : '';
  return { provider, models: { ...emptyMaster().models, ...(m && m.models ? m.models : {}) } };
}

/** The site as this call must see it: provider (and model) replaced by the master's when the master is on. */
export function applyMaster(site, config) {
  const m = masterOf(config);
  if (!m.provider) return site;
  // A model id of another provider never carries over: the master's own model (blank = that tool's default) is used.
  return { ...site, provider: PROVIDER_OF[m.provider], model: m.models[m.provider] || '', masterApplied: true };
}

/** Agent jobs: the tool name the job must run with ('codex' | 'claude' | 'antigravity'). */
export function agentProviderFor(requested, config) {
  const m = masterOf(config);
  return m.provider || requested;
}

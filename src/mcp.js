// Genuine MCP Streamable HTTP transport. Stateless: one server+transport per incoming request.
// Site access is authenticated by the HTTP gateway before this module is invoked.
import { generateReply } from './provider.js';

export async function handleMcp(req, res, site, config, limiter, fetchFn = fetch) {
  const [{ McpServer }, { NodeStreamableHTTPServerTransport }, z] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node/streamableHttp'),
    import('zod/v4')
  ]);
  const mcp = new McpServer({ name: 'ajmcp-server', version: '0.1.0' });
  mcp.registerTool('site_info', {
    description: 'Return the authenticated website identifier and available AI provider (read-only).',
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ site: site.id, provider: site.provider }) }] }));
  mcp.registerTool('ask_site_ai', {
    description: 'Ask the configured AI model a question on behalf of the authenticated website. No WordPress write access.',
    inputSchema: z.object({ question: z.string().min(1).max(config.maxMessageChars) })
  }, async ({ question }) => {
    const slot = limiter.acquire({ id: site.id });
    if (!slot.ok) return { isError: true, content: [{ type: 'text', text: slot.code }] };
    try {
      const reply = await generateReply(site, [{ role: 'user', content: question }], config, fetchFn);
      return { content: [{ type: 'text', text: reply.text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.code || 'ai_request_failed' }] };
    } finally { slot.release(); }
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

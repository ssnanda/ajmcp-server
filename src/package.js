// AJMCP assistant package: the plain-text files an assistant is made of, as ChatGPT writes them
// (see assistants/chatgpt-project-instructions.txt, kept locally) and as export produces them.
//
//   <id>-assistant.json                      {"format":"ajmcp-assistant","version":1,"id","name","assistantVersion"?,"leadCapture","strict","transferTargets"?}
//   <id>-01-ai-behavior-instructions.txt     systemPrompt
//   <id>-02-ai-behavior-what-it-handles.txt  routeLabel (one line)
//   <id>-03-leads-instructions.txt           leadInstructions
//   <id>-04-knowledge-fallback-reply.txt     fallback
//   <id>-05-test-texts.txt                   tests: blocks of `1. Customer: "<text>"` + `Expected: <result>`
//   <id>-knowledge-NN-<topic>.txt            manual knowledge: line 1 = title, rest = body
//   <id>-00-skipped-facts.txt                notes; never imported
//
// Never carries tokens, keys, provider or model. Website-synced knowledge is not part of a package.

export const PACKAGE_FORMAT = 'ajmcp-assistant';
export const PACKAGE_VERSION = 1;

const clean = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'document';

function formatTests(tests) {
  return tests.map((t, i) => `${i + 1}. Customer: "${t.question}"\nExpected: ${t.expected || ''}`).join('\n\n');
}

function parseTests(text) {
  const tests = [];
  for (const block of clean(text).split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let question = '';
    let expected = '';
    for (const line of lines) {
      const q = /^(?:\d+[.)]\s*)?(?:customer|q)\s*:\s*(.*)$/i.exec(line);
      const e = /^(?:expected|expect|a)\s*:\s*(.*)$/i.exec(line);
      if (q && !question) question = q[1].replace(/^["“]|["”]$/g, '').trim();
      else if (e) expected = e[1].trim();
      else if (expected) expected += ' ' + line;
    }
    if (question) tests.push({ question, expected });
  }
  return tests;
}

/** The package files for one assistant, as { fileName: text }. */
export function siteToPackage(site, name = '') {
  const id = site.id;
  const files = {};
  const meta = { format: PACKAGE_FORMAT, version: PACKAGE_VERSION, id, name: name || site.name || id, leadCapture: Boolean(site.leadCapture), strict: site.strict !== false };
  if (site.assistantVersion) meta.assistantVersion = site.assistantVersion;
  if (Array.isArray(site.transferTargets) && site.transferTargets.length) meta.transferTargets = [...site.transferTargets];
  files[`${id}-assistant.json`] = JSON.stringify(meta, null, 2) + '\n';
  if (site.systemPrompt) files[`${id}-01-ai-behavior-instructions.txt`] = site.systemPrompt.trim() + '\n';
  if (site.routeLabel) files[`${id}-02-ai-behavior-what-it-handles.txt`] = site.routeLabel.trim() + '\n';
  if (site.leadInstructions) files[`${id}-03-leads-instructions.txt`] = site.leadInstructions.trim() + '\n';
  if (site.fallback) files[`${id}-04-knowledge-fallback-reply.txt`] = site.fallback.trim() + '\n';
  if (site.tests && site.tests.length) files[`${id}-05-test-texts.txt`] = formatTests(site.tests) + '\n';
  (site.knowledge || []).filter((d) => d.source !== 'website').forEach((doc, i) => {
    files[`${id}-knowledge-${String(i + 1).padStart(2, '0')}-${slug(doc.title)}.txt`] = `${doc.title}\n\n${doc.text.trim()}\n`;
  });
  return files;
}

/**
 * Reads package files ({ fileName: text }) into the fields they set. A field is only returned when its file
 * is present, so a partial package leaves the other fields as they are. Knowledge is returned as the complete
 * manual set (`knowledge`, possibly empty) because a package replaces all manual documents.
 */
export function parsePackage(files) {
  const out = { meta: null, fields: {}, knowledge: [], warnings: [], ignored: [] };
  const docs = [];
  for (const [rawName, rawText] of Object.entries(files || {})) {
    const name = String(rawName).split('/').pop();
    const text = clean(rawText);
    if (/(?:^|-)assistant\.json$/i.test(name)) {
      try { out.meta = JSON.parse(text); } catch { out.warnings.push(`${name}: not valid JSON, ignored`); }
    } else if (/01-ai-behavior-instructions\.txt$/i.test(name)) out.fields.systemPrompt = text;
    else if (/02-ai-behavior-what-it-handles\.txt$/i.test(name)) out.fields.routeLabel = text.replace(/\s+/g, ' ');
    else if (/03-leads-instructions\.txt$/i.test(name)) out.fields.leadInstructions = text;
    else if (/04-knowledge-fallback-reply\.txt$/i.test(name)) out.fields.fallback = text;
    else if (/05-test-texts\.txt$/i.test(name)) out.fields.tests = parseTests(text);
    else if (/knowledge-(\d+)-[^/]*\.txt$/i.test(name)) {
      const order = Number(/knowledge-(\d+)-/i.exec(name)[1]);
      const [first, ...rest] = text.split('\n');
      const title = first.trim().slice(0, 120);
      const body = rest.join('\n').trim();
      if (!title || !body) out.warnings.push(`${name}: needs a title line and a body, skipped`);
      else docs.push({ order, name, title, text: body });
    } else out.ignored.push(name);
  }
  out.knowledge = docs.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ title, text }) => ({ title, text }));
  const meta = out.meta;
  if (meta) {
    if (meta.format && meta.format !== PACKAGE_FORMAT) out.warnings.push(`unknown package format "${meta.format}"`);
    if (Number(meta.version || 1) > PACKAGE_VERSION) out.warnings.push(`package version ${meta.version} is newer than this server understands (${PACKAGE_VERSION})`);
    if (typeof meta.name === 'string' && meta.name.trim() && meta.name.trim() !== meta.id) out.fields.name = meta.name.trim();
    if (typeof meta.assistantVersion === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(meta.assistantVersion.trim())) out.fields.assistantVersion = meta.assistantVersion.trim();
    else if (meta.assistantVersion !== undefined) out.warnings.push('assistantVersion must look like 0.0.1, ignored');
    if (typeof meta.leadCapture === 'boolean') out.fields.leadCapture = meta.leadCapture;
    if (typeof meta.strict === 'boolean') out.fields.strict = meta.strict;
    if (Array.isArray(meta.transferTargets)) out.fields.transferTargets = meta.transferTargets.map(String);
    for (const forbidden of ['provider', 'model', 'token', 'tokens', 'apiKey', 'keys']) {
      if (forbidden in meta) out.warnings.push(`assistant.json "${forbidden}" ignored (packages never set it)`);
    }
  }
  return out;
}

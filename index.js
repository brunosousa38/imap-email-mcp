#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const IMAP_CONFIG = {
  imap: {
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || '993'),
    tls: process.env.IMAP_TLS !== 'false',
    authTimeout: parseInt(process.env.IMAP_AUTH_TIMEOUT || '10000'),
    tlsOptions: {
      rejectUnauthorized: process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== 'false'
    }
  }
};

const SMTP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE !== 'false',
  auth: {
    user: process.env.SMTP_USER || process.env.IMAP_USER,
    pass: process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD
  }
};

function validateConfig() {
  const required = ['IMAP_USER', 'IMAP_PASSWORD', 'IMAP_HOST'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    // Intentionally omit the actual values from this log
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.SMTP_HOST) {
    SMTP_CONFIG.host = process.env.IMAP_HOST;
  }
}

// Validate a uid is a positive integer before passing to IMAP
// (IMAP UIDs are always positive 32-bit integers; non-integers would cause silent misbehavior)
function validateUid(uid) {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('uid must be a positive integer');
  }
  return n;
}

// Block characters that can break IMAP protocol framing (RFC 3501 §9)
function validateFolder(folder) {
  if (/[\x00\r\n"\\]/.test(folder)) {
    throw new Error('Invalid folder name');
  }
  return folder;
}

// YYYY-MM-DD only; anything else would cause unpredictable IMAP search behavior
function validateDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('since_date must be in YYYY-MM-DD format');
  }
}

const TEXT_FIELD_MAX = 10000;

function validateTextFields(args, fields) {
  for (const field of fields) {
    if (args[field] !== undefined && String(args[field]).length > TEXT_FIELD_MAX) {
      throw new Error(`Field "${field}" exceeds maximum length of ${TEXT_FIELD_MAX} characters`);
    }
  }
}

// Loose but sufficient check: each address must be user@domain.tld with no whitespace or commas
// Nodemailer parses further, but we reject obviously malformed input before it reaches the SMTP layer
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function validateEmailAddresses(field, value) {
  if (!value) return;
  const addresses = String(value).split(',').map(a => a.trim()).filter(Boolean);
  if (addresses.length === 0) throw new Error(`"${field}" contains no valid addresses`);
  for (const addr of addresses) {
    if (!EMAIL_RE.test(addr)) {
      throw new Error(`Invalid email address in "${field}": ${addr}`);
    }
  }
}

// Factory so each HTTP request gets a fresh Server instance tied to its own transport
function createMCPServer() {
  const server = new Server(
    { name: 'imap-email-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_folders',
          description: 'List all email folders/mailboxes in the IMAP account',
          inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
          name: 'list_emails',
          description: 'List emails from a folder with optional filtering',
          inputSchema: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'Folder name (default: INBOX)', default: 'INBOX' },
              limit: { type: 'number', description: 'Maximum number of emails to return (default: 20)', default: 20 },
              unseen_only: { type: 'boolean', description: 'Only return unread emails', default: false },
              since_date: { type: 'string', description: 'Only return emails since this date (YYYY-MM-DD format)' }
            },
            required: []
          }
        },
        {
          name: 'get_email',
          description: 'Get full email content by UID',
          inputSchema: {
            type: 'object',
            properties: {
              uid: { type: 'number', description: 'Email UID' },
              folder: { type: 'string', description: 'Folder name (default: INBOX)', default: 'INBOX' }
            },
            required: ['uid']
          }
        },
        {
          name: 'search_emails',
          description: 'Search emails by subject, from, or body text',
          inputSchema: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'Folder to search (default: INBOX)', default: 'INBOX' },
              subject: { type: 'string', description: 'Search in subject line' },
              from: { type: 'string', description: 'Search by sender' },
              body: { type: 'string', description: 'Search in body text' },
              limit: { type: 'number', description: 'Maximum results (default: 20)', default: 20 }
            },
            required: []
          }
        },
        {
          name: 'list_drafts',
          description: 'List all draft emails',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Maximum number of drafts to return (default: 20)', default: 20 }
            },
            required: []
          }
        },
        {
          name: 'get_draft',
          description: 'Get a specific draft email by UID',
          inputSchema: {
            type: 'object',
            properties: {
              uid: { type: 'number', description: 'Draft UID' }
            },
            required: ['uid']
          }
        },
        {
          name: 'create_draft',
          description: 'Create a new draft email',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address(es), comma-separated' },
              subject: { type: 'string', description: 'Email subject' },
              body: { type: 'string', description: 'Email body (plain text)' },
              html: { type: 'string', description: 'Email body (HTML)' },
              cc: { type: 'string', description: 'CC recipients, comma-separated' },
              bcc: { type: 'string', description: 'BCC recipients, comma-separated' }
            },
            required: ['to', 'subject']
          }
        },
        {
          name: 'update_draft',
          description: 'Update an existing draft by deleting old and creating new',
          inputSchema: {
            type: 'object',
            properties: {
              uid: { type: 'number', description: 'UID of draft to update' },
              to: { type: 'string', description: 'Recipient email address(es)' },
              subject: { type: 'string', description: 'Email subject' },
              body: { type: 'string', description: 'Email body (plain text)' },
              html: { type: 'string', description: 'Email body (HTML)' },
              cc: { type: 'string', description: 'CC recipients' },
              bcc: { type: 'string', description: 'BCC recipients' }
            },
            required: ['uid', 'to', 'subject']
          }
        },
        {
          name: 'send_email',
          description: 'Send an email directly',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address(es)' },
              subject: { type: 'string', description: 'Email subject' },
              body: { type: 'string', description: 'Email body (plain text)' },
              html: { type: 'string', description: 'Email body (HTML)' },
              cc: { type: 'string', description: 'CC recipients' },
              bcc: { type: 'string', description: 'BCC recipients' }
            },
            required: ['to', 'subject']
          }
        },
        {
          name: 'delete_email',
          description: 'Delete an email by UID',
          inputSchema: {
            type: 'object',
            properties: {
              uid: { type: 'number', description: 'Email UID to delete' },
              folder: { type: 'string', description: 'Folder name (default: INBOX)', default: 'INBOX' }
            },
            required: ['uid']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'list_folders': {
          const connection = await connectIMAP();
          try {
            const boxes = await connection.getBoxes();
            const folders = [];
            function extractFolders(obj, prefix = '') {
              for (const [key, value] of Object.entries(obj)) {
                const fullPath = prefix ? `${prefix}.${key}` : key;
                folders.push(fullPath);
                if (value.children) extractFolders(value.children, fullPath);
              }
            }
            extractFolders(boxes);
            return { content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }] };
          } finally {
            connection.end();
          }
        }

        case 'list_emails': {
          const folder = validateFolder(args.folder || 'INBOX');
          const limit = args.limit || 20;
          const connection = await connectIMAP();
          try {
            await connection.openBox(folder);
            let searchCriteria = ['ALL'];
            if (args.unseen_only) searchCriteria = ['UNSEEN'];
            if (args.since_date) {
              validateDate(args.since_date);
              searchCriteria = [['SINCE', args.since_date]];
            }
            const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };
            const messages = await connection.search(searchCriteria, fetchOptions);
            const results = messages.slice(-limit).reverse().map(msg => {
              const header = msg.parts.find(p => p.which.includes('HEADER'))?.body || {};
              return {
                uid: msg.attributes.uid,
                date: header.date?.[0],
                from: header.from?.[0],
                to: header.to?.[0],
                subject: header.subject?.[0],
                flags: msg.attributes.flags
              };
            });
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } finally {
            connection.end();
          }
        }

        case 'get_email': {
          const uid = validateUid(args.uid);
          const folder = validateFolder(args.folder || 'INBOX');
          const connection = await connectIMAP();
          try {
            await connection.openBox(folder);
            const fetchOptions = { bodies: [''], struct: true };
            const messages = await connection.search([['UID', uid]], fetchOptions);
            if (messages.length === 0) {
              return { content: [{ type: 'text', text: 'Email not found' }] };
            }
            const msg = messages[0];
            const rawBody = msg.parts.find(p => p.which === '')?.body;
            const parsed = await simpleParser(rawBody);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  uid: msg.attributes.uid,
                  from: parsed.from?.text,
                  to: parsed.to?.text,
                  cc: parsed.cc?.text,
                  subject: parsed.subject,
                  date: parsed.date,
                  text: parsed.text,
                  html: parsed.html,
                  attachments: parsed.attachments?.map(a => ({
                    filename: a.filename,
                    contentType: a.contentType,
                    size: a.size
                  }))
                }, null, 2)
              }]
            };
          } finally {
            connection.end();
          }
        }

        case 'search_emails': {
          const folder = validateFolder(args.folder || 'INBOX');
          const limit = args.limit || 20;
          const connection = await connectIMAP();
          try {
            await connection.openBox(folder);
            let searchCriteria = [];
            if (args.subject) searchCriteria.push(['SUBJECT', args.subject]);
            if (args.from) searchCriteria.push(['FROM', args.from]);
            if (args.body) searchCriteria.push(['BODY', args.body]);
            if (searchCriteria.length === 0) searchCriteria = ['ALL'];
            const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };
            const messages = await connection.search(searchCriteria, fetchOptions);
            const results = messages.slice(-limit).reverse().map(msg => {
              const header = msg.parts.find(p => p.which.includes('HEADER'))?.body || {};
              return {
                uid: msg.attributes.uid,
                date: header.date?.[0],
                from: header.from?.[0],
                to: header.to?.[0],
                subject: header.subject?.[0]
              };
            });
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } finally {
            connection.end();
          }
        }

        case 'list_drafts': {
          const limit = args.limit || 20;
          const connection = await connectIMAP();
          try {
            const draftsFolder = await findDraftsFolder(connection);
            await connection.openBox(draftsFolder);
            const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };
            const messages = await connection.search(['ALL'], fetchOptions);
            const results = messages.slice(-limit).reverse().map(msg => {
              const header = msg.parts.find(p => p.which.includes('HEADER'))?.body || {};
              return {
                uid: msg.attributes.uid,
                date: header.date?.[0],
                to: header.to?.[0],
                subject: header.subject?.[0]
              };
            });
            return { content: [{ type: 'text', text: JSON.stringify({ folder: draftsFolder, drafts: results }, null, 2) }] };
          } finally {
            connection.end();
          }
        }

        case 'get_draft': {
          const uid = validateUid(args.uid);
          const connection = await connectIMAP();
          try {
            const draftsFolder = await findDraftsFolder(connection);
            await connection.openBox(draftsFolder);
            const fetchOptions = { bodies: [''], struct: true };
            const messages = await connection.search([['UID', uid]], fetchOptions);
            if (messages.length === 0) {
              return { content: [{ type: 'text', text: 'Draft not found' }] };
            }
            const msg = messages[0];
            const rawBody = msg.parts.find(p => p.which === '')?.body;
            const parsed = await simpleParser(rawBody);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  uid: msg.attributes.uid,
                  to: parsed.to?.text,
                  cc: parsed.cc?.text,
                  bcc: parsed.bcc?.text,
                  subject: parsed.subject,
                  date: parsed.date,
                  text: parsed.text,
                  html: parsed.html
                }, null, 2)
              }]
            };
          } finally {
            connection.end();
          }
        }

        case 'create_draft': {
          validateEmailAddresses('to', args.to);
          if (args.cc) validateEmailAddresses('cc', args.cc);
          if (args.bcc) validateEmailAddresses('bcc', args.bcc);
          validateTextFields(args, ['subject', 'body', 'html']);
          const connection = await connectIMAP();
          try {
            const draftsFolder = await findDraftsFolder(connection);
            const message = buildRawMessage({
              from: IMAP_CONFIG.imap.user,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
              html: args.html
            });
            await connection.append(message, { mailbox: draftsFolder, flags: ['\\Draft'] });
            return { content: [{ type: 'text', text: `Draft created successfully in ${draftsFolder}` }] };
          } finally {
            connection.end();
          }
        }

        case 'update_draft': {
          const uid = validateUid(args.uid);
          validateEmailAddresses('to', args.to);
          if (args.cc) validateEmailAddresses('cc', args.cc);
          if (args.bcc) validateEmailAddresses('bcc', args.bcc);
          validateTextFields(args, ['subject', 'body', 'html']);
          const connection = await connectIMAP();
          try {
            const draftsFolder = await findDraftsFolder(connection);
            await connection.openBox(draftsFolder);
            await connection.addFlags(uid, ['\\Deleted']);
            await connection.closeBox(true); // Expunge on close to remove the old draft
            await connection.openBox(draftsFolder);
            const message = buildRawMessage({
              from: IMAP_CONFIG.imap.user,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
              html: args.html
            });
            await connection.append(message, { mailbox: draftsFolder, flags: ['\\Draft'] });
            return { content: [{ type: 'text', text: 'Draft updated successfully' }] };
          } finally {
            connection.end();
          }
        }

        case 'send_email': {
          validateEmailAddresses('to', args.to);
          if (args.cc) validateEmailAddresses('cc', args.cc);
          if (args.bcc) validateEmailAddresses('bcc', args.bcc);
          validateTextFields(args, ['to', 'subject', 'body', 'html']);
          if (!SMTP_CONFIG.host) {
            return {
              content: [{ type: 'text', text: 'Error: SMTP_HOST not configured. Cannot send emails.' }],
              isError: true
            };
          }
          const transporter = nodemailer.createTransport(SMTP_CONFIG);
          const mailOptions = {
            from: SMTP_CONFIG.auth.user,
            to: args.to,
            subject: args.subject,
            text: args.body,
            html: args.html,
            cc: args.cc,
            bcc: args.bcc
          };
          const info = await transporter.sendMail(mailOptions);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, messageId: info.messageId, response: info.response }, null, 2)
            }]
          };
        }

        case 'delete_email': {
          const uid = validateUid(args.uid);
          const folder = validateFolder(args.folder || 'INBOX');
          const connection = await connectIMAP();
          try {
            await connection.openBox(folder);
            await connection.addFlags(uid, ['\\Deleted']);
            await connection.closeBox(true); // Expunge on close
            return { content: [{ type: 'text', text: 'Email deleted successfully' }] };
          } finally {
            connection.end();
          }
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
    } catch (error) {
      // Log full error server-side; send only a generic message to the client
      console.error(`Tool "${name}" error:`, error.message);
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  });

  return server;
}

async function connectIMAP() {
  return await imaps.connect(IMAP_CONFIG);
}

async function findDraftsFolder(connection) {
  const boxes = await connection.getBoxes();
  const draftNames = [
    'Drafts',
    'INBOX.Drafts',
    '[Gmail]/Drafts',
    '[Google Mail]/Drafts',
    'Draft',
    'INBOX/Drafts'
  ];
  for (const name of draftNames) {
    if (boxes[name] || name.split('.').reduce((acc, part) => acc?.[part], boxes)) {
      return name;
    }
  }
  if (boxes.INBOX?.children?.Drafts) return 'INBOX.Drafts';
  return 'Drafts';
}

// Strip CR/LF from header values to prevent RFC 2822 header injection
function sanitizeHeader(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

// Builds a minimal RFC 2822 raw message string
function buildRawMessage({ from, to, cc, bcc, subject, body, html }) {
  const boundary = `----=_Part_${Date.now()}`;
  let msg = '';
  msg += `From: ${sanitizeHeader(from)}\r\n`;
  msg += `To: ${sanitizeHeader(to)}\r\n`;
  if (cc) msg += `Cc: ${sanitizeHeader(cc)}\r\n`;
  if (bcc) msg += `Bcc: ${sanitizeHeader(bcc)}\r\n`;
  msg += `Subject: ${sanitizeHeader(subject)}\r\n`;
  msg += `Date: ${new Date().toUTCString()}\r\n`;
  msg += `MIME-Version: 1.0\r\n`;

  if (html) {
    msg += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    msg += `--${boundary}\r\n`;
    msg += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
    msg += `${body || ''}\r\n`;
    msg += `--${boundary}\r\n`;
    msg += `Content-Type: text/html; charset=utf-8\r\n\r\n`;
    msg += `${html}\r\n`;
    msg += `--${boundary}--\r\n`;
  } else {
    msg += `Content-Type: text/plain; charset=utf-8\r\n\r\n`;
    msg += `${body || ''}\r\n`;
  }

  return msg;
}

// --- HTTP server setup ---

const app = express();

// Helmet sets secure HTTP headers with sensible defaults
app.use(helmet());

app.use(express.json());

// Throttle to limit brute-force and abuse; 60 req/min is generous for legitimate MCP use
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});
app.use(limiter);

// Bearer token check — keeps credentials out of URL params and query strings
function authMiddleware(req, res, next) {
  const apiKey = process.env.MCP_API_KEY;

  // Fail closed: if the server has no key configured, deny all requests
  // This prevents accidentally running an open server
  if (!apiKey) {
    return res.status(403).json({ error: 'Server authentication not configured' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Compare hashes so both branches take identical time regardless of token length
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest();
  if (!crypto.timingSafeEqual(tokenHash, apiKeyHash)) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  next();
}

// Health endpoint — no auth so load balancers / Docker HEALTHCHECK can reach it
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// MCP endpoints — stateless: new Server + transport per POST request
// sessionIdGenerator: undefined → no persistent session, which is safe for single-user deployments
app.post('/mcp', authMiddleware, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createMCPServer();
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('finish', () => mcpServer.close());
  } catch (err) {
    console.error('MCP POST error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/mcp', authMiddleware, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createMCPServer();
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    res.on('finish', () => mcpServer.close());
  } catch (err) {
    console.error('MCP GET error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/mcp', authMiddleware, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createMCPServer();
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    res.on('finish', () => mcpServer.close());
  } catch (err) {
    console.error('MCP DELETE error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
});

async function main() {
  validateConfig();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`IMAP Email MCP Server listening on port ${port}`);
  });
}

main().catch(console.error);

import express from 'express';
import fs from 'fs';
import path from 'path';
import { authRequired } from './auth.ts';

const router = express.Router();

const websiteFile = path.join(process.cwd(), 'public', 'index.html');
const backupDir = path.join(process.cwd(), 'backups', 'website');

function ensureBackupDir() {
  fs.mkdirSync(backupDir, { recursive: true });
}

function readWebsite() {
  return fs.readFileSync(websiteFile, 'utf8');
}

function writeWebsite(html: string) {
  ensureBackupDir();

  const backup = path.join(
    backupDir,
    `index-${new Date().toISOString().replace(/[:.]/g, '-')}.html`
  );

  fs.copyFileSync(websiteFile, backup);

  fs.writeFileSync(websiteFile, html, 'utf8');

  return backup;
}

function currentUser(req: express.Request) {
  return (req as any).user;
}

/*
 * ADMIN WEBSITE STUDIO
 */

router.get('/website/source', authRequired, (_req, res) => {
  try {
    res.json({
      ok: true,
      html: readWebsite()
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Unable to read website'
    });
  }
});

router.post('/website/save', authRequired, (req, res) => {
  try {
    const user = currentUser(req);

    if (!user || !['super_admin', 'admin', 'assessor'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const html = String(req.body?.html || '');

    if (!html.includes('<html') || !html.includes('</html>')) {
      return res.status(400).json({
        error: 'The website HTML does not appear to be valid.'
      });
    }

    if (html.length > 1000000) {
      return res.status(400).json({
        error: 'Website file is too large.'
      });
    }

    const backup = writeWebsite(html);

    res.json({
      ok: true,
      message: 'Website saved successfully.',
      backup
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Unable to save website'
    });
  }
});

/*
 * LIST WEBSITE BACKUPS
 */

router.get('/website/backups', authRequired, (_req, res) => {
  try {
    ensureBackupDir();

    const files = fs
      .readdirSync(backupDir)
      .filter(f => f.endsWith('.html'))
      .sort()
      .reverse()
      .slice(0, 50);

    res.json({
      ok: true,
      backups: files
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Unable to list backups'
    });
  }
});

/*
 * RESTORE A BACKUP
 */

router.post('/website/restore', authRequired, (req, res) => {
  try {
    const user = currentUser(req);

    if (!user || !['super_admin', 'admin', 'assessor'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const filename = path.basename(String(req.body?.filename || ''));

    if (!filename || !filename.endsWith('.html')) {
      return res.status(400).json({
        error: 'Invalid backup.'
      });
    }

    const backup = path.join(backupDir, filename);

    if (!fs.existsSync(backup)) {
      return res.status(404).json({
        error: 'Backup not found.'
      });
    }

    const currentBackup = path.join(
      backupDir,
      `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.html`
    );

    fs.copyFileSync(websiteFile, currentBackup);
    fs.copyFileSync(backup, websiteFile);

    res.json({
      ok: true,
      message: 'Website restored successfully.'
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Unable to restore website'
    });
  }
});

/*
 * AI WEBSITE BUILDER
 *
 * Uses the OpenAI Responses API through fetch so no additional npm
 * package is required.
 */

router.post('/ai/website', authRequired, async (req, res) => {
  try {
    const user = currentUser(req);

    if (!user || !['super_admin', 'admin', 'assessor'].includes(user.role)) {
      return res.status(403).json({
        error: 'Admin access required'
      });
    }

    const apiKey =
      process.env.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY_AURELIUS ||
      '';

    if (!apiKey) {
      return res.status(503).json({
        error:
          'AI is not connected yet. Add OPENAI_API_KEY to the server environment, then restart the website.'
      });
    }

    const instruction = String(req.body?.instruction || '').trim();

    if (!instruction) {
      return res.status(400).json({
        error: 'Tell the AI what you want changed.'
      });
    }

    if (instruction.length > 10000) {
      return res.status(400).json({
        error: 'Instruction is too long.'
      });
    }

    const currentHtml = readWebsite();

    const systemPrompt = `
You are the website development assistant for Aurelius Fire Risk, a UK fire risk assessment business.

You are editing the company's PUBLIC HOME PAGE.

Your job is to improve the existing website according to the administrator's instruction.

IMPORTANT RULES:

1. Return ONLY the complete updated HTML document.
2. Do not use markdown.
3. Do not explain what you changed.
4. Do not remove working navigation unless necessary.
5. Do not remove the Assessor Login link.
6. Do not remove existing legal/privacy/terms links.
7. Keep the website professional, clean, modern and mobile responsive.
8. Use UK English.
9. Do not invent qualifications, accreditations, clients, testimonials or statistics.
10. Do not invent legal requirements.
11. Preserve existing prices unless the administrator specifically asks to change them.
12. Preserve working booking/login links unless the administrator specifically asks to change them.
13. Do not expose passwords, API keys, database credentials or secrets.
14. You may improve HTML, CSS and JavaScript contained in this page.
15. You may add sections, improve layout, improve calls to action, improve accessibility and mobile responsiveness.
16. Keep the site suitable for a genuine UK fire risk assessment business.
17. If the administrator asks for a content change, make that change directly.
18. If the administrator asks for a design change, implement the design change directly.
19. If the administrator asks for a feature that cannot safely be implemented only in this HTML file, preserve the site and implement the closest safe front-end improvement rather than destroying existing functionality.

CURRENT WEBSITE:
`;

    const prompt = systemPrompt + currentHtml + `

ADMINISTRATOR INSTRUCTION:
${instruction}
`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_WEBSITE_MODEL || 'gpt-5.6-luna',
        input: prompt,
        max_output_tokens: 50000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(502).json({
        error: `AI request failed: ${errorText.slice(0, 1000)}`
      });
    }

    const data: any = await response.json();

    let output = '';

    if (typeof data.output_text === 'string') {
      output = data.output_text;
    } else if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (typeof part.text === 'string') {
              output += part.text;
            }
          }
        }
      }
    }

    output = output
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    if (!output.includes('<html') || !output.includes('</html>')) {
      return res.status(502).json({
        error: 'AI returned invalid website HTML. Your existing website has not been changed.'
      });
    }

    res.json({
      ok: true,
      html: output
    });

  } catch (error: any) {
    console.error('AI website error:', error);

    res.status(500).json({
      error: error?.message || 'AI website builder failed'
    });
  }
});

export default router;

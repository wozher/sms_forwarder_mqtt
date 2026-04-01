import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(publicDir, 'dist');
const indexTemplatePath = path.join(publicDir, 'index.html');

const tmpCss = path.join(distDir, 'app.css');
const tmpJs = path.join(distDir, 'app.js');
const twInputCss = path.join(distDir, '__tw_input.css');

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

function sha8(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function cleanDist() {
  await ensureDir(distDir);
  const entries = await fs.readdir(distDir).catch(() => []);
  await Promise.all(entries.map(async (name) => {
    if (name === '.gitkeep') return;
    await fs.rm(path.join(distDir, name), { recursive: true, force: true });
  }));
}

function applyTemplate(templateHtml, cssFileName, jsFileName) {
  let html = templateHtml;

  // Replace the inline blocks after placeholders with built assets.
  html = replaceBlockAfterMarker(html, '<!-- BUILD:CSS -->', 'style', `<link rel="stylesheet" href="/${cssFileName}">`);
  html = replaceBlockAfterMarker(html, '<!-- BUILD:JS -->', 'script', `<script src="/${jsFileName}" defer></script>`);

  return html;
}

function findBlockAfterMarker(html, marker, tagName) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) throw new Error(`Template marker not found: ${marker}`);

  const after = html.slice(markerIdx + marker.length);
  const openRe = new RegExp(`<${tagName}[^>]*>`, 'i');
  const openMatch = after.match(openRe);
  if (!openMatch || openMatch.index == null) throw new Error(`Missing <${tagName}> after marker ${marker}`);
  const openIdx = markerIdx + marker.length + openMatch.index;
  const openTagLen = openMatch[0].length;
  const closeTag = `</${tagName}>`;
  const closeIdx = html.indexOf(closeTag, openIdx + openTagLen);
  if (closeIdx < 0) throw new Error(`Missing closing </${tagName}> after marker ${marker}`);

  const contentStart = openIdx + openTagLen;
  const contentEnd = closeIdx;
  const content = html.slice(contentStart, contentEnd);
  const blockStart = openIdx;
  const blockEnd = closeIdx + closeTag.length;

  return { content, blockStart, blockEnd };
}

function replaceBlockAfterMarker(html, marker, tagName, replacementHtml) {
  const { blockStart, blockEnd } = findBlockAfterMarker(html, marker, tagName);
  return html.slice(0, blockStart) + replacementHtml + html.slice(blockEnd);
}

async function main() {
  await cleanDist();

  const templateHtml = await fs.readFile(indexTemplatePath, 'utf8');

  // Extract inline CSS/JS blocks for building production assets.
  const inlineCss = findBlockAfterMarker(templateHtml, '<!-- BUILD:CSS -->', 'style').content;
  const inlineJs = findBlockAfterMarker(templateHtml, '<!-- BUILD:JS -->', 'script').content;

  // Build CSS: place custom CSS BEFORE Tailwind utilities so .hidden/.flex win.
  // Some custom selectors (e.g. .modal-overlay) set display, which would otherwise override .hidden.
  await fs.writeFile(
    twInputCss,
    `@tailwind base;\n@tailwind components;\n\n${inlineCss}\n\n@tailwind utilities;\n`,
    'utf8'
  );
  await run('npx', ['tailwindcss', '-c', 'tailwind.config.js', '-i', twInputCss, '-o', tmpCss, '--minify'], { cwd: rootDir });

  // Build JS: minify extracted inline script (do not bundle to keep global functions for inline handlers)
  const rawJs = path.join(distDir, '__app_raw.js');
  await fs.writeFile(rawJs, inlineJs, 'utf8');
  await run('npx', ['esbuild', rawJs, '--minify', '--platform=browser', '--target=es2018', `--outfile=${tmpJs}`], { cwd: rootDir });

  const cssBuf = await fs.readFile(tmpCss);
  const jsBuf = await fs.readFile(tmpJs);
  const cssHash = sha8(cssBuf);
  const jsHash = sha8(jsBuf);
  const cssName = `app.${cssHash}.css`;
  const jsName = `app.${jsHash}.js`;

  await fs.rename(tmpCss, path.join(distDir, cssName));
  await fs.rename(tmpJs, path.join(distDir, jsName));

  const outHtml = applyTemplate(templateHtml, cssName, jsName);
  await fs.writeFile(path.join(distDir, 'index.html'), outHtml, 'utf8');

  // Cleanup temp tailwind input
  await fs.rm(twInputCss, { force: true });
  await fs.rm(path.join(distDir, '__app_raw.js'), { force: true });

  const manifest = {
    css: `/${cssName}`,
    js: `/${jsName}`,
    builtAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(distDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`Built: public/dist/${cssName}`);
  console.log(`Built: public/dist/${jsName}`);
}

main().catch((err) => {
  console.error('[build-web] failed:', err);
  process.exit(1);
});

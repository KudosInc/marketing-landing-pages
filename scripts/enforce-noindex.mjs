import { promises as fs } from 'node:fs';
import path from 'node:path';

const DIST_DIR = path.resolve('dist');
const ROBOTS_META = '<meta name="robots" content="noindex, nofollow">';
const GOOGLEBOT_META = '<meta name="googlebot" content="noindex, nofollow">';

async function walkHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const htmlFiles = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      htmlFiles.push(...await walkHtmlFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.html')) {
      htmlFiles.push(fullPath);
    }
  }

  return htmlFiles;
}

function injectNoIndexMeta(html) {
  if (html.includes('name="robots"') && html.includes('name="googlebot"')) {
    return html;
  }

  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch || headMatch.index === undefined) {
    return html;
  }

  const insertionIndex = headMatch.index + headMatch[0].length;
  const tagsToInsert = [
    !html.includes('name="robots"') ? ROBOTS_META : '',
    !html.includes('name="googlebot"') ? GOOGLEBOT_META : '',
  ].filter(Boolean).join('');

  return `${html.slice(0, insertionIndex)}${tagsToInsert}${html.slice(insertionIndex)}`;
}

async function main() {
  let htmlFiles = [];

  try {
    htmlFiles = await walkHtmlFiles(DIST_DIR);
  } catch (error) {
    console.error(`Unable to scan dist output at ${DIST_DIR}`);
    throw error;
  }

  await Promise.all(
    htmlFiles.map(async (filePath) => {
      const current = await fs.readFile(filePath, 'utf8');
      const updated = injectNoIndexMeta(current);

      if (updated !== current) {
        await fs.writeFile(filePath, updated, 'utf8');
      }
    })
  );
}

await main();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function collectTsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

export function buildAll() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. Copy public/ assets
  copyDirRecursive(PUBLIC_DIR, DIST_DIR);

  // 2. Copy stylesheet
  const distSrcDir = path.join(DIST_DIR, 'src');
  fs.mkdirSync(distSrcDir, { recursive: true });
  fs.copyFileSync(path.join(SRC_DIR, 'style.css'), path.join(distSrcDir, 'style.css'));

  // 3. Process index.html
  const indexHtml = fs
    .readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8')
    .replace(/src=["']\.?\/src\/main\.ts["']/, 'src="./src/main.js"');
  fs.writeFileSync(path.join(DIST_DIR, 'index.html'), indexHtml, 'utf8');

  // 4. Transpile all TypeScript modules to pure ESM JS
  const tsFiles = collectTsFiles(SRC_DIR);
  for (const filePath of tsFiles) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const cleaned = raw
      .replace(/import\s+['"]\.\/style\.css['"];?\r?\n?/g, '')
      .replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');

    const result = ts.transpileModule(cleaned, {
      fileName: filePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
        removeComments: false,
      },
    });

    const relPath = path.relative(SRC_DIR, filePath).replace(/\.ts$/, '.js');
    const outPath = path.join(distSrcDir, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.outputText, 'utf8');
  }

  console.log(`Built ${tsFiles.length} TypeScript modules into ${DIST_DIR}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll();
}

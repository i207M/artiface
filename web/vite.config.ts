import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gzip } from 'node:zlib'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const directory = dirname(fileURLToPath(import.meta.url))
const compress = promisify(gzip)

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-pdf-assets',
      async writeBundle(_options, bundle) {
        const output = resolve(directory, 'dist')
        await mkdir(output, { recursive: true })
        await Promise.all([
          ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((name) =>
            cp(resolve(directory, 'node_modules/pdfjs-dist', name), resolve(output, 'pdfjs', name), {
              recursive: true,
            }),
          ),
          writeFile(resolve(output, '.gitkeep'), '\n'),
        ])
        const shell = [
          '/', '/index.html', '/manifest.webmanifest', '/favicon.svg',
          '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
          ...Object.keys(bundle).filter(name => /\.(?:js|css|svg)$/.test(name)).map(name => `/${name}`),
        ]
        const template = await readFile(resolve(directory, 'public/sw.js'), 'utf8')
        const hash = createHash('sha256').update(template).update(JSON.stringify(Object.keys(bundle).sort()))
        for (const name of ['manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png']) {
          hash.update(await readFile(resolve(directory, 'public', name)))
        }
        const worker = template.replace('__BUILD_ID__', hash.digest('hex').slice(0, 16))
          .replace("['__SHELL_ASSETS__']", JSON.stringify(shell))
        await writeFile(resolve(output, 'sw.js'), worker)
        // Public assets are compressed once during the build, never on a request.
        // Keep their URLs unchanged so the worker and browser share the same cache keys.
        for (const name of [...Object.keys(bundle), 'sw.js', 'manifest.webmanifest']) {
          if (!/\.(?:js|css|svg|html|json|webmanifest)$/.test(name)) continue
          const filename = resolve(output, name)
          const data = await readFile(filename)
          const compressed = await compress(data, { level: 9 })
          if (compressed.length < data.length) await writeFile(`${filename}.gz`, compressed)
          else await rm(`${filename}.gz`, { force: true })
        }
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
    rolldownOptions: {
      output: {
        // Vite drops worker entry exports; PDF.js also imports this module when
        // workers are unavailable and needs the named handler for its fallback.
        footer: chunk => chunk.isEntry && chunk.name === 'pdf.worker'
          ? 'const artifaceWorkerHandler = globalThis.pdfjsWorker.WorkerMessageHandler; export { artifaceWorkerHandler as WorkerMessageHandler };'
          : '',
      },
    },
  },
})

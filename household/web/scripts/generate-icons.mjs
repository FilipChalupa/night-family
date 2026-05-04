// Render PWA icons from `public/icon.svg` into PNG variants.
//
// iOS Safari (`apple-touch-icon`) ignores SVG icons, and some Android
// versions dislike them in the install prompt — so we ship pre-rendered PNGs
// alongside the SVG. Run when `icon.svg` changes; commit the output.
//
// Sizes:
//   180×180 — apple-touch-icon (required for iOS Add to Home Screen)
//   192×192 — Android home-screen / Chromium PWA install prompt
//   512×512 — splash screen / large icon contexts

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '..', 'public')
const svgPath = resolve(publicDir, 'icon.svg')

const SIZES = [180, 192, 512]

await mkdir(publicDir, { recursive: true })

for (const size of SIZES) {
	const out = resolve(publicDir, `icon-${size}.png`)
	await sharp(svgPath, { density: 384 }).resize(size, size).png().toFile(out)
	console.log(`wrote public/icon-${size}.png`)
}

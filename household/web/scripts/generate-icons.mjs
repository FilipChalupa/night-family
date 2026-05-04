// Render PWA icons from `public/icon.svg` into PNG variants.
//
// iOS Safari (`apple-touch-icon`) ignores SVG icons, and some Android
// versions / older browsers dislike them — so we ship pre-rendered PNGs
// alongside the SVG. Run when `icon.svg` changes; commit the output.
//
// Sizes:
//   32×32             — browser-tab favicon fallback for engines without
//                       reliable SVG-favicon support.
//   180×180           — apple-touch-icon (required for iOS Add to Home Screen).
//   192×192, 512×512  — Chromium PWA install prompt (Android, Windows, ChromeOS).
//   512×512 maskable  — Android adaptive icons. The design is scaled to the
//                       inner 80% safe zone and composited onto a full-bleed
//                       brand-color canvas so OEM masks (circle, squircle,
//                       teardrop) can crop the bleed without clipping the
//                       crescent.

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '..', 'public')
const svgPath = resolve(publicDir, 'icon.svg')

// Brand background — must match the `<rect fill="…">` in icon.svg and the
// manifest's `background_color`, otherwise the maskable bleed shows a seam.
const BG = '#0c0d10'

const PLAIN = [32, 180, 192, 512]

await mkdir(publicDir, { recursive: true })

for (const size of PLAIN) {
	const out = resolve(publicDir, `icon-${size}.png`)
	await sharp(svgPath, { density: 384 }).resize(size, size).png().toFile(out)
	console.log(`wrote public/icon-${size}.png`)
}

// Maskable 512: design at 80% (410px) centered on a 512×512 brand-color
// canvas. The 51px bleed on each side is what OEM masks may eat.
const inner = await sharp(svgPath, { density: 384 }).resize(410, 410).png().toBuffer()
const maskableOut = resolve(publicDir, 'icon-512-maskable.png')
await sharp({
	create: { width: 512, height: 512, channels: 3, background: BG },
})
	.composite([{ input: inner, top: 51, left: 51 }])
	.png()
	.toFile(maskableOut)
console.log('wrote public/icon-512-maskable.png')

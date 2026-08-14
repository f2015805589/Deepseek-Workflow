// One-shot diagnosis: open the desktop host URL in headless Chromium and
// capture renderer console errors plus the settled-or-failed boot state.
import { chromium } from 'playwright'

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node probe-page.mjs <url>')
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
})
page.on('pageerror', (error) => { errors.push(`pageerror: ${String(error)}`) })
await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
await page.waitForTimeout(12_000)
const text = await page.evaluate(() => document.body.textContent ?? '')
console.log('BODY (first 600 chars):', text.slice(0, 600).replace(/\s+/g, ' '))
console.log('ERRORS:')
for (const error of errors) console.log(' -', error.slice(0, 500))
await browser.close()

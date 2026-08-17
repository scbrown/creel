/* creel — test-device.js (creel-piv): device classification + the fleet tab
 * cap. Zero dependencies. Run: node tests/test-device.js
 */
'use strict';

const assert = require('assert');
const device = require('../app/creel-device.js');

async function main() {
  let n = 0;
  const ok = (name) => { n++; console.log('  ✓ ' + name); };

  // ── classification ──────────────────────────────────────────────────
  const CASES = [
    // [name, env, expect]
    ['iPhone portrait', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', touch: true, width: 390 }, 'mobile'],
    ['Android phone', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126', touch: true, width: 412 }, 'mobile'],
    ['touch phone width', { userAgent: 'desktop-ua', touch: true, width: 375 }, 'mobile'], // small touch viewport is a phone
    ['iPadOS landscape (Mac UA)', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', touch: true, width: 1024 }, 'tablet'],
    ['iPadOS portrait', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', touch: true, width: 768 }, 'tablet'],
    ['Android tablet portrait', { userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-T500) AppleWebKit/537.36', touch: true, width: 800 }, 'tablet'],
    ['desktop', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126', touch: false, width: 1920 }, 'desktop'],
    ['touch laptop', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', touch: true, width: 1512 }, 'desktop'],
    ['headless/unknown (no env)', {}, 'desktop'],
  ];
  for (const [name, env, expect] of CASES) {
    const i = device.info(env);
    assert.strictEqual(i.kind, expect, `${name}: kind`);
    assert.strictEqual(i.isMobile, expect === 'mobile', `${name}: isMobile`);
    ok(`classifies ${name} → ${expect}`);
  }

  // ── tab caps ────────────────────────────────────────────────────────
  assert.strictEqual(device.TAB_CAPS.mobile, 3, 'mobile cap is 3');
  assert.strictEqual(device.TAB_CAPS.tablet, 4, 'tablet cap is 4');
  assert.strictEqual(device.TAB_CAPS.desktop, 8, 'desktop cap is 8');
  ok('TAB_CAPS = mobile 3 / tablet 4 / desktop 8');

  assert.strictEqual(device.tabCap(2), 2, 'explicit override honored');
  assert.strictEqual(device.tabCap('5'), 5, 'string override coerced');
  assert.strictEqual(device.tabCap(24), 24, 'upper bound accepted');
  assert.strictEqual(device.tabCap(25), device.TAB_CAPS[device.info().kind] || 8, 'over-budget override falls back to device default');
  assert.strictEqual(device.tabCap(0), device.TAB_CAPS[device.info().kind] || 8, 'zero override falls back to device default');
  ok('tabCap honors 1..24 overrides, falls back to the device default otherwise');

  // ── module shape ────────────────────────────────────────────────────
  assert.strictEqual(typeof device.info, 'function');
  assert.strictEqual(typeof device.tabCap, 'function');
  assert.strictEqual(typeof device.kind, 'function');
  assert.strictEqual(typeof device.isMobile, 'function');
  ok('exports info/tabCap/kind/isMobile for node');

  console.log(`device: ${n} checks ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });

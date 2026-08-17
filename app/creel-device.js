/* creel — device awareness: the harness knows what it's running on.
 *
 * Mobile browsers throttle and kill background tabs, so the fleet caps how
 * many agent tabs may run at once — 3 on phones, 4 on tablets, 8 on desktop —
 * and every spawn path consults that cap. The device is also surfaced to
 * agents (fleet_device, ui_tabs/ui_describe rows) so a burst can plan around
 * it instead of discovering the limit the hard way.
 *
 * Pure and dependency-free. Loads before creel-fleet.js in onepagent.html;
 * also CommonJS-exports so `node tests/test-device.js` can exercise it.
 */
(() => {
  'use strict';

  /** Concurrent agent-tab budget per device class. Mobile browsers evict
   *  background tabs aggressively, so the budget is small there; desktop
   *  browsers are the full harness. */
  const TAB_CAPS = { mobile: 3, tablet: 4, desktop: 8 };

  /** Classify the current device. `env` lets tests inject a fake environment
   *  ({ userAgent, touch, width }); with no env, the real globals are read. */
  function info(env) {
    env = env || {};
    const ua = env.userAgent != null ? String(env.userAgent)
      : (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const touch = env.touch != null ? !!env.touch
      : (typeof navigator !== 'undefined')
        && ((navigator.maxTouchPoints > 0)
          || (typeof window !== 'undefined' && 'ontouchstart' in window)
          || (navigator.msMaxTouchPoints > 0));
    const w = env.width != null ? Number(env.width)
      : (typeof window !== 'undefined'
          && (window.innerWidth || (document.documentElement && document.documentElement.clientWidth))) || 0;
    // A phone UA says so: iPhone/iPod always, Android phones carry a "Mobile"
    // token that Android tablets deliberately omit. Tablet UAs (iPad,
    // PlayBook, Silk) are never mobile, whatever else they claim.
    const mobileUA = /Mobi|iPhone|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua)
      && !/iPad|PlayBook|Silk/i.test(ua);
    const ipad = /iPad|Macintosh/.test(ua) && touch; // iPadOS 13+ reports a Mac UA
    const kind = (mobileUA || (touch && w > 0 && w < 768)) ? 'mobile'      // phones
      : ((touch && w > 0 && w < 1024) || ipad) ? 'tablet'                  // iPads, small tablets
      : 'desktop';
    return { kind, isMobile: kind === 'mobile', touch, width: w, ua: ua.slice(0, 160) };
  }

  /** The concurrent-tab cap for this device, or an explicit 1..24 override. */
  function tabCap(override) {
    const n = override == null ? NaN : parseInt(String(override), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 24) return n;
    return TAB_CAPS[info().kind] || 8;
  }

  const api = {
    TAB_CAPS,
    info,
    tabCap,
    kind: () => info().kind,
    isMobile: () => info().kind === 'mobile',
  };

  if (typeof window !== 'undefined') window.CreelDevice = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

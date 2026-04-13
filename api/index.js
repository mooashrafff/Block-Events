/**
 * Vercel serverless entry: forward the full request to the Express app.
 * Some edge cases strip or alter req.url; normalize so routes like POST /api/auth/* match.
 */
const app = require('../server');

module.exports = (req, res) => {
  if (process.env.VERCEL) {
    const raw = req.url || '';
    const looksStripped =
      raw === '/' || raw === '' || raw === '/api' || (raw.startsWith('/api') === false && !raw.startsWith('/_next'));
    if (looksStripped) {
      const hdr = req.headers || {};
      const orig = String(
        hdr['x-vercel-original-url'] ||
          hdr['x-invoke-path'] ||
          hdr['x-forwarded-uri'] ||
          hdr['x-url'] ||
          ''
      );
      const pathPart = orig.startsWith('http') ? (() => {
        try {
          return new URL(orig).pathname;
        } catch {
          return '';
        }
      })() : orig.split('?')[0];
      if (pathPart.startsWith('/')) {
        const qFromRaw = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        const qFromOrig = orig.includes('?') && !orig.startsWith('http') ? orig.slice(orig.indexOf('?')) : '';
        req.url = pathPart + (qFromRaw || qFromOrig || '');
      }
    }
  }
  return app(req, res);
};

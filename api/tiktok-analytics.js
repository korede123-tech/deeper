const DEFAULT_ACTOR_ID = 'clockworks~tiktok-scraper';
const CLOCKWORKS_ACTOR_ID = 'clockworks~tiktok-scraper';
const CLOCKWORKS_ACTOR_RUN_ID = 'GdWCkxBtKWOsKjdch';

const getBodyObject = (body) => {
  if (!body) {
    return {};
  }

  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return typeof body === 'object' && !Array.isArray(body) ? body : {};
};

const isValidTikTokUrl = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'tiktok.com' || host.endsWith('.tiktok.com');
  } catch {
    return false;
  }
};

const sanitizeUrls = (rawUrls) => {
  if (typeof rawUrls !== 'string') {
    return [];
  }

  const cleaned = rawUrls
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isValidTikTokUrl(line));

  return cleaned;
};

const isClockworksTikTokActor = (actorId) => {
  if (typeof actorId !== 'string') {
    return false;
  }

  const normalized = actorId.trim().toLowerCase();
  return normalized === CLOCKWORKS_ACTOR_ID ||
    actorId === CLOCKWORKS_ACTOR_RUN_ID ||
    normalized.endsWith('~tiktok-scraper');
};

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_TIKTOK_ACTOR_ID || DEFAULT_ACTOR_ID;

  if (!token) {
    response.status(500).json({
      error: {
        type: 'configuration-error',
        message: 'Missing APIFY_TOKEN in environment variables.',
      },
    });
    return;
  }

  const body = getBodyObject(request.body);
  const urlFromBody = typeof body.url === 'string' ? body.url : '';
  const rawUrls = typeof body.urls === 'string' && body.urls.trim()
    ? body.urls
    : urlFromBody;

  const postUrlsFromBody = Array.isArray(body.postURLs)
    ? body.postURLs
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => isValidTikTokUrl(value))
    : [];

  const urls = postUrlsFromBody.length > 0
    ? postUrlsFromBody
    : sanitizeUrls(rawUrls);

  if (urls.length === 0) {
    response.status(400).json({
      error: {
        type: 'validation-error',
        message: 'Provide at least one valid TikTok video URL.',
      },
    });
    return;
  }

  const useApifyProxy = typeof body.useApifyProxy === 'boolean'
    ? body.useApifyProxy
    : true;
  const apifyProxyGroups = Array.isArray(body.apifyProxyGroups) && body.apifyProxyGroups.length > 0
    ? body.apifyProxyGroups
    : ['RESIDENTIAL'];

  const upstreamBody = isClockworksTikTokActor(actorId)
    ? {
        postURLs: urls,
      }
    : {
        urls: urls.join('\n'),
        useApifyProxy,
        apifyProxyGroups,
      };

  const upstreamUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55_000);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    });

    const contentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';
    const payload = await upstreamResponse.text();

    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.status(upstreamResponse.status).send(payload);
  } catch {
    response.status(502).json({
      error: {
        type: 'upstream-request-failed',
        message: 'Unable to fetch TikTok analytics from Apify.',
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const DEFAULT_ACTOR_ID = 'apify~instagram-scraper';

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

const isValidInstagramUrl = (value) => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'instagram.com' || host.endsWith('.instagram.com');
  } catch {
    return false;
  }
};

const sanitizeDirectUrls = (directUrls) => {
  if (!Array.isArray(directUrls)) {
    return [];
  }

  return directUrls
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => isValidInstagramUrl(value));
};

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_INSTAGRAM_ACTOR_ID || DEFAULT_ACTOR_ID;

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
  const directUrls = sanitizeDirectUrls(body.directUrls);

  if (directUrls.length === 0) {
    response.status(400).json({
      error: {
        type: 'validation-error',
        message: 'Provide at least one valid Instagram post URL in directUrls.',
      },
    });
    return;
  }

  const upstreamBody = {
    directUrls,
    resultsType: typeof body.resultsType === 'string' ? body.resultsType : 'details',
    resultsLimit: typeof body.resultsLimit === 'number' ? body.resultsLimit : 1,
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
        message: 'Unable to fetch Instagram analytics from Apify.',
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

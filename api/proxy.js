const SOURCE_BASE_URL = {
  instagram: 'https://www.instagram.com',
  jina: 'https://r.jina.ai',
  noembed: 'https://noembed.com',
};

const REQUEST_HEADERS = {
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const getSingleQueryParam = (value) => {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return typeof value === 'string' ? value : null;
};

const isSafePath = (pathValue) => {
  if (!pathValue || !pathValue.startsWith('/')) {
    return false;
  }

  if (pathValue.startsWith('//') || pathValue.includes('://')) {
    return false;
  }

  return true;
};

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const source = getSingleQueryParam(request.query.source);
  const pathValue = getSingleQueryParam(request.query.path);

  if (!source || !(source in SOURCE_BASE_URL)) {
    response.status(400).json({ error: 'Invalid source' });
    return;
  }

  if (!isSafePath(pathValue)) {
    response.status(400).json({ error: 'Invalid path' });
    return;
  }

  const targetUrl = `${SOURCE_BASE_URL[source]}${pathValue}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: REQUEST_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    const contentType = upstreamResponse.headers.get('content-type') || 'text/plain; charset=utf-8';
    const payload = await upstreamResponse.text();

    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.status(upstreamResponse.status).send(payload);
  } catch {
    response.status(502).json({ error: 'Upstream request failed' });
  } finally {
    clearTimeout(timeoutId);
  }
}

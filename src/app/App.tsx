import { useMemo, useState } from 'react';

type DashboardStatus = 'idle' | 'loading' | 'success' | 'unavailable';
type NumericMetric = number | null;

interface ParsedInstagramUrl {
  mediaType: 'p' | 'reel' | 'tv';
  shortcode: string;
  canonicalUrl: string;
}

interface FetchedInstagramAnalytics {
  shortcode: string;
  postLabel: string;
  createdAt: string | null;
  supportsDateRange: boolean;
  metrics: {
    views: NumericMetric;
    reach: NumericMetric;
    likes: NumericMetric;
    comments: NumericMetric;
    shares: NumericMetric;
    reposts: NumericMetric;
  };
}

type ProxySource = 'instagram' | 'jina' | 'noembed';

const UNAVAILABLE_TEXT = 'Unavailable';
const RANGE_UNAVAILABLE_TEXT = 'Unavailable for selected range';

const buildProxyUrl = (source: ProxySource, path: string): string => {
  if (import.meta.env.PROD) {
    return `/api/proxy?source=${source}&path=${encodeURIComponent(path)}`;
  }

  const devPrefix = source === 'instagram'
    ? '/instagram-proxy'
    : source === 'jina'
    ? '/jina-proxy'
    : '/noembed-proxy';

  return `${devPrefix}${path}`;
};

const toIsoDate = (date: Date): string => date.toISOString().split('T')[0];

const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value);

const normalizeResponseText = (value: string): string => value.replace(/\\"/g, '"').replace(/\\\//g, '/');

const parseCompactNumber = (raw: string): number | null => {
  const normalized = raw.trim().toUpperCase().replace(/,/g, '');
  const compactMatch = normalized.match(/^(\d+(?:\.\d+)?)([KMB])$/);
  if (compactMatch) {
    const amount = Number(compactMatch[1]);
    if (!Number.isFinite(amount)) {
      return null;
    }

    const multiplier = compactMatch[2] === 'K'
      ? 1_000
      : compactMatch[2] === 'M'
      ? 1_000_000
      : 1_000_000_000;

    return Math.round(amount * multiplier);
  }

  const cleaned = normalized.replace(/[^\d.]/g, '');
  if (!cleaned) {
    return null;
  }

  const numericValue = Number(cleaned);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue);
};

const firstNumberMatch = (text: string, patterns: RegExp[]): number | null => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const parsed = parseCompactNumber(match[1]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
};

const countAvailableMetrics = (metrics: FetchedInstagramAnalytics['metrics']): number =>
  Object.values(metrics).reduce(
    (total, metricValue) => (metricValue === null ? total : total + 1),
    0,
  );

const pickMoreCompleteResult = (
  primary: FetchedInstagramAnalytics,
  fallback: FetchedInstagramAnalytics,
): FetchedInstagramAnalytics => {
  const primaryCount = countAvailableMetrics(primary.metrics);
  const fallbackCount = countAvailableMetrics(fallback.metrics);

  if (fallbackCount > primaryCount) {
    return fallback;
  }

  if (fallbackCount < primaryCount) {
    return primary;
  }

  if (!primary.createdAt && fallback.createdAt) {
    return fallback;
  }

  if (primary.createdAt && !fallback.createdAt) {
    return primary;
  }

  const primarySignal =
    (primary.metrics.views ?? 0) +
    (primary.metrics.likes ?? 0) +
    (primary.metrics.comments ?? 0);

  const fallbackSignal =
    (fallback.metrics.views ?? 0) +
    (fallback.metrics.likes ?? 0) +
    (fallback.metrics.comments ?? 0);

  return fallbackSignal > primarySignal ? fallback : primary;
};

const firstDateMatch = (text: string): string | null => {
  const timestampPatterns = [
    /"taken_at_timestamp"\s*:\s*(\d{9,13})/i,
    /"taken_at"\s*:\s*(\d{9,13})/i,
    /\btaken_at_timestamp\b\s*:\s*(\d{9,13})/i,
    /\btaken_at\b\s*:\s*(\d{9,13})/i,
  ];

  for (const pattern of timestampPatterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const timestamp = Number(match[1]);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    const milliseconds = timestamp > 9999999999 ? timestamp : timestamp * 1000;
    const parsedDate = new Date(milliseconds);
    if (!Number.isNaN(parsedDate.getTime())) {
      return toIsoDate(parsedDate);
    }
  }

  const datePatterns = [
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /"uploadDate"\s*:\s*"([^"]+)"/i,
    /Posted on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i,
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const parsedDate = new Date(match[1]);
    if (!Number.isNaN(parsedDate.getTime())) {
      return toIsoDate(parsedDate);
    }
  }

  return null;
};

const firstPostLabelMatch = (text: string, shortcode: string): string => {
  const patterns = [
    /"title"\s*:\s*"([^"]+)"/i,
    /<title>([^<]+)<\/title>/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const cleaned = match[1]
      .replace(/\|\s*Instagram.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      continue;
    }

    return cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned;
  }

  return `Post ${shortcode}`;
};

const parseInstagramUrl = (value: string): ParsedInstagramUrl | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'instagram.com' && host !== 'm.instagram.com') {
    return null;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    return null;
  }

  const mediaType = pathParts[0].toLowerCase();
  if (mediaType !== 'p' && mediaType !== 'reel' && mediaType !== 'tv') {
    return null;
  }

  const shortcode = pathParts[1];
  if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    return null;
  }

  return {
    mediaType,
    shortcode,
    canonicalUrl: `https://www.instagram.com/${mediaType}/${shortcode}/`,
  };
};

const fetchWithTimeout = async (url: string, timeoutMs = 12_000): Promise<Response | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, text/html, */*',
      },
    });

    if (!response.ok) {
      return null;
    }

    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const fetchWithRetry = async (
  url: string,
  attempts = 2,
  timeoutMs = 12_000,
): Promise<Response | null> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (response) {
      return response;
    }

    if (attempt < attempts - 1) {
      await wait(250 * (attempt + 1));
    }
  }

  return null;
};

const fetchTextSource = async (url: string): Promise<string | null> => {
  const response = await fetchWithRetry(url);
  if (!response) {
    return null;
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
};

const fetchJsonSource = async (url: string): Promise<Record<string, unknown> | null> => {
  const response = await fetchWithRetry(url);
  if (!response) {
    return null;
  }

  try {
    const payload = await response.json();
    if (typeof payload === 'object' && payload !== null) {
      return payload as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
};

const fetchPublicInstagramAnalytics = async (
  parsedUrl: ParsedInstagramUrl,
): Promise<FetchedInstagramAnalytics | null> => {
  const fetchForMediaType = async (
    mediaType: ParsedInstagramUrl['mediaType'],
  ): Promise<FetchedInstagramAnalytics | null> => {
    const canonicalUrl = `https://www.instagram.com/${mediaType}/${parsedUrl.shortcode}/`;

    const localEmbedPath = buildProxyUrl(
      'instagram',
      `/${mediaType}/${parsedUrl.shortcode}/embed/captioned/`,
    );
    const localPostPath = buildProxyUrl('instagram', `/${mediaType}/${parsedUrl.shortcode}/`);

    const jinaProxyPostPath = buildProxyUrl(
      'jina',
      `/http://www.instagram.com/${mediaType}/${parsedUrl.shortcode}/`,
    );
    const jinaProxyJsonHintPath = buildProxyUrl(
      'jina',
      `/http://www.instagram.com/${mediaType}/${parsedUrl.shortcode}/?__a=1&__d=dis`,
    );
    const jinaProxyEmbedPath = buildProxyUrl(
      'jina',
      `/http://www.instagram.com/${mediaType}/${parsedUrl.shortcode}/embed/captioned/`,
    );

    const jinaDirectBase = `https://r.jina.ai/http://www.instagram.com/${mediaType}/${parsedUrl.shortcode}/`;
    const noEmbedUrl = buildProxyUrl(
      'noembed',
      `/embed?url=${encodeURIComponent(canonicalUrl)}`,
    );

    const [
      localEmbed,
      localPost,
      jinaProxyPost,
      jinaProxyJsonHint,
      jinaProxyEmbed,
      jinaDirectPost,
      jinaDirectJsonHint,
      jinaDirectEmbed,
      noEmbed,
    ] = await Promise.all([
      fetchTextSource(localEmbedPath),
      fetchTextSource(localPostPath),
      fetchTextSource(jinaProxyPostPath),
      fetchTextSource(jinaProxyJsonHintPath),
      fetchTextSource(jinaProxyEmbedPath),
      fetchTextSource(jinaDirectBase),
      fetchTextSource(`${jinaDirectBase}?__a=1&__d=dis`),
      fetchTextSource(`${jinaDirectBase}embed/captioned/`),
      fetchJsonSource(noEmbedUrl),
    ]);

    const collectedSources: string[] = [];
    if (localEmbed) {
      collectedSources.push(localEmbed);
    }
    if (localPost) {
      collectedSources.push(localPost);
    }
    if (jinaProxyPost) {
      collectedSources.push(jinaProxyPost);
    }
    if (jinaProxyJsonHint) {
      collectedSources.push(jinaProxyJsonHint);
    }
    if (jinaProxyEmbed) {
      collectedSources.push(jinaProxyEmbed);
    }
    if (jinaDirectPost) {
      collectedSources.push(jinaDirectPost);
    }
    if (jinaDirectJsonHint) {
      collectedSources.push(jinaDirectJsonHint);
    }
    if (jinaDirectEmbed) {
      collectedSources.push(jinaDirectEmbed);
    }
    if (noEmbed) {
      collectedSources.push(JSON.stringify(noEmbed));
    }

    if (collectedSources.length === 0) {
      return null;
    }

    const combined = normalizeResponseText(collectedSources.join('\n'));

    const views = firstNumberMatch(combined, [
      /"video_view_count"\s*:\s*(\d+)/i,
      /"view_count"\s*:\s*(\d+)/i,
      /"play_count"\s*:\s*(\d+)/i,
      /"video_play_count"\s*:\s*(\d+)/i,
      /\bvideo_view_count\b\s*:\s*(\d+)/i,
      /\bview_count\b\s*:\s*(\d+)/i,
      /\bplay_count\b\s*:\s*(\d+)/i,
      /\bvideo_play_count\b\s*:\s*(\d+)/i,
      /([\d,.]+\s*[KMB]?)\s+video\s+views/i,
      /([\d,.]+\s*[KMB]?)\s+views/i,
      /([\d,.]+\s*[KMB]?)\s+plays/i,
    ]);

    const likes = firstNumberMatch(combined, [
      /"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
      /"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
      /"like_count"\s*:\s*(\d+)/i,
      /\bedge_media_preview_like\b\s*:\s*\{\s*\bcount\b\s*:\s*(\d+)/i,
      /\bedge_liked_by\b\s*:\s*\{\s*\bcount\b\s*:\s*(\d+)/i,
      /\blike_count\b\s*:\s*(\d+)/i,
      /LikeAction[\s\S]{0,200}?"userInteractionCount"\s*:\s*"?([\d,.]+\s*[KMB]?)"?/i,
      /LikeAction[\s\S]{0,240}?\buserInteractionCount\b\s*:\s*"?([\d,.]+\s*[KMB]?)"?/i,
      /([\d,.]+\s*[KMB]?)\s+likes/i,
    ]);

    const comments = firstNumberMatch(combined, [
      /"edge_media_to_parent_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
      /"edge_media_to_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
      /"comment_count"\s*:\s*(\d+)/i,
      /\bedge_media_to_parent_comment\b\s*:\s*\{\s*\bcount\b\s*:\s*(\d+)/i,
      /\bedge_media_to_comment\b\s*:\s*\{\s*\bcount\b\s*:\s*(\d+)/i,
      /\bcomment_count\b\s*:\s*(\d+)/i,
      /CommentAction[\s\S]{0,200}?"userInteractionCount"\s*:\s*"?([\d,.]+\s*[KMB]?)"?/i,
      /CommentAction[\s\S]{0,240}?\buserInteractionCount\b\s*:\s*"?([\d,.]+\s*[KMB]?)"?/i,
      /View all\s+([\d,.]+\s*[KMB]?)\s+comments/i,
      /([\d,.]+\s*[KMB]?)\s+comments/i,
    ]);

    const shares = firstNumberMatch(combined, [
      /"share_count"\s*:\s*(\d+)/i,
      /"reshare_count"\s*:\s*(\d+)/i,
      /\bshare_count\b\s*:\s*(\d+)/i,
      /\breshare_count\b\s*:\s*(\d+)/i,
      /ShareAction[\s\S]{0,240}?\buserInteractionCount\b\s*:\s*"?([\d,.]+\s*[KMB]?)"?/i,
      /([\d,.]+\s*[KMB]?)\s+shares/i,
    ]);

    const reach = firstNumberMatch(combined, [
      /"reach_count"\s*:\s*(\d+)/i,
      /\breach_count\b\s*:\s*(\d+)/i,
    ]);

    const createdAt = firstDateMatch(combined);
    const postLabel = firstPostLabelMatch(combined, parsedUrl.shortcode);

    return {
      shortcode: parsedUrl.shortcode,
      postLabel,
      createdAt,
      supportsDateRange: false,
      metrics: {
        views,
        reach,
        likes,
        comments,
        shares,
        reposts: null,
      },
    };
  };

  const primaryResult = await fetchForMediaType(parsedUrl.mediaType);

  const primaryMetricCount = primaryResult
    ? countAvailableMetrics(primaryResult.metrics)
    : 0;

  const shouldTryFallback =
    !primaryResult ||
    primaryMetricCount < 2 ||
    primaryResult.createdAt === null;

  if (!shouldTryFallback) {
    return primaryResult;
  }

  const fallbackMediaType: ParsedInstagramUrl['mediaType'] =
    parsedUrl.mediaType === 'reel'
      ? 'p'
      : parsedUrl.mediaType === 'p'
      ? 'reel'
      : 'p';

  if (fallbackMediaType === parsedUrl.mediaType) {
    return primaryResult;
  }

  const fallbackResult = await fetchForMediaType(fallbackMediaType);

  if (!primaryResult) {
    return fallbackResult;
  }

  if (!fallbackResult) {
    return primaryResult;
  }

  return pickMoreCompleteResult(primaryResult, fallbackResult);
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) {
    return dateStr;
  }

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

export default function App() {
  const [postUrl, setPostUrl] = useState('');
  const [status, setStatus] = useState<DashboardStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [analytics, setAnalytics] = useState<FetchedInstagramAnalytics | null>(null);
  const [postCreationDate, setPostCreationDate] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateRangeDataAvailable, setDateRangeDataAvailable] = useState(true);

  const todayDate = useMemo(() => toIsoDate(new Date()), []);

  const isLoading = status === 'loading';
  const isSuccess = status === 'success';
  const hasDateRangeContext = Boolean(postCreationDate);
  const showUnavailableForRange = isSuccess && hasDateRangeContext && !dateRangeDataAvailable;
  const showDataValues = isSuccess && (!hasDateRangeContext || dateRangeDataAvailable);

  const engagement = useMemo(() => {
    if (!analytics) {
      return null;
    }

    const { views, likes, comments, shares } = analytics.metrics;
    if (views === null || views <= 0) {
      return null;
    }

    const totalInteractions = (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
    if (totalInteractions <= 0) {
      return null;
    }

    return Number(((totalInteractions / views) * 100).toFixed(1));
  }, [analytics]);

  const getMetricDisplay = (value: NumericMetric, format: 'number' | 'percent' = 'number'): string => {
    if (isLoading) {
      return 'Loading...';
    }

    if (showUnavailableForRange) {
      return RANGE_UNAVAILABLE_TEXT;
    }

    if (!showDataValues) {
      return UNAVAILABLE_TEXT;
    }

    if (value === null) {
      return UNAVAILABLE_TEXT;
    }

    if (format === 'percent') {
      return `${value.toFixed(1)}%`;
    }

    return formatNumber(value);
  };

  const formatTableMetric = (value: NumericMetric): string => {
    if (value === null) {
      return UNAVAILABLE_TEXT;
    }

    return formatNumber(value);
  };

  const handleFetchAnalytics = async () => {
    const parsedUrl = parseInstagramUrl(postUrl);
    if (!parsedUrl) {
      setStatus('unavailable');
      setStatusMessage('Enter a valid public Instagram post or reel URL.');
      setAnalytics(null);
      setPostCreationDate(null);
      setStartDate('');
      setEndDate('');
      setDateRangeDataAvailable(false);
      return;
    }

    setStatus('loading');
    setStatusMessage('Fetching public post data...');
    setAnalytics(null);
    setPostCreationDate(null);
    setStartDate('');
    setEndDate('');
    setDateRangeDataAvailable(true);

    const fetched = await fetchPublicInstagramAnalytics(parsedUrl);
    const availablePublicMetricLabels = fetched
      ? [
          fetched.metrics.views !== null ? 'views' : null,
          fetched.metrics.reach !== null ? 'reach' : null,
          fetched.metrics.likes !== null ? 'likes' : null,
          fetched.metrics.comments !== null ? 'comments' : null,
          fetched.metrics.shares !== null ? 'shares' : null,
        ].filter((value): value is string => value !== null)
      : [];

    const hasAnyMetric = availablePublicMetricLabels.length > 0;

    if (!fetched || !hasAnyMetric) {
      setStatus('unavailable');
      setStatusMessage('Public metrics are unavailable for this post.');
      setAnalytics(null);
      setPostCreationDate(null);
      setDateRangeDataAvailable(false);
      return;
    }

    setStatus('success');
    setStatusMessage(
      availablePublicMetricLabels.length < 5
        ? `Public metrics loaded (partial): ${availablePublicMetricLabels.join(', ')}.`
        : 'Public metrics loaded.',
    );
    setAnalytics(fetched);
    setPostCreationDate(fetched.createdAt);

    if (fetched.createdAt) {
      setStartDate(fetched.createdAt);
      setEndDate(todayDate);
      setDateRangeDataAvailable(true);
    } else {
      setStartDate('');
      setEndDate('');
      setDateRangeDataAvailable(false);
    }
  };

  const handleApplyDateRange = () => {
    if (!isSuccess || !analytics || !postCreationDate || !startDate || !endDate) {
      setDateRangeDataAvailable(false);
      return;
    }

    if (startDate < postCreationDate || endDate > todayDate || startDate > endDate) {
      setDateRangeDataAvailable(false);
      return;
    }

    if (!analytics.supportsDateRange) {
      const fullLifetimeRange = startDate === postCreationDate && endDate === todayDate;
      setDateRangeDataAvailable(fullLifetimeRange);
      return;
    }

    setDateRangeDataAvailable(true);
  };

  const handleStartDateChange = (nextValue: string) => {
    if (!postCreationDate || !nextValue) {
      return;
    }

    const maxDate = endDate || todayDate;
    const clamped = nextValue < postCreationDate
      ? postCreationDate
      : nextValue > maxDate
      ? maxDate
      : nextValue;

    setStartDate(clamped);
    if (endDate && clamped > endDate) {
      setEndDate(clamped);
    }
  };

  const handleEndDateChange = (nextValue: string) => {
    if (!postCreationDate || !nextValue) {
      return;
    }

    const minDate = startDate || postCreationDate;
    const clamped = nextValue < minDate
      ? minDate
      : nextValue > todayDate
      ? todayDate
      : nextValue;

    setEndDate(clamped);
  };

  const overviewMetrics = [
    { label: 'VIEWS', value: getMetricDisplay(analytics?.metrics.views ?? null) },
    { label: 'REACH', value: getMetricDisplay(analytics?.metrics.reach ?? null) },
    { label: 'ENGAGEMENT', value: getMetricDisplay(engagement, 'percent') },
    { label: 'LIKES', value: getMetricDisplay(analytics?.metrics.likes ?? null) },
    { label: 'SHARES', value: getMetricDisplay(analytics?.metrics.shares ?? null) },
    { label: 'COMMENTS', value: getMetricDisplay(analytics?.metrics.comments ?? null) },
  ];

  const postAnalytics = showDataValues && analytics
    ? [
        {
          post: analytics.postLabel,
          views: formatTableMetric(analytics.metrics.views),
          reach: formatTableMetric(analytics.metrics.reach),
          likes: formatTableMetric(analytics.metrics.likes),
          comments: formatTableMetric(analytics.metrics.comments),
          shares: formatTableMetric(analytics.metrics.shares),
          reposts: formatTableMetric(analytics.metrics.reposts),
        },
      ]
    : [];

  const totalVideoViewsRaw = getMetricDisplay(analytics?.metrics.views ?? null);
  const totalVideoViews = totalVideoViewsRaw.toUpperCase();
  const totalVideoViewsIsNumeric = /^\d/.test(totalVideoViewsRaw);

  const getStatusText = () => {
    if (statusMessage) {
      return statusMessage;
    }

    if (status === 'loading') {
      return 'Fetching public post data...';
    }

    if (status === 'success') {
      return 'Public metrics loaded.';
    }

    if (status === 'unavailable') {
      return 'Unavailable';
    }

    return '';
  };

  return (
    <div className="min-h-screen w-full bg-[#000000] text-[#FFFFFF] p-12">
      <div className="max-w-7xl mx-auto space-y-12">

        {/* SECTION 0: LINK INPUT AREA */}
        <section>
          <div className="border border-[#FFFFFF] p-8">
            <div className="text-xs tracking-widest mb-6 opacity-70">PASTE POST LINK</div>

            <div className="flex gap-4 mb-4">
              <input
                type="text"
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
                placeholder="https://instagram.com/p/..."
                className="flex-1 bg-transparent border border-[#FFFFFF] px-4 py-3 text-sm placeholder:text-[#FFFFFF]/30 focus:outline-none"
              />
              <button
                onClick={handleFetchAnalytics}
                disabled={isLoading}
                className="px-8 py-3 border border-[#FFFFFF] text-xs tracking-widest hover:bg-[#FFFFFF] hover:text-[#000000] transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[#FFFFFF]"
              >
                FETCH ANALYTICS
              </button>
            </div>

            {status !== 'idle' && (
              <div className="text-xs tracking-wide opacity-60">
                {getStatusText()}
              </div>
            )}
          </div>
        </section>

        {/* DATE FILTERING SYSTEM */}
        {isSuccess && (
          <section>
            <div className="border border-[#FFFFFF] p-8">
              <div className="text-xs tracking-widest mb-6 opacity-70">DATE RANGE FILTER</div>

              <div className="mb-4 text-xs opacity-60 tracking-wide">
                {postCreationDate
                  ? `Post created: ${formatDate(postCreationDate)} (minimum selectable date)`
                  : 'Post creation date unavailable. Showing lifetime metrics only.'}
              </div>

              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <div className="text-xs tracking-widest mb-3 opacity-70">START DATE</div>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                    min={postCreationDate ?? undefined}
                    max={endDate || todayDate}
                    disabled={!postCreationDate}
                    className="w-full bg-transparent border border-[#FFFFFF] px-4 py-3 text-sm focus:outline-none disabled:opacity-40"
                  />
                </div>

                <div>
                  <div className="text-xs tracking-widest mb-3 opacity-70">END DATE</div>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => handleEndDateChange(e.target.value)}
                    min={startDate || postCreationDate || undefined}
                    max={todayDate}
                    disabled={!postCreationDate}
                    className="w-full bg-transparent border border-[#FFFFFF] px-4 py-3 text-sm focus:outline-none disabled:opacity-40"
                  />
                </div>
              </div>

              <button
                onClick={handleApplyDateRange}
                disabled={!postCreationDate || !startDate || !endDate}
                className="px-8 py-3 border border-[#FFFFFF] text-xs tracking-widest hover:bg-[#FFFFFF] hover:text-[#000000] transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[#FFFFFF]"
              >
                APPLY DATE RANGE
              </button>
            </div>
          </section>
        )}

        {/* SECTION 1: OVERVIEW METRICS */}
        <section>
          <div className="grid grid-cols-6 gap-6">
            {overviewMetrics.map((metric) => {
              const showCompactText =
                metric.value === UNAVAILABLE_TEXT ||
                metric.value === RANGE_UNAVAILABLE_TEXT ||
                metric.value === 'Loading...';

              return (
                <div key={metric.label} className="border border-[#FFFFFF] p-8 flex flex-col items-center justify-center">
                  {showCompactText ? (
                    <div className="text-xs opacity-60 text-center min-h-[48px] flex items-center">
                      {metric.value}
                    </div>
                  ) : (
                    <div className="text-4xl mb-3">{metric.value}</div>
                  )}
                  <div className="text-xs tracking-widest opacity-70">{metric.label}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* SECTION 2: TOTAL VIDEO VIEWS */}
        <section>
          <div className="border border-[#FFFFFF] p-12 text-center">
            <div className="text-xs tracking-widest mb-6 opacity-70">TOTAL VIDEO VIEWS</div>
            {totalVideoViewsIsNumeric ? (
              <div className="text-7xl">{totalVideoViewsRaw}</div>
            ) : (
              <div className="text-2xl tracking-widest opacity-60">
                {totalVideoViews}
              </div>
            )}
          </div>
        </section>

        {/* SECTION 3: POST ANALYTICS BREAKDOWN */}
        <section>
          <div className="border border-[#FFFFFF] p-8">
            <div className="text-xs tracking-widest mb-8 opacity-70">POST ANALYTICS</div>

            {showDataValues ? (
              <>
                {/* Table Header */}
                <div className="grid grid-cols-7 gap-6 pb-4 border-b border-[#FFFFFF] mb-4">
                  <div className="text-xs tracking-widest opacity-70">POST</div>
                  <div className="text-xs tracking-widest opacity-70">VIEWS</div>
                  <div className="text-xs tracking-widest opacity-70">REACH</div>
                  <div className="text-xs tracking-widest opacity-70">LIKES</div>
                  <div className="text-xs tracking-widest opacity-70">COMMENTS</div>
                  <div className="text-xs tracking-widest opacity-70">SHARES</div>
                  <div className="text-xs tracking-widest opacity-70">REPOSTS</div>
                </div>

                {/* Table Rows */}
                {postAnalytics.map((post, index) => (
                  <div
                    key={`${analytics?.shortcode || 'post'}-${index}`}
                    className={`grid grid-cols-7 gap-6 py-4 ${index !== postAnalytics.length - 1 ? 'border-b border-[#FFFFFF]/20' : ''}`}
                  >
                    <div className="text-sm">{post.post}</div>
                    <div className="text-sm">{post.views}</div>
                    <div className="text-sm">{post.reach}</div>
                    <div className="text-sm">{post.likes}</div>
                    <div className="text-sm">{post.comments}</div>
                    <div className="text-sm">{post.shares}</div>
                    <div className="text-sm">{post.reposts}</div>
                  </div>
                ))}
              </>
            ) : (
              <div className="text-center py-12 text-sm opacity-60 tracking-wide">
                {isLoading
                  ? 'Fetching public post data...'
                  : showUnavailableForRange
                  ? RANGE_UNAVAILABLE_TEXT
                  : 'Data unavailable'}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
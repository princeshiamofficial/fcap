const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

function cleanCaption(text) {
  if (!text) return '';
  return text
    .replace(/^\d+[KkMm]?\s*views?\s*·\s*\d+\s*reactions?\s*\|\s*/i, '')
    .replace(/^\d+\s*views?\s*·\s*\d+\s*reactions?\s*\|\s*/i, '')
    .replace(/\s*See more$/i, '')
    .replace(/\s*See less$/i, '')
    .replace(/^—\s*/, '')
    .replace(/\s*·\s*\d+\s*(likes?|comments?|shares?).*$/i, '')
    .trim();
}

function extractFromMetaTags($) {
  const result = {};

  // og:description - usually the full caption
  const ogDesc = $('meta[property="og:description"]').attr('content');
  if (ogDesc) result.description = cleanCaption(ogDesc);

  // og:title
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) result.title = cleanCaption(ogTitle);

  // og:type
  const ogType = $('meta[property="og:type"]').attr('content');
  if (ogType) result.type = ogType;

  // og:url
  const ogUrl = $('meta[property="og:url"]').attr('content');
  if (ogUrl) result.canonicalUrl = ogUrl;

  // video:duration
  const duration = $('meta[property="video:duration"]').attr('content');
  if (duration) result.duration = parseInt(duration);

  // og:video
  const ogVideo = $('meta[property="og:video"]').attr('content');
  if (ogVideo) result.videoUrl = ogVideo;

  // og:image
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) result.thumbnail = ogImage;

  return result;
}

function extractFromHTML($, meta) {
  // Try to find the description from HTML elements
  const selectors = [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-testid="post_message"]',
    '[data-testid="postMessage"]',
  ];

  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 0) {
        return cleanCaption(text);
      }
    }
  }

  return null;
}

function extractFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse($(script).html());
      if (data.description) return cleanCaption(data.description);
      if (data.name) return cleanCaption(data.name);
    } catch {}
  }
  return null;
}

function extractFromScriptData($) {
  // Facebook embeds data in script tags with specific patterns
  const scripts = $('script:not([src])');
  for (const script of scripts) {
    const html = $(script).html() || '';

    // Look for "message" or "description" fields in JSON-like structures
    const messageMatch = html.match(/"message"\s*:\s*"([^"]{20,})"/);
    if (messageMatch) {
      try {
        const decoded = messageMatch[1]
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\\n/g, '\n')
          .replace(/\\u200c/g, '')
          .replace(/\\"/g, '"');
        return cleanCaption(decoded);
      } catch {}
    }

    const descMatch = html.match(/"description"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{20,})"/);
    if (descMatch) {
      return cleanCaption(descMatch[1]);
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      error: 'Missing "url" query parameter',
      usage: 'GET /api/extract?url=https://www.facebook.com/reel/123456'
    });
  }

  // Validate URL
  const isFacebook = url.match(/facebook\.com|fb\.watch|fb\.com/i);
  const isTiktok = url.match(/tiktok\.com/i);
  if (!isFacebook && !isTiktok) {
    return res.status(400).json({
      error: 'Invalid URL. Must be a Facebook (facebook.com, fb.watch) or TikTok (tiktok.com) URL'
    });
  }

  try {
    // TikTok — use oEmbed API (only reliable server-side method)
    if (isTiktok) {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
      const oembedRes = await fetch(oembedUrl);
      if (!oembedRes.ok) {
        return res.status(502).json({ error: `Failed to fetch TikTok oEmbed (${oembedRes.status})`, url });
      }
      const oembed = await oembedRes.json();
      return res.status(200).json({
        url: url,
        description: cleanCaption(oembed.title) || null,
        title: oembed.author_name || null,
        type: 'video',
        thumbnail: oembed.thumbnail_url || null,
        author: oembed.author_name || null,
        authorUrl: oembed.author_url || null,
        extractedAt: new Date().toISOString(),
      });
    }

    // Facebook — convert to m.facebook.com for better server-side access
    let fetchUrl = url;
    if (url.includes('www.facebook.com')) {
      fetchUrl = url.replace('www.facebook.com', 'm.facebook.com');
    } else if (url.includes('facebook.com') && !url.includes('m.facebook.com')) {
      fetchUrl = url.replace('facebook.com', 'm.facebook.com');
    }
    const response = await fetch(fetchUrl, {
      headers: HEADERS,
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Failed to fetch Facebook page (${response.status})`,
        url: url
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract from multiple sources
    const meta = extractFromMetaTags($);
    const htmlDesc = extractFromHTML($, meta);
    const jsonLdDesc = extractFromJsonLd($);
    const scriptDesc = extractFromScriptData($);

    // Pick the best description — prefer the longest text available
    const candidates = [htmlDesc, jsonLdDesc, scriptDesc, meta.description, meta.title].filter(Boolean);
    const description = candidates.sort((a, b) => b.length - a.length)[0] || '';

    // Title is the shorter meta title, cleaned of view/reaction counts
    let title = null;
    if (meta.title && meta.title !== description) {
      title = meta.title
        .replace(/^\d+[KkMm]?\s*views?\s*·\s*\d+\s*reactions?\s*\|\s*/i, '')
        .replace(/^\d+\s*views?\s*·\s*\d+\s*reactions?\s*\|\s*/i, '')
        .trim();
      if (!title) title = null;
    }

    const result = {
      url: url,
      description: description || null,
      title: title,
      type: meta.type || null,
      duration: meta.duration || null,
      videoUrl: meta.videoUrl || null,
      thumbnail: meta.thumbnail || null,
      extractedAt: new Date().toISOString(),
    };

    if (!description) {
      result._debug = {
        note: 'Could not extract description. Facebook may require authentication or use client-side rendering.',
        metaDescription: meta.description || null,
        htmlFound: !!htmlDesc,
        jsonLdFound: !!jsonLdDesc,
        scriptFound: !!scriptDesc,
      };
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({
      error: 'Internal error',
      message: err.message
    });
  }
};

const cheerio = require('cheerio');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8231783567:AAGUCBS3lXbDvTUWpIMnjRL41iXb3JROnlA';
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

async function extractCaption(url) {
  // TikTok — resolve short URLs, then use oEmbed
  if (url.match(/tiktok\.com/i)) {
    let resolvedUrl = url;
    if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) {
      const resolveRes = await fetch(url, { redirect: 'follow' });
      if (resolveRes.ok) resolvedUrl = resolveRes.url;
    }
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(resolvedUrl)}`;
    const oembedRes = await fetch(oembedUrl);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      if (oembed.title) return cleanCaption(oembed.title);
    }
    // Fallback: extract from HTML (for photo posts)
    const htmlRes = await fetch(resolvedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const $ = cheerio.load(html);
      // Try UNIVERSAL_DATA for desc field
      const descMatch = html.match(/"desc"\s*:\s*"([^"]{5,})"/);
      if (descMatch) {
        try {
          const desc = descMatch[1]
            .replace(/\\u[\dA-Fa-f]{4}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)))
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"');
          return cleanCaption(desc);
        } catch {}
      }
      const title = $('title').text().trim();
      if (title) return title;
    }
    return null;
  }

  // Facebook
  let fetchUrl = url;
  if (url.includes('www.facebook.com')) {
    fetchUrl = url.replace('www.facebook.com', 'm.facebook.com');
  } else if (url.includes('facebook.com') && !url.includes('m.facebook.com')) {
    fetchUrl = url.replace('facebook.com', 'm.facebook.com');
  }

  const response = await fetch(fetchUrl, { headers: HEADERS, redirect: 'follow' });
  if (!response.ok) return null;

  const html = await response.text();
  const $ = cheerio.load(html);

  const ogDesc = $('meta[property="og:description"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content');

  const candidates = [ogDesc, ogTitle].filter(Boolean);
  const description = candidates.sort((a, b) => b.length - a.length)[0];
  return description ? cleanCaption(description) : null;
}

async function sendMessage(chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function extractUrl(text) {
  const urlRegex = /https?:\/\/(www\.|m\.|mbasic\.|vm\.)?(facebook\.com|fb\.watch|fb\.com|tiktok\.com)\/\S+/gi;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;

    // Handle messages
    const message = update.message || update.channel_post;
    if (!message || !message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const msgId = message.message_id;

    // /start command
    if (text === '/start') {
      await sendMessage(chatId,
        `🟢 <b>Caption Extractor Bot</b>\n\n` +
        `Send me a Facebook or TikTok link and I'll extract the description for you.\n\n` +
        `Examples:\n` +
        `<code>https://www.facebook.com/reel/123456</code>\n` +
        `<code>https://www.tiktok.com/@user/video/123</code>`,
        msgId
      );
      return res.status(200).json({ ok: true });
    }

    // /help command
    if (text === '/help') {
      await sendMessage(chatId,
        `Just send any Facebook or TikTok URL (reel, video, post) and I'll reply with the full caption/description.`,
        msgId
      );
      return res.status(200).json({ ok: true });
    }

    // Check for URL
    const url = extractUrl(text);
    if (!url) {
      await sendMessage(chatId, '⚠️ Please send a valid Facebook or TikTok URL.', msgId);
      return res.status(200).json({ ok: true });
    }

    // Extract caption
    await sendMessage(chatId, '⏳ Extracting caption...', msgId);

    const caption = await extractCaption(url);

    if (caption) {
      const response = `📝 <b>Caption:</b>\n\n${caption}`;
      // Telegram has a 4096 char limit per message
      if (response.length > 4096) {
        // Split into chunks
        const chunks = [];
        let remaining = caption;
        while (remaining.length > 0) {
          chunks.push(remaining.substring(0, 3900));
          remaining = remaining.substring(3900);
        }
        for (let i = 0; i < chunks.length; i++) {
          const prefix = i === 0 ? '📝 <b>Caption:</b>\n\n' : `(continued ${i + 1}/${chunks.length})\n\n`;
          await sendMessage(chatId, prefix + chunks[i], i === 0 ? msgId : undefined);
        }
      } else {
        await sendMessage(chatId, response, msgId);
      }
    } else {
      await sendMessage(chatId, '❌ Could not extract caption. The post may be private or the URL is invalid.', msgId);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Telegram webhook error:', err);
    return res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};

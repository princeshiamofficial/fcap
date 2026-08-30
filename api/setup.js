const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8231783567:AAGUCBS3lXbDvTUWpIMnjRL41iXb3JROnlA';

module.exports = async function handler(req, res) {
  // Get the deployment URL from Vercel
  const host = req.headers.host || 'fcap-omega.vercel.app';
  const webhookUrl = `https://${host}/api/telegram`;

  try {
    // Set webhook with Telegram
    const result = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`,
      { method: 'GET' }
    );
    const data = await result.json();

    return res.status(200).json({
      success: true,
      webhookUrl,
      telegramResponse: data,
      message: data.ok
        ? 'Webhook set successfully! Send a Facebook link to your bot on Telegram.'
        : 'Failed to set webhook. Check bot token.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

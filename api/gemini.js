module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const model = req.query.model || 'gemini-2.5-flash';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'API Key belum dikonfigurasi di Vercel' });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(req.body),
      }
    );

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({ 
        error: errData.error?.message || `Google API Error: ${response.statusText}` 
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    const data = await response.text();
    return res.status(200).send(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

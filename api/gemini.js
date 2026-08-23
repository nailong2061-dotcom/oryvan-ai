const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

const DEFAULT_SYSTEM_PROMPT =
  'Kamu adalah FaDa, asisten AI canggih yang terstruktur, jujur tentang ketidakpastian, dan berorientasi solusi. Jawab dalam Bahasa Indonesia kecuali pengguna meminta bahasa lain.';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 40;
const MAX_TEXT_LENGTH = 20000;
const MAX_PREFERENCE_LENGTH = 2000;
const MAX_PARTS_PER_MESSAGE = 12;
const MAX_INLINE_DATA_BYTES = 2 * 1024 * 1024;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

const rateBuckets = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({
    error: {
      message
    }
  });
}

function estimateBase64Bytes(value = '') {
  if (typeof value !== 'string') return 0;

  const clean = value.replace(/\s/g, '');

  return Math.floor(clean.length * 0.75);
}

function sanitizeContents(contents) {
  if (!Array.isArray(contents)) {
    throw new Error('Format percakapan tidak valid.');
  }

  if (contents.length > MAX_HISTORY_MESSAGES) {
    throw new Error(
      `Percakapan terlalu panjang. Maksimal ${MAX_HISTORY_MESSAGES} pesan per permintaan.`
    );
  }

  return contents.map((message) => {
    const role = message?.role === 'model' ? 'model' : 'user';

    const sourceParts = Array.isArray(message?.parts)
      ? message.parts
      : [];

    if (sourceParts.length > MAX_PARTS_PER_MESSAGE) {
      throw new Error('Terlalu banyak bagian dalam satu pesan.');
    }

    const parts = sourceParts.map((part) => {
      if (typeof part?.text === 'string') {
        return {
          text: part.text.slice(0, MAX_TEXT_LENGTH)
        };
      }

      const inline = part?.inline_data;

      if (
        inline &&
        typeof inline.data === 'string' &&
        typeof inline.mime_type === 'string'
      ) {
        const size = estimateBase64Bytes(inline.data);

        if (size > MAX_INLINE_DATA_BYTES) {
          throw new Error('Lampiran terlalu besar untuk backend.');
        }

        const mime = inline.mime_type.toLowerCase();

        const allowedMime =
          mime.startsWith('image/') ||
          mime === 'application/pdf' ||
          mime.startsWith('text/');

        if (!allowedMime) {
          throw new Error('Tipe lampiran tidak didukung.');
        }

        return {
          inline_data: {
            mime_type: mime,
            data: inline.data
          }
        };
      }

      throw new Error('Bagian pesan tidak valid.');
    });

    return {
      role,
      parts
    };
  });
}

function isSameOrigin(req) {
  const origin = req.headers?.origin;

  if (!origin) {
    return false;
  }

  try {
    const originUrl = new URL(origin);

    const host = String(
      req.headers?.host || ''
    )
      .split(':')[0]
      .toLowerCase();

    return originUrl.hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

function getClientKey(req) {
  const forwarded = String(
    req.headers?.['x-forwarded-for'] || ''
  );

  return (
    forwarded.split(',')[0].trim() ||
    'unknown'
  );
}

function checkRateLimit(req) {
  const now = Date.now();
  const key = getClientKey(req);

  const bucket = rateBuckets.get(key);

  if (
    !bucket ||
    now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS
  ) {
    rateBuckets.set(key, {
      startedAt: now,
      count: 1
    });

    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return false;
  }

  bucket.count += 1;

  return true;
}

function buildSystemInstruction(userPreference) {
  const preference =
    typeof userPreference === 'string'
      ? userPreference.trim().slice(
          0,
          MAX_PREFERENCE_LENGTH
        )
      : '';

  if (
    !preference ||
    preference === DEFAULT_SYSTEM_PROMPT
  ) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  return `${DEFAULT_SYSTEM_PROMPT}

Preferensi pengguna (boleh diikuti selama tidak bertentangan dengan aturan utama):
${preference}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return jsonError(
      res,
      405,
      'Method tidak diizinkan.'
    );
  }

  if (!isSameOrigin(req)) {
    return jsonError(
      res,
      403,
      'Permintaan harus berasal dari aplikasi FaDa AI.'
    );
  }

  if (!checkRateLimit(req)) {
    res.setHeader('Retry-After', '60');

    return jsonError(
      res,
      429,
      'Terlalu banyak permintaan. Coba lagi sebentar.'
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return jsonError(
      res,
      500,
      'GEMINI_API_KEY belum dikonfigurasi di environment Vercel.'
    );
  }

  try {
    const rawBody = JSON.stringify(
      req.body ?? {}
    );

    if (
      Buffer.byteLength(rawBody, 'utf8') >
      MAX_JSON_BYTES
    ) {
      return jsonError(
        res,
        413,
        'Permintaan terlalu besar. Kurangi ukuran lampiran.'
      );
    }

    const {
      model,
      contents,
      useSearch,
      userPreference
    } = req.body || {};

    const selectedModel =
      ALLOWED_MODELS.has(model)
        ? model
        : 'gemini-3.6-flash';

    const safeContents =
      sanitizeContents(contents);

    if (!safeContents.length) {
      return jsonError(
        res,
        400,
        'Percakapan kosong.'
      );
    }

    const body = {
      system_instruction: {
        parts: [
          {
            text: buildSystemInstruction(
              userPreference
            )
          }
        ]
      },

      contents: safeContents
    };

    if (useSearch === true) {
      body.tools = [
        {
          google_search: {}
        }
      ];
    }

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        selectedModel
      )}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },

        body: JSON.stringify(body)
      }
    );

    if (!upstream.ok) {
      const text = await upstream.text();

      let message =
        `Gemini API HTTP ${upstream.status}`;

      try {
        const data = JSON.parse(text);

        message =
          data?.error?.message ||
          message;
      } catch {
        if (text) {
          message = text.slice(0, 500);
        }
      }

      return jsonError(
        res,
        upstream.status >= 500
          ? 502
          : upstream.status,
        message
      );
    }

    if (!upstream.body) {
      return jsonError(
        res,
        502,
        'Gemini tidak mengembalikan stream.'
      );
    }

    res.statusCode = 200;

    res.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );

    res.setHeader(
      'Connection',
      'keep-alive'
    );

    res.setHeader(
      'X-Accel-Buffering',
      'no'
    );

    const reader =
      upstream.body.getReader();

    const decoder =
      new TextDecoder();

    try {
      while (true) {
        const {
          done,
          value
        } = await reader.read();

        if (done) {
          break;
        }

        const chunk =
          decoder.decode(value, {
            stream: true
          });

        if (chunk) {
          res.write(chunk);
        }
      }

      const finalChunk =
        decoder.decode();

      if (finalChunk) {
        res.write(finalChunk);
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
  } catch (error) {
    console.error(
      'FaDa API error:',
      error
    );

    if (!res.headersSent) {
      return jsonError(
        res,
        500,
        error?.message ||
          'Terjadi kesalahan pada backend.'
      );
    }

    res.end();
  }
            }

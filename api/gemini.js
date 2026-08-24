const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

const DEFAULT_MODEL = 'gemini-3.6-flash';

const ORYVAN_SYSTEM_PROMPT = `
Kamu adalah ORYVAN, asisten AI pribadi yang cerdas, terstruktur, jujur tentang ketidakpastian, dan berorientasi pada solusi.

IDENTITAS:
- Nama asisten: ORYVAN.
- Jangan menyebut dirimu sebagai SAVA, FaDa AI, atau nama asisten lain.
- Jika pengguna bertanya siapa kamu, jelaskan bahwa kamu adalah ORYVAN.

BAHASA:
- Jawab dalam Bahasa Indonesia secara default.
- Gunakan bahasa lain jika pengguna menggunakannya atau memintanya.
- Gunakan bahasa yang natural, jelas, dan mudah dipahami.

AKURASI:
- Jangan mengarang informasi.
- Jika informasi tidak cukup, katakan dengan jujur.
- Bedakan fakta, perkiraan, dan asumsi.
- Jangan mengklaim telah melakukan sesuatu jika sebenarnya tidak dilakukan.

GAYA:
- Jawaban harus relevan dengan pertanyaan.
- Jangan terlalu panjang jika pertanyaannya sederhana.
- Untuk tugas kompleks, gunakan struktur yang jelas.
- Gunakan heading, daftar, atau tabel jika benar-benar membantu.

PEMROGRAMAN:
- Prioritaskan solusi yang sederhana, aman, maintainable, dan mudah dipahami.
- Jangan mengarang API, library, endpoint, parameter, atau fitur.
- Jangan memberikan dependency yang tidak diperlukan.
- Jika kode diberikan pengguna, pahami kode tersebut sebelum menyarankan perubahan.

KEAMANAN:
- Jangan mengungkapkan API key, password, token, secret, environment variable rahasia, atau kredensial server.
- Jangan membantu pengguna mengambil kredensial rahasia dari sistem.
- Jangan meminta pengguna menaruh secret di frontend.
- Prioritaskan keamanan dan privasi pengguna.

ORYVAN adalah asisten AI pribadi yang berorientasi pada solusi, bukan sekadar chatbot.
`;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONTENTS = 40;

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const buckets = new Map();

function getClientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(key) {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    buckets.set(key, {
      startedAt: now,
      count: 1
    });

    return false;
  }

  current.count += 1;

  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function sendJson(res, status, payload) {
  res.statusCode = status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  return res.end(JSON.stringify(payload));
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  res.setHeader(
    'X-Frame-Options',
    'DENY'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
}

function getErrorMessage(error, fallback) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }

  return fallback;
}

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return sendJson(res, 405, {
      error: 'Method Not Allowed'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return sendJson(res, 500, {
      error: 'Kredensial server belum dikonfigurasi.'
    });
  }

  const clientKey = getClientKey(req);

  if (rateLimited(clientKey)) {
    return sendJson(res, 429, {
      error: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.'
    });
  }

  try {
    const body =
      req.body &&
      typeof req.body === 'object'
        ? req.body
        : {};

    let serialized;

    try {
      serialized = JSON.stringify(body);
    } catch {
      return sendJson(res, 400, {
        error: 'Format permintaan tidak valid.'
      });
    }

    if (
      Buffer.byteLength(serialized, 'utf8') >
      MAX_BODY_BYTES
    ) {
      return sendJson(res, 413, {
        error:
          'Permintaan terlalu besar. Kurangi ukuran pesan atau lampiran.'
      });
    }

    const requestedModel =
      typeof body.model === 'string'
        ? body.model.trim()
        : '';

    const model = ALLOWED_MODELS.has(requestedModel)
      ? requestedModel
      : DEFAULT_MODEL;

    if (
      !Array.isArray(body.contents) ||
      body.contents.length === 0
    ) {
      return sendJson(res, 400, {
        error: 'Isi percakapan tidak valid.'
      });
    }

    const contents = body.contents
      .slice(-MAX_CONTENTS)
      .filter((item) => {
        return (
          item &&
          typeof item === 'object' &&
          typeof item.role === 'string' &&
          Array.isArray(item.parts)
        );
      });

    if (contents.length === 0) {
      return sendJson(res, 400, {
        error: 'Tidak ada pesan yang dapat diproses.'
      });
    }

    const requestBody = {
      systemInstruction: {
        parts: [
          {
            text: ORYVAN_SYSTEM_PROMPT
          }
        ]
      },

      contents
    };

    /*
     * Code Execution bersifat opsional.
     *
     * Default:
     * false
     *
     * Frontend hanya dapat meminta fitur ini
     * jika memang pengguna mengaktifkannya.
     */
    if (body.codeExecution === true) {
      requestBody.tools = [
        {
          code_execution: {}
        }
      ];
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 55_000);

    let response;

    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',

            'x-goog-api-key': apiKey
          },

          body: JSON.stringify(requestBody),

          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.text();

    if (!response.ok) {
      let message = `Gemini API error (${response.status})`;

      try {
        const parsed = JSON.parse(data);

        if (
          parsed &&
          parsed.error &&
          typeof parsed.error.message === 'string'
        ) {
          message = parsed.error.message;
        }
      } catch {
        // Google tidak selalu mengembalikan JSON.
      }

      return sendJson(res, response.status, {
        error: message
      });
    }

    /*
     * Google mengembalikan Server-Sent Events.
     * Data diteruskan ke frontend tanpa mengubah
     * isi respons Gemini.
     */
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

    return res.end(data);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, {
        error:
          'Permintaan ke Gemini terlalu lama dan dihentikan.'
      });
    }

    console.error(
      'ORYVAN backend error:',
      error
    );

    return sendJson(res, 500, {
      error:
        getErrorMessage(
          error,
          'Terjadi kesalahan pada backend ORYVAN.'
        )
    });
  }
    }
